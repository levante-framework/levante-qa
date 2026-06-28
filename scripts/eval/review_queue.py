#!/usr/bin/env python3
"""
Tiered advisory review queue for approved translations.

Turns the validated stack into a ranked work list the translation team can act on,
spending API budget only where it matters:

  Tier 1 (cheap, runs on EVERYTHING): E5 direct cosine + COMET-QE -> adequacy flag.
  Tier 2 (MQM, runs only on the flagged tail, capped): -> appropriateness flag.

Flag thresholds come from scoring-config.json (see calibrate_thresholds.py). Each
row gets a tier:
  likely_bad : both adequacy and appropriateness flagged
  review     : exactly one axis flagged
  ok         : neither

Output is sorted worst-first. Tier 2 only sees Tier-1-flagged items, so an
appropriateness-only problem in an otherwise faithful translation can be missed;
raise --mqm-sample to also MQM a random slice of the un-flagged rows if you want
broader appropriateness coverage.

    python review_queue.py --from-crowdin --locales es-AR --max-mqm 300
    python review_queue.py --input-csv output/crowdin-approved.csv --locales es-AR,de \
        --tier1-only           # free pass, adequacy ranking only
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from pathlib import Path
from typing import Dict, List, Optional

from envload import load_env

FIXED_COLS = {"identifier", "item_id", "labels", "contentType", "_path", "en"}
OUT_COLS = ["tier", "priority", "item_id", "locale", "contentType", "source_en", "translation",
            "e5_direct", "comet", "adequacy_flag", "mqm_score", "mqm_major",
            "appropriateness_flag", "reasons"]


def load_rows(args) -> tuple[List[dict], List[str]]:
    if args.from_crowdin:
        from crowdin_source import fetch_approved_rows
        return fetch_approved_rows(approved_only=not args.include_unapproved)
    path = Path(args.input_csv)
    if not path.is_file():
        sys.exit(f"--input-csv not found: {path}")
    with path.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    langs = sorted({h for r in rows for h in r.keys()} - FIXED_COLS) if rows else []
    return rows, [l for l in langs if l]


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Tiered advisory translation review queue.")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--from-crowdin", action="store_true")
    src.add_argument("--input-csv")
    p.add_argument("--include-unapproved", action="store_true")
    p.add_argument("--locales", required=True, help="Comma-separated target locales.")
    p.add_argument("--config", default="output/scoring-config.json")
    p.add_argument("--tier1-only", action="store_true", help="Skip MQM (free adequacy pass).")
    p.add_argument("--max-mqm", type=int, default=300, help="Cap MQM calls (Tier 2 budget).")
    p.add_argument("--mqm-sample", type=int, default=0,
                   help="Also MQM this many random non-flagged rows (appropriateness coverage).")
    p.add_argument("--limit", type=int, default=0, help="Cap candidates (debug).")
    p.add_argument("--seed", type=int, default=20260627)
    p.add_argument("--output", default="output/review-queue.csv")
    args = p.parse_args()

    cfg = json.loads(Path(args.config).read_text(encoding="utf-8")) if Path(args.config).is_file() else {}
    t_e5 = (cfg.get("adequacy", {}).get("e5_direct_sim") or {}).get("threshold")
    t_comet = (cfg.get("adequacy", {}).get("comet_qe") or {}).get("threshold")
    t_mqm = (cfg.get("appropriateness", {}).get("mqm_score") or {}).get("threshold")
    if t_e5 is None or t_comet is None:
        sys.exit(f"No adequacy thresholds in {args.config}; run calibrate_thresholds.py first.")

    locales = [l.strip() for l in args.locales.split(",") if l.strip()]
    rows, _ = load_rows(args)
    cands: List[dict] = []
    for row in rows:
        src_en = (row.get("en") or "").strip()
        if not src_en:
            continue
        for loc in locales:
            tgt = (row.get(loc) or "").strip()
            if tgt:
                cands.append({"item_id": row.get("item_id", ""), "locale": loc,
                              "contentType": row.get("contentType", ""), "source_en": src_en,
                              "translation": tgt})
    if args.limit:
        cands = cands[:args.limit]
    if not cands:
        sys.exit("No candidates for the requested locales.")
    print(f"[queue] {len(cands)} candidate segments.")

    # Tier 1: cheap adequacy on everything.
    from embedding_eval import EmbeddingEvaluator
    emb = EmbeddingEvaluator()
    e5 = [float(x) for x in emb.evaluate_batch([c["source_en"] for c in cands], [c["translation"] for c in cands])]
    from comet_eval import CometQEEvaluator
    comet = [float(x) for x in CometQEEvaluator().evaluate_batch([c["source_en"] for c in cands], [c["translation"] for c in cands])]
    for c, a, b in zip(cands, e5, comet):
        c["e5_direct"] = round(a, 4)
        c["comet"] = round(b, 4)
        c["adequacy_flag"] = 1 if (a < t_e5 or b < t_comet) else 0
        c["mqm_score"] = ""
        c["mqm_major"] = ""
        c["appropriateness_flag"] = ""

    # Tier 2: MQM on the flagged tail (+ optional random sample), capped.
    if not args.tier1_only and t_mqm is not None:
        rng = random.Random(args.seed)
        flagged = [c for c in cands if c["adequacy_flag"] == 1]
        flagged.sort(key=lambda c: min(c["e5_direct"], c["comet"]))  # worst adequacy first
        to_mqm = flagged[:args.max_mqm]
        if args.mqm_sample:
            pool = [c for c in cands if c["adequacy_flag"] == 0]
            to_mqm += rng.sample(pool, min(args.mqm_sample, len(pool)))
        print(f"[queue] Tier 2: MQM on {len(to_mqm)} rows (cap {args.max_mqm}).")
        from llm_mqm_eval import LlmMqmEvaluator
        from tqdm import tqdm
        ev = LlmMqmEvaluator()
        for c in tqdm(to_mqm, desc="MQM"):
            res = ev.evaluate_single(c["source_en"], c["translation"], c["locale"])
            if not res["ok"]:
                continue
            major = sum(1 for e in res["errors"] if e["severity"] in ("major", "critical"))
            c["mqm_score"] = round(float(res["score"]), 2)
            c["mqm_major"] = major
            c["appropriateness_flag"] = 1 if (res["score"] < t_mqm or major >= 1) else 0

    # Tier + priority + reasons.
    for c in cands:
        adq = c["adequacy_flag"] == 1
        app = c["appropriateness_flag"] == 1
        c["tier"] = "likely_bad" if (adq and app) else ("review" if (adq or app) else "ok")
        reasons = []
        if c["e5_direct"] < t_e5:
            reasons.append("low_e5")
        if c["comet"] < t_comet:
            reasons.append("low_comet")
        if app:
            reasons.append("mqm_appropriateness")
        c["reasons"] = ";".join(reasons)
        # worse adequacy = higher priority; appropriateness adds weight.
        adq_sev = 2 - (min(c["e5_direct"], c["comet"]))  # ~ higher when scores low
        c["priority"] = round(adq_sev + (1.0 if app else 0.0) + (0.5 if adq else 0.0), 4)

    rank = {"likely_bad": 0, "review": 1, "ok": 2}
    cands.sort(key=lambda c: (rank[c["tier"]], -c["priority"]))

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=OUT_COLS, extrasaction="ignore")
        w.writeheader()
        w.writerows(cands)

    tiers = {"likely_bad": 0, "review": 0, "ok": 0}
    for c in cands:
        tiers[c["tier"]] += 1
    print(f"[done] {len(cands)} rows -> {out}")
    print(f"       likely_bad={tiers['likely_bad']}, review={tiers['review']}, ok={tiers['ok']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
