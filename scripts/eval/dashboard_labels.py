#!/usr/bin/env python3
"""
Turn the translation dashboard's existing human-decision logs into v2 two-axis
labels, so we can validate the evaluators TODAY without waiting for new annotation.

The dashboard already holds real human judgments we can reuse:

  * Prolific crowdsourced ratings (best: external + two axes + has source/target inline)
      data/validation/prolific-es-AR-pilot-aggregated.csv
      - adequacy        <- meaning votes: different_ratio (0 = all "same meaning")
      - appropriateness <- avg_child_clarity (1..5 Likert)
      - is_poor         <- prolific_needs_review (the crowd's flag)

  * Dashboard reviewer state (in-house, single axis, multi-locale)
      data/validation/validation_results.shared.json
      - manualApproved -> good ; needsReview -> poor (overall axis only)

This emits a CSV in the v2 schema that validate_evaluators.py auto-detects, so:

    python dashboard_labels.py --source prolific
    python validate_evaluators.py --labels-csv output/prolific-v2-es-AR.csv \
        --run-embedding --run-comet            # adequacy axis, fast, no API
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import List, Optional

from envload import load_env

DASH = Path("../../../levante-web-dashboard/data/validation")
V2_HEADER = ["item_id", "identifier", "locale", "source_en", "translation", "contentType",
             "length_bucket", "adequacy", "appropriateness", "mqm_errors",
             "overall_verdict", "rater_id", "notes", "ai_score", "composite_score"]


def _length_bucket(text: str) -> str:
    n = len((text or "").split())
    return "short" if n <= 5 else ("medium" if n < 20 else "long")


def _f(v) -> Optional[float]:
    try:
        s = str(v).strip()
        return float(s) if s != "" else None
    except (TypeError, ValueError):
        return None


def adequacy_from_different_ratio(diff_ratio: Optional[float]) -> Optional[int]:
    """different_ratio: share of voters saying meaning differs (0 best, 1 worst)."""
    if diff_ratio is None:
        return None
    if diff_ratio <= 0.0:
        return 3
    if diff_ratio <= 0.34:
        return 2
    if diff_ratio <= 0.67:
        return 1
    return 0


def appropriateness_from_clarity(clarity_1to5: Optional[float]) -> Optional[int]:
    """avg child-clarity Likert (1..5) -> 0..3."""
    if clarity_1to5 is None:
        return None
    if clarity_1to5 >= 4.5:
        return 3
    if clarity_1to5 >= 3.5:
        return 2
    if clarity_1to5 >= 2.5:
        return 1
    return 0


def from_prolific(path: Path, locale: str) -> List[dict]:
    rows: List[dict] = []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            src = (r.get("source_en") or "").strip()
            tgt = (r.get("translation_current") or "").strip()
            if not src or not tgt:
                continue
            adq = adequacy_from_different_ratio(_f(r.get("different_ratio")))
            app = appropriateness_from_clarity(_f(r.get("avg_child_clarity")))
            needs_review = str(r.get("prolific_needs_review") or "").strip() in ("1", "true", "True")
            rows.append({
                "item_id": (r.get("item_id") or "").strip(),
                "identifier": (r.get("item_id") or "").strip(),
                "locale": (r.get("lang_code") or locale).strip() or locale,
                "source_en": src,
                "translation": tgt,
                "contentType": (r.get("content_type") or "").strip(),
                "length_bucket": _length_bucket(src),
                "adequacy": "" if adq is None else adq,
                "appropriateness": "" if app is None else app,
                "mqm_errors": "",
                "overall_verdict": "Poor" if needs_review else "OK",
                "rater_id": "prolific_crowd",
                "notes": (r.get("reason_tags") or "").strip(),
            })
    return rows


def _load_merged_texts(path: Path) -> dict:
    """item_id -> {'en': src, '<locale>': text, ...} from crowdin-xliff-merged.csv."""
    if not path.is_file():
        return {}
    meta = {"identifier", "item_id", "labels", "contentType", "_path"}
    out: dict = {}
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            iid = (r.get("item_id") or r.get("identifier") or "").strip()
            if iid:
                out[iid] = {k: (v or "").strip() for k, v in r.items() if k not in meta}
    return out


def from_shared_validation(path: Path, merged_csv: Path) -> List[dict]:
    """Dashboard manualApproved / needsReview -> overall axis. Source/target are not
    stored in the validation JSON, so they are joined from crowdin-xliff-merged.csv
    by item_id + locale (same join build_human_review_seed.py uses)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    texts = _load_merged_texts(merged_csv)
    rows: List[dict] = []
    missing = 0
    for item_id, by_lang in (data.get("validation_results", data) or {}).items():
        if not isinstance(by_lang, dict):
            continue
        for lang, rec in by_lang.items():
            if not isinstance(rec, dict):
                continue
            approved = bool(rec.get("manualApproved"))
            flagged = bool(rec.get("needsReview"))
            if not approved and not flagged:
                continue
            merged = texts.get(item_id, {})
            src = (rec.get("source_en") or merged.get("en") or "").strip()
            tgt = (rec.get("translation_current") or rec.get("target") or merged.get(lang) or "").strip()
            if not src or not tgt:
                missing += 1
                continue
            rows.append({
                "item_id": item_id, "identifier": item_id, "locale": lang,
                "source_en": src, "translation": tgt,
                "contentType": merged.get("contentType", ""),
                "length_bucket": _length_bucket(src),
                "adequacy": "", "appropriateness": "", "mqm_errors": "",
                "overall_verdict": "Poor" if flagged else "OK",
                "rater_id": "dashboard_reviewer",
                "notes": (rec.get("reason") or rec.get("notes") or "").strip(),
                "ai_score": rec.get("aiScore", ""),
                "composite_score": rec.get("compositeScore", ""),
            })
    if missing:
        print(f"[warn] dropped {missing} rows with no source/target after join.")
    return rows


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Adapt dashboard human-decision logs to v2 labels.")
    p.add_argument("--source", choices=["prolific", "shared"], default="prolific")
    p.add_argument("--input", default="", help="Override input path (defaults per source).")
    p.add_argument("--locale", default="es-AR")
    p.add_argument("--output", default="")
    args = p.parse_args()

    if args.source == "prolific":
        inp = Path(args.input) if args.input else DASH / "prolific-es-AR-pilot-aggregated.csv"
        out = Path(args.output) if args.output else Path(f"output/prolific-v2-{args.locale}.csv")
        rows = from_prolific(inp, args.locale)
    else:
        inp = Path(args.input) if args.input else DASH / "validation_results.shared.json"
        out = Path(args.output) if args.output else Path("output/shared-validation-v2.csv")
        rows = from_shared_validation(inp, DASH / "crowdin-xliff-merged.csv")

    if not rows:
        sys.exit(f"No usable rows from {inp}.")
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=V2_HEADER, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    poor = sum(1 for r in rows if str(r["overall_verdict"]).lower() == "poor")
    labeled_adq = sum(1 for r in rows if r["adequacy"] != "")
    labeled_app = sum(1 for r in rows if r["appropriateness"] != "")
    print(f"[done] {len(rows)} rows ({poor} poor) -> {out}")
    print(f"       adequacy labeled={labeled_adq}, appropriateness labeled={labeled_app}")
    print(f"       validate: python validate_evaluators.py --labels-csv {out} --run-embedding --run-comet")
    return 0


if __name__ == "__main__":
    sys.exit(main())
