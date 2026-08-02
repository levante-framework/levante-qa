#!/usr/bin/env python3
"""Build Study A item CSVs from the NL cross-lang TROG triage file.

Blind labels (no VLM scores) go to blind/nl-NL.csv for annotators / Prolific.
Stratum + panel deltas stay in provenance.csv (analysis only — do not show raters).

Usage (from repo root):
  python3 scripts/eval/studies/nl-trog-xlang-pilot/build_items.py
"""

from __future__ import annotations

import argparse
import csv
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]  # levante-qa
DEFAULT_XLANG = REPO / "tools/vlm-panel/out/review_xlang_nl.csv"

INPUT_COLS = [
    "item_id",
    "identifier",
    "locale",
    "source_en",
    "translation",
    "contentType",
    "length_bucket",
]
LABEL_COLS = [
    "adequacy",
    "appropriateness",
    "mqm_errors",
    "overall_verdict",
    "rater_id",
    "notes",
]


def length_bucket(text: str) -> str:
    n = len((text or "").split())
    if n <= 5:
        return "short"
    if n < 20:
        return "medium"
    return "long"


def load_xlang(path: Path) -> list[dict]:
    rows = list(csv.DictReader(path.open(encoding="utf-8")))
    for r in rows:
        r["delta"] = float(r["delta"])
        r["p_en"] = float(r["p_en"])
        r["p_nl"] = float(r["p_nl"])
    return rows


def pick_pool(rows: list[dict], seed: int, drop_thresh: float, n_filler: int) -> list[dict]:
    rng = random.Random(seed)
    cand = sorted([r for r in rows if r["delta"] <= drop_thresh], key=lambda x: x["delta"])
    cand_ids = {r["item_uid"] for r in cand}

    ctrl_pool = [
        r for r in rows if abs(r["delta"]) <= 0.05 and r["item_uid"] not in cand_ids
    ]
    used: set[str] = set()
    controls: list[dict] = []
    for c in cand:
        best = None
        best_d = 999.0
        for r in ctrl_pool:
            if r["item_uid"] in used:
                continue
            d = abs(r["p_en"] - c["p_en"])
            if d < best_d:
                best_d = d
                best = r
        if best is None:
            continue
        used.add(best["item_uid"])
        row = dict(best)
        row["_matched_to"] = c["item_uid"]
        controls.append(row)

    fill_pool = [
        r
        for r in rows
        if abs(r["delta"]) <= 0.08
        and r["item_uid"] not in cand_ids
        and r["item_uid"] not in used
    ]
    rng.shuffle(fill_pool)
    fillers = fill_pool[:n_filler]

    def pack(r: dict, stratum: str, matched_to: str = "") -> dict:
        src = (r.get("transcript_en") or "").strip()
        tgt = (r.get("transcript_nl") or "").strip()
        uid = r["item_uid"]
        return {
            "item_id": f"trog/{uid}",
            "identifier": uid,
            "item_uid": uid,
            "locale": "nl-NL",
            "source_en": src,
            "translation": tgt,
            "contentType": "trog_stem",
            "length_bucket": length_bucket(src),
            "stratum": stratum,
            "delta": round(float(r["delta"]), 3),
            "p_en": float(r["p_en"]),
            "p_nl": float(r["p_nl"]),
            "flag_en": r.get("flag_en") or "",
            "flag_nl": r.get("flag_nl") or "",
            "matched_to": matched_to,
        }

    items = [pack(r, "xlang_drop") for r in cand]
    items += [pack(r, "control", r.get("_matched_to", "")) for r in controls]
    items += [pack(r, "filler") for r in fillers]
    rng.shuffle(items)
    return items


def write_blind(path: Path, items: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cols = INPUT_COLS + LABEL_COLS
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in items:
            row = {c: r.get(c, "") for c in INPUT_COLS}
            for c in LABEL_COLS:
                row[c] = ""
            w.writerow(row)


def write_provenance(path: Path, items: list[dict]) -> None:
    cols = [
        "item_id",
        "identifier",
        "locale",
        "stratum",
        "matched_to",
        "delta",
        "p_en",
        "p_nl",
        "flag_en",
        "flag_nl",
        "length_bucket",
        "source_en",
        "translation",
    ]
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in items:
            w.writerow({c: r.get(c, "") for c in cols})


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--xlang-csv", type=Path, default=DEFAULT_XLANG)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--drop-thresh", type=float, default=-0.12)
    p.add_argument("--n-filler", type=int, default=10)
    p.add_argument("--out-dir", type=Path, default=HERE)
    args = p.parse_args()

    rows = load_xlang(args.xlang_csv)
    items = pick_pool(rows, args.seed, args.drop_thresh, args.n_filler)
    write_blind(args.out_dir / "blind" / "nl-NL.csv", items)
    write_provenance(args.out_dir / "provenance.csv", items)

    counts: dict[str, int] = {}
    for r in items:
        counts[r["stratum"]] = counts.get(r["stratum"], 0) + 1
    print(f"Wrote {len(items)} items → {args.out_dir}")
    print("strata:", counts)


if __name__ == "__main__":
    main()
