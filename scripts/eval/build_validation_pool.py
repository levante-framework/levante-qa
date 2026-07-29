#!/usr/bin/env python3
"""
Build a v2 validation pool for human labeling (see VALIDATION_SET_PLAN.md).

Two strata, combined and shuffled so annotators stay blind:
  * backbone  (~70%): stratified UNIFORM RANDOM over locale x contentType x length
                      bucket -> an unbiased base rate, anchored to no method.
  * enrich    (~30%): EVALUATOR DISAGREEMENT -> hard cases without favoring any one
                      score. Disagreement = spread of z-scored cheap signals
                      (E5 direct sim, E5 same-item centroid sim, optional COMET-QE).

Outputs (to --output-dir):
  * blind/<locale>.csv + blind/combined.csv  -> annotator files: inputs + EMPTY
        label columns (adequacy, appropriateness, mqm_errors, overall_verdict,
        rater_id, notes). NO automatic scores (blind by design).
  * provenance.csv                           -> stratum + raw signals per row, kept
        SEPARATE so analysis can use them without anchoring the annotators.

Source pool comes from the live translation source (see translation_source.py):
the draft bucket JSON by default, or the Crowdin API directly with --from-crowdin.
Examples:
  .venv/bin/python build_validation_pool.py \
      --locales es-AR,es-CO,de-DE,nl-NL,fr-CA --backbone 560 --enrich 240
  .venv/bin/python build_validation_pool.py --from-crowdin \
      --locales es-AR --backbone 70 --enrich 30 --no-enrich-signals
"""

from __future__ import annotations

import argparse
import csv
import random
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Sequence

from envload import load_env

FIXED_COLS = {"identifier", "item_id", "labels", "contentType", "_path", "en"}
LABEL_COLS = ["adequacy", "appropriateness", "mqm_errors", "overall_verdict", "rater_id", "notes"]
INPUT_COLS = ["item_id", "identifier", "locale", "source_en", "translation", "contentType", "length_bucket"]


def length_bucket(text: str) -> str:
    n = len((text or "").split())
    if n <= 5:
        return "short"
    if n < 20:
        return "medium"
    return "long"


def load_rows(args) -> tuple[List[dict], List[str]]:
    from translation_source import fetch_rows

    source = getattr(args, "source", None) or ("crowdin" if getattr(args, "from_crowdin", False) else None)
    return fetch_rows(source=source)


def build_candidates(rows: Sequence[dict], locales: Sequence[str]) -> List[dict]:
    cands: List[dict] = []
    for row in rows:
        src = (row.get("en") or "").strip()
        if not src:
            continue
        for loc in locales:
            tgt = (row.get(loc) or "").strip()
            if not tgt:
                continue
            cands.append({
                "item_id": row.get("item_id", ""),
                "identifier": row.get("identifier", ""),
                "locale": loc,
                "source_en": src,
                "translation": tgt,
                "contentType": row.get("contentType", "") or "general",
                "length_bucket": length_bucket(src),
                "_row": row,  # kept for centroid; stripped before write
            })
    return cands


def stratified_sample(cands: List[dict], n: int, rng: random.Random) -> List[dict]:
    """Uniform random within locale x contentType x length strata, allocated
    proportionally (largest-remainder), then random fill for any rounding gap."""
    if n >= len(cands):
        return list(cands)
    strata: Dict[tuple, List[dict]] = defaultdict(list)
    for c in cands:
        strata[(c["locale"], c["contentType"], c["length_bucket"])].append(c)
    total = len(cands)
    alloc: Dict[tuple, int] = {}
    remainders = []
    assigned = 0
    for key, items in strata.items():
        exact = n * len(items) / total
        base = int(exact)
        base = min(base, len(items))
        alloc[key] = base
        assigned += base
        remainders.append((exact - int(exact), key))
    remainders.sort(reverse=True)
    i = 0
    while assigned < n and remainders:
        _, key = remainders[i % len(remainders)]
        if alloc[key] < len(strata[key]):
            alloc[key] += 1
            assigned += 1
        i += 1
        if i > len(remainders) * 1000:
            break
    chosen: List[dict] = []
    for key, items in strata.items():
        pick = min(alloc.get(key, 0), len(items))
        chosen.extend(rng.sample(items, pick))
    return chosen


def _zscore(vals: List[Optional[float]]) -> List[Optional[float]]:
    present = [v for v in vals if v is not None]
    if len(present) < 2:
        return [None] * len(vals)
    mean = sum(present) / len(present)
    var = sum((v - mean) ** 2 for v in present) / len(present)
    sd = var ** 0.5 or 1.0
    return [None if v is None else (v - mean) / sd for v in vals]


def disagreement_scores(cands: List[dict], use_comet: bool) -> List[dict]:
    """Attach e5_direct, e5_centroid, comet (optional) and a disagreement spread."""
    from embedding_eval import EmbeddingEvaluator
    emb = EmbeddingEvaluator()
    sources = [c["source_en"] for c in cands]
    targets = [c["translation"] for c in cands]
    e5_direct = emb.evaluate_batch(sources, targets)

    # Centroid per locale: other approved locales of the same row form the centroid.
    e5_centroid: List[Optional[float]] = [None] * len(cands)
    by_locale: Dict[str, List[int]] = defaultdict(list)
    for i, c in enumerate(cands):
        by_locale[c["locale"]].append(i)
    for loc, idxs in by_locale.items():
        rows = [cands[i]["_row"] for i in idxs]
        all_langs = sorted({k for r in rows for k in r.keys()
                            if k not in FIXED_COLS and k != loc and (r.get(k) or "").strip()})
        scores = emb.centroid_scores(rows, loc, all_langs)
        for j, i in enumerate(idxs):
            e5_centroid[i] = scores[j]

    comet: List[Optional[float]] = [None] * len(cands)
    if use_comet:
        from comet_eval import CometQEEvaluator
        comet = [float(x) for x in CometQEEvaluator().evaluate_batch(sources, targets)]

    zs = [_zscore(e5_direct), _zscore(e5_centroid), _zscore(comet)]
    for i, c in enumerate(cands):
        c["e5_direct"] = e5_direct[i]
        c["e5_centroid"] = e5_centroid[i]
        c["comet"] = comet[i]
        vals = [z[i] for z in zs if z[i] is not None]
        if len(vals) >= 2:
            mean = sum(vals) / len(vals)
            c["disagreement"] = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
        else:
            c["disagreement"] = None
    return cands


