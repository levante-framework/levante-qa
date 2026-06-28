#!/usr/bin/env python3
"""
Orchestrator for the SOTA translation-evaluation pipeline.

Runs any combination of three complementary signals over a CSV of translations:
  --run-embedding : multilingual-e5 direct cosine + same-item centroid similarity
  --run-comet     : COMET-QE neural quality estimation
  --run-llm       : Gemini MQM judge (deterministic score, cached/resume-safe)

Input CSV must have an id column, an English source column, and a target column.
Extra locale columns (e.g. de, fr-CA, pt-BR) are used for the centroid signal.

Example:
  python evaluate_translations.py \
    --input-csv ../../../levante-web-dashboard/data/validation/crowdin-xliff-dashboard.csv \
    --target-col es-AR --auto-centroid --all --output-csv output/eval-es-AR.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path
from typing import Dict, List

from envload import load_env

# Meta columns in the LEVANTE crowdin exports that are not languages.
NON_LANG_COLUMNS = {"identifier", "item_id", "labels", "contentType", "_path"}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="SOTA translation evaluation pipeline")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--input-csv", help="Read translations from a local CSV.")
    src.add_argument(
        "--from-crowdin",
        action="store_true",
        help="Read APPROVED translations directly from Crowdin (like the dashboard).",
    )
    p.add_argument("--crowdin-content-type", default="", help="With --from-crowdin: filter itembank|survey|dashboard.")
    p.add_argument("--crowdin-include-unapproved", action="store_true", help="With --from-crowdin: include unapproved too.")
    p.add_argument("--output-csv", default="output/eval_results.csv")
    p.add_argument("--source-col", default="en")
    p.add_argument("--target-col", required=True, help="Target column; also used as the locale label.")
    p.add_argument("--id-col", default="identifier")
    p.add_argument("--centroid-langs", default="", help="Comma-separated locale columns for the centroid signal.")
    p.add_argument("--auto-centroid", action="store_true", help="Auto-detect locale columns for the centroid.")
    p.add_argument("--run-comet", action="store_true")
    p.add_argument("--run-embedding", action="store_true")
    p.add_argument("--run-llm", action="store_true")
    p.add_argument("--all", action="store_true")
    p.add_argument("--sample", type=int, default=0, help="Randomly sample N rows (seed 42).")
    p.add_argument("--limit", type=int, default=0, help="Use only the first N rows (after filtering).")
    p.add_argument("--comet-model", default="Unbabel/wmt22-cometkiwi-da")
    p.add_argument("--embed-model", default="intfloat/multilingual-e5-large")
    p.add_argument("--llm-model", default="gemini-2.5-flash")
    p.add_argument("--no-cache", action="store_true", help="Disable the LLM disk cache.")
    return p.parse_args()


def load_rows(path: Path, id_col: str, source_col: str, target_col: str) -> tuple[List[dict], List[str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        for col in (id_col, source_col, target_col):
            if col not in fieldnames:
                sys.exit(f"Error: column '{col}' not found in {path} (have: {fieldnames})")
        rows = [r for r in reader]
    return filter_present(rows, source_col, target_col), fieldnames


def resolve_centroid_langs(args: argparse.Namespace, fieldnames: List[str]) -> List[str]:
    if args.centroid_langs:
        return [c.strip() for c in args.centroid_langs.split(",") if c.strip()]
    if args.auto_centroid:
        return [
            c for c in fieldnames
            if c not in NON_LANG_COLUMNS and c not in {args.source_col, args.target_col, args.id_col}
        ]
    return []


def filter_present(rows: List[dict], source_col: str, target_col: str) -> List[dict]:
    kept = [r for r in rows if (r.get(source_col) or "").strip() and (r.get(target_col) or "").strip()]
    skipped = len(rows) - len(kept)
    if skipped:
        print(f"[load] skipped {skipped} rows with empty source or target.")
    return kept


def main() -> int:
    load_env()
    args = parse_args()
    if args.all:
        args.run_comet = args.run_embedding = args.run_llm = True
    if not (args.run_comet or args.run_embedding or args.run_llm):
        sys.exit("Specify at least one of --run-comet / --run-embedding / --run-llm / --all.")

    if args.from_crowdin:
        from crowdin_source import fetch_approved_rows
        all_rows, lang_columns = fetch_approved_rows(approved_only=not args.crowdin_include_unapproved)
        if args.crowdin_content_type:
            all_rows = [r for r in all_rows if str(r.get("contentType", "")).lower() == args.crowdin_content_type.lower()]
        if args.target_col not in lang_columns and args.target_col != "en":
            sys.exit(f"Error: target '{args.target_col}' not among Crowdin languages: {lang_columns}")
        fieldnames = ["identifier", "item_id", "labels", "contentType", "_path", "en", *lang_columns]
        rows = filter_present(all_rows, args.source_col, args.target_col)
        print(f"[crowdin] {len(rows)} rows with source+{args.target_col} present.")
    else:
        input_path = Path(args.input_csv)
        if not input_path.exists():
            sys.exit(f"Error: input file {input_path} not found.")
        rows, fieldnames = load_rows(input_path, args.id_col, args.source_col, args.target_col)
    if args.sample and args.sample < len(rows):
        import random
        random.seed(42)
        rows = random.sample(rows, args.sample)
        print(f"[load] sampled {len(rows)} rows.")
    if args.limit and args.limit < len(rows):
        rows = rows[: args.limit]
        print(f"[load] limited to {len(rows)} rows.")
    if not rows:
        sys.exit("No rows to evaluate after filtering.")

    sources = [(r.get(args.source_col) or "").strip() for r in rows]
    targets = [(r.get(args.target_col) or "").strip() for r in rows]
    results: List[Dict[str, object]] = [{} for _ in rows]
    extra_cols: List[str] = []

    if args.run_embedding:
        from embedding_eval import EmbeddingEvaluator
        print("\n=== Embedding (multilingual-e5) ===")
        ev = EmbeddingEvaluator(model_name=args.embed_model)
        for i, s in enumerate(ev.evaluate_batch(sources, targets)):
            results[i]["e5_direct_sim"] = round(s, 4)
        extra_cols.append("e5_direct_sim")

        centroid_langs = resolve_centroid_langs(args, fieldnames)
        if centroid_langs:
            print(f"[embed] centroid over languages: {centroid_langs}")
            cscores = ev.centroid_scores(rows, args.target_col, centroid_langs)
            for i, s in enumerate(cscores):
                results[i]["e5_centroid_sim"] = "" if s is None else round(s, 4)
            extra_cols.append("e5_centroid_sim")
        else:
            print("[embed] no centroid languages resolved (skip centroid signal).")

    if args.run_comet:
        from comet_eval import CometQEEvaluator
        print("\n=== COMET-QE ===")
        ev = CometQEEvaluator(model_name=args.comet_model)
        for i, s in enumerate(ev.evaluate_batch(sources, targets)):
            results[i]["comet_qe"] = round(s, 4)
        extra_cols.append("comet_qe")

    if args.run_llm:
        from llm_mqm_eval import LlmMqmEvaluator
        from tqdm import tqdm
        print("\n=== Gemini MQM judge ===")
        if not os.environ.get("GEMINI_API_KEY"):
            sys.exit("GEMINI_API_KEY not set; required for --run-llm.")
        ev = LlmMqmEvaluator(model_name=args.llm_model)
        n_fail = 0
        for i in tqdm(range(len(rows)), desc="MQM"):
            res = ev.evaluate_single(
                sources[i], targets[i], args.target_col, use_cache=not args.no_cache
            )
            if res["ok"]:
                results[i]["mqm_score"] = res["score"]
            else:
                results[i]["mqm_score"] = ""  # blank, NOT 0 — failure != bad translation
                n_fail += 1
            results[i]["mqm_status"] = "ok" if res["ok"] else f"error:{res['error']}"
            results[i]["mqm_errors"] = json.dumps(res["errors"], ensure_ascii=False)
            results[i]["mqm_assessment"] = res["assessment"]
        extra_cols += ["mqm_score", "mqm_status", "mqm_errors", "mqm_assessment"]
        if n_fail:
            print(f"[llm] {n_fail} item(s) failed (left blank; re-run to retry).")

    out_path = Path(args.output_csv)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_fields = fieldnames + [c for c in extra_cols if c not in fieldnames]
    with out_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=out_fields, extrasaction="ignore")
        writer.writeheader()
        for row, res in zip(rows, results):
            writer.writerow({**row, **res})
    print(f"\n[done] wrote {len(rows)} rows -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
