#!/usr/bin/env python3
"""
Validate the evaluators against HUMAN judgments.

This is the piece that makes the pipeline defensible: it measures how well each
automatic signal agrees with human reviewers, and puts the new methods
(COMET-QE, multilingual-e5, Gemini MQM) head-to-head with the legacy
back-translation-derived scores that are already in the data.

Ground truth comes from the human-review seed
(levante-web-dashboard/data/validation/human-review-seed-<locale>.csv). The human
verdict lives in the `notes` column:

    Poor translation quality            -> bad   (ordinal 0)
    Good translation, review recommended-> ok     (ordinal 1)
    Manually approved                   -> good   (ordinal 2)
    Excellent translation               -> great  (ordinal 3)

For each method we report, on the common set of rows:
  * Spearman / Kendall correlation with the human ordinal (higher = better)
  * ROC-AUC for detecting the "Poor" items (>0.5 beats chance)
  * Precision/Recall@k for surfacing the "Poor" items

All methods are quality scores (higher = better), so to "detect poor" we rank by
the negated score.

Legacy baselines (`ai_score`, `composite_score`) are always evaluated since they
are columns in the seed. The new methods run only when their flag is passed and
their model/credentials are available; otherwise they are skipped with a notice.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import stats
from envload import load_env

NOTES_TO_ORDINAL = {
    "poor translation quality": 0,
    "good translation, review recommended": 1,
    "manually approved": 2,
    "excellent translation": 3,
}
DEFAULT_SEED = "../../../levante-web-dashboard/data/validation/human-review-seed-es-AR.csv"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Validate translation evaluators against human labels.")
    p.add_argument("--labels-csv", default=DEFAULT_SEED)
    p.add_argument("--target-locale", default="es-AR")
    p.add_argument("--source-col", default="source_en")
    p.add_argument("--target-col", default="translation_current")
    p.add_argument("--notes-col", default="notes")
    p.add_argument("--id-col", default="item_id")
    p.add_argument(
        "--translations-csv",
        default="",
        help="Optional multi-locale CSV (e.g. crowdin-xliff-dashboard.csv) to enable the centroid signal, joined by item_id.",
    )
    p.add_argument(
        "--from-crowdin",
        action="store_true",
        help="Pull APPROVED multi-locale translations directly from Crowdin for the centroid signal (joined by item_id).",
    )
    p.add_argument("--run-comet", action="store_true")
    p.add_argument("--run-embedding", action="store_true")
    p.add_argument("--run-llm", action="store_true")
    p.add_argument("--all", action="store_true")
    p.add_argument("--output-json", default="output/validation-report.json")
    return p.parse_args()


def load_gold(args: argparse.Namespace) -> List[dict]:
    path = Path(args.labels_csv)
    if not path.exists():
        sys.exit(f"Error: labels CSV not found: {path}")
    rows: List[dict] = []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            note = (r.get(args.notes_col) or "").strip().lower()
            if note not in NOTES_TO_ORDINAL:
                continue
            src = (r.get(args.source_col) or "").strip()
            tgt = (r.get(args.target_col) or "").strip()
            if not src or not tgt:
                continue
            rows.append(
                {
                    "item_id": (r.get(args.id_col) or "").strip(),
                    "source": src,
                    "target": tgt,
                    "ordinal": NOTES_TO_ORDINAL[note],
                    "is_poor": 1 if NOTES_TO_ORDINAL[note] == 0 else 0,
                    "legacy_ai_score": _to_float(r.get("ai_score")),
                    "legacy_composite_score": _to_float(r.get("composite_score")),
                }
            )
    return rows


def _to_float(v) -> Optional[float]:
    try:
        s = str(v).strip()
        return float(s) if s else None
    except (TypeError, ValueError):
        return None


def load_centroid_langs(
    translations_csv: str, item_ids: Sequence[str], target_col: str
) -> Tuple[Dict[str, Dict[str, str]], List[str]]:
    """Join item_id -> {lang: text} from a multi-locale export, for centroid use."""
    path = Path(translations_csv)
    if not path.exists():
        print(f"[warn] translations CSV not found: {path}; skipping centroid.")
        return {}, []
    wanted = set(item_ids)
    by_id: Dict[str, Dict[str, str]] = {}
    langs: List[str] = []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        meta = {"identifier", "item_id", "labels", "contentType", "_path", "en"}
        langs = [c for c in (reader.fieldnames or []) if c not in meta]
        for r in reader:
            iid = (r.get("item_id") or r.get("identifier") or "").strip()
            if iid in wanted:
                by_id[iid] = {l: (r.get(l) or "").strip() for l in langs}
    other_langs = [l for l in langs if l != target_col]
    return by_id, other_langs


def load_centroid_from_crowdin(
    item_ids: Sequence[str], target_locale: str
) -> Tuple[Dict[str, Dict[str, str]], List[str]]:
    """Fetch approved multi-locale rows from Crowdin and index them by item_id."""
    try:
        from crowdin_source import fetch_approved_rows
        rows, lang_columns = fetch_approved_rows(approved_only=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[warn] Crowdin fetch failed; skipping centroid: {exc}")
        return {}, []
    wanted = set(item_ids)
    all_langs = ["en", *lang_columns]
    by_id = {
        r["item_id"]: {l: (r.get(l) or "").strip() for l in all_langs}
        for r in rows
        if r.get("item_id") in wanted
    }
    other_langs = [l for l in all_langs if l != target_locale]
    return by_id, other_langs


def metrics_for(name: str, scores: List[Optional[float]], gold: List[dict]) -> Optional[dict]:
    """Compute metrics on the subset where this method produced a score."""
    paired = [
        (s, g["ordinal"], g["is_poor"])
        for s, g in zip(scores, gold)
        if s is not None
    ]
    if len(paired) < 3:
        print(f"[warn] {name}: too few scored rows ({len(paired)}); skipping.")
        return None
    sc = [p[0] for p in paired]
    ordi = [p[1] for p in paired]
    poor = [p[2] for p in paired]
    n_poor = sum(poor)
    # Detect "poor" by ranking on the negated quality score (lower quality first).
    neg = [-x for x in sc]
    k1 = max(5, n_poor)
    p_at, r_at, hits = stats.precision_recall_at_k(neg, poor, k1, higher_is_positive=True)
    return {
        "method": name,
        "n": len(paired),
        "n_poor": n_poor,
        "spearman_vs_human": round(stats.spearman(sc, ordi), 4),
        "kendall_vs_human": round(stats.kendall_tau_b(sc, ordi), 4),
        "auc_detect_poor": round(stats.roc_auc(neg, poor), 4),
        f"precision_at_{k1}": round(p_at, 4),
        f"recall_at_{k1}": round(r_at, 4),
        "k": k1,
    }


def main() -> int:
    load_env()
    args = parse_args()
    if args.all:
        args.run_comet = args.run_embedding = args.run_llm = True

    gold = load_gold(args)
    if not gold:
        sys.exit("No usable gold rows (need notes + source + target).")
    print(f"[gold] {len(gold)} rows; poor={sum(g['is_poor'] for g in gold)}, "
          f"ordinal dist={_dist([g['ordinal'] for g in gold])}")

    sources = [g["source"] for g in gold]
    targets = [g["target"] for g in gold]
    method_scores: Dict[str, List[Optional[float]]] = {
        "legacy_ai_score": [g["legacy_ai_score"] for g in gold],
        "legacy_composite_score": [g["legacy_composite_score"] for g in gold],
    }

    if args.run_embedding:
        try:
            from embedding_eval import EmbeddingEvaluator
            ev = EmbeddingEvaluator()
            method_scores["e5_direct_sim"] = [float(x) for x in ev.evaluate_batch(sources, targets)]
            by_id, other_langs = ({}, [])
            if args.from_crowdin:
                by_id, other_langs = load_centroid_from_crowdin(
                    [g["item_id"] for g in gold], args.target_locale
                )
            elif args.translations_csv:
                by_id, other_langs = load_centroid_langs(
                    args.translations_csv, [g["item_id"] for g in gold], args.target_locale
                )
            if by_id and other_langs:
                rows = [by_id.get(g["item_id"], {args.target_locale: g["target"]}) for g in gold]
                # Ensure the target text is present under the locale key.
                for row, g in zip(rows, gold):
                    row.setdefault(args.target_locale, g["target"])
                method_scores["e5_centroid_sim"] = ev.centroid_scores(
                    rows, args.target_locale, other_langs
                )
        except Exception as exc:  # noqa: BLE001 - skip method, keep harness running
            print(f"[warn] embedding method unavailable: {exc}")

    if args.run_comet:
        try:
            from comet_eval import CometQEEvaluator
            ev = CometQEEvaluator()
            method_scores["comet_qe"] = [float(x) for x in ev.evaluate_batch(sources, targets)]
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] COMET method unavailable (gated model? not logged in?): {exc}")

    if args.run_llm:
        try:
            from llm_mqm_eval import LlmMqmEvaluator
            from tqdm import tqdm
            ev = LlmMqmEvaluator()
            scores: List[Optional[float]] = []
            for s, t in tqdm(list(zip(sources, targets)), desc="MQM"):
                res = ev.evaluate_single(s, t, args.target_locale)
                scores.append(res["score"] if res["ok"] else None)
            method_scores["mqm"] = scores
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] LLM method unavailable: {exc}")

    report = []
    for name, scores in method_scores.items():
        m = metrics_for(name, scores, gold)
        if m:
            report.append(m)
    report.sort(key=lambda r: (-(r["auc_detect_poor"] if r["auc_detect_poor"] == r["auc_detect_poor"] else 0)))

    _print_table(report)

    out_path = Path(args.output_json)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"gold_n": len(gold), "methods": report}, indent=2), encoding="utf-8")
    print(f"\n[done] report -> {out_path}")
    return 0


def _dist(values: Sequence[int]) -> Dict[int, int]:
    out: Dict[int, int] = {}
    for v in values:
        out[v] = out.get(v, 0) + 1
    return dict(sorted(out.items()))


def _print_table(report: List[dict]) -> None:
    if not report:
        print("No methods produced metrics.")
        return
    print("\n" + "=" * 92)
    print(f"{'method':<24}{'n':>5}{'spearman':>10}{'kendall':>9}{'AUC_poor':>10}{'P@k':>8}{'R@k':>8}{'k':>5}")
    print("-" * 92)
    for r in report:
        k = r["k"]
        print(
            f"{r['method']:<24}{r['n']:>5}{r['spearman_vs_human']:>10}{r['kendall_vs_human']:>9}"
            f"{r['auc_detect_poor']:>10}{r[f'precision_at_{k}']:>8}{r[f'recall_at_{k}']:>8}{k:>5}"
        )
    print("=" * 92)
    print("Higher is better for every column. AUC_poor > 0.5 beats chance at flagging bad translations.")


if __name__ == "__main__":
    sys.exit(main())