def write_blind(cands: List[dict], out_dir: Path) -> None:
    blind = out_dir / "blind"
    blind.mkdir(parents=True, exist_ok=True)
    header = INPUT_COLS + LABEL_COLS

    def write(path: Path, rows: List[dict]) -> None:
        with path.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=header, extrasaction="ignore")
            w.writeheader()
            for r in rows:
                w.writerow({**{k: r.get(k, "") for k in INPUT_COLS}, **{k: "" for k in LABEL_COLS}})

    write(blind / "combined.csv", cands)
    per: Dict[str, List[dict]] = defaultdict(list)
    for c in cands:
        per[c["locale"]].append(c)
    for loc, rows in per.items():
        write(blind / f"{loc}.csv", rows)


def write_provenance(cands: List[dict], out_dir: Path) -> None:
    header = ["item_id", "locale", "stratum", "contentType", "length_bucket",
              "e5_direct", "e5_centroid", "comet", "disagreement"]
    with (out_dir / "provenance.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header, extrasaction="ignore")
        w.writeheader()
        for c in cands:
            w.writerow({k: ("" if c.get(k) is None else c.get(k, "")) for k in header})


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Build a blind v2 validation pool for labeling.")
    # Strings come from a live source keyed by task + country: the draft bucket
    # JSON by default, or the Crowdin API directly with --from-crowdin. No CSV fallback.
    p.add_argument("--from-crowdin", action="store_true",
                   help="Pull APPROVED strings directly from the Crowdin API instead of the default draft bucket.")
    p.add_argument("--source", default=None,
                   help="Translation source: draft (default) | crowdin. Overrides QA_TRANSLATIONS_SOURCE.")
    p.add_argument("--locales", required=True, help="Comma-separated target locales, e.g. es-AR,de-DE,nl-NL.")
    p.add_argument("--backbone", type=int, default=560, help="Uniform-random segments (~70%%).")
    p.add_argument("--enrich", type=int, default=240, help="Disagreement segments (~30%%).")
    p.add_argument("--max-enrich-candidates", type=int, default=4000,
                   help="Cap pool scored for disagreement (bounds model cost).")
    p.add_argument("--no-enrich-signals", action="store_true",
                   help="Skip models; fill the enrich quota with extra random picks.")
    p.add_argument("--enrich-with-comet", action="store_true", help="Add COMET-QE to the disagreement signals.")
    p.add_argument("--seed", type=int, default=20260627)
    p.add_argument("--output-dir", default="output/validation-pool-v2")
    args = p.parse_args()

    rng = random.Random(args.seed)
    locales = [l.strip() for l in args.locales.split(",") if l.strip()]
    rows, lang_cols = load_rows(args)
    print(f"[pool] {len(rows)} source rows; locales available: {', '.join(lang_cols) or '(none)'}")

    cands = build_candidates(rows, locales)
    if not cands:
        sys.exit("No candidates: check --locales against the available locale columns above.")
    print(f"[pool] {len(cands)} candidate segments across {len(locales)} locale(s).")

    backbone = stratified_sample(cands, args.backbone, rng)
    chosen_ids = {(c["item_id"], c["locale"]) for c in backbone}
    remaining = [c for c in cands if (c["item_id"], c["locale"]) not in chosen_ids]
    for c in backbone:
        c["stratum"] = "backbone"

    enrich: List[dict] = []
    if args.enrich > 0 and remaining:
        if args.no_enrich_signals:
            enrich = rng.sample(remaining, min(args.enrich, len(remaining)))
        else:
            pool = remaining if len(remaining) <= args.max_enrich_candidates \
                else rng.sample(remaining, args.max_enrich_candidates)
            try:
                disagreement_scores(pool, use_comet=args.enrich_with_comet)
                scored = [c for c in pool if c.get("disagreement") is not None]
                scored.sort(key=lambda c: -c["disagreement"])
                enrich = scored[:args.enrich]
            except Exception as exc:  # model missing / OOM -> degrade to random, don't fail the run
                print(f"[pool] enrichment signals unavailable ({exc}); using random enrich picks.")
                enrich = rng.sample(remaining, min(args.enrich, len(remaining)))
    for c in enrich:
        c["stratum"] = "enrich"

    final = backbone + enrich
    rng.shuffle(final)  # interleave strata so annotators can't infer the source
    for c in final:
        c.pop("_row", None)

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    write_blind(final, out_dir)
    write_provenance(final, out_dir)

    poor_locales = defaultdict(int)
    for c in final:
        poor_locales[c["locale"]] += 1
    print(f"[done] {len(final)} segments "
          f"(backbone={len(backbone)}, enrich={len(enrich)}) -> {out_dir}/blind/")
    print("       per-locale: " + ", ".join(f"{k}={v}" for k, v in sorted(poor_locales.items())))
    print("       annotators edit blind/*.csv label columns; keep provenance.csv separate.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
