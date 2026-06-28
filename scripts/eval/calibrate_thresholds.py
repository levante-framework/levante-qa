#!/usr/bin/env python3
"""
Calibrate production flag thresholds from the trustworthy Prolific labels.

Validation established what each signal measures: E5/COMET -> adequacy (meaning),
MQM -> appropriateness (child register). This picks the *operating point* for
flagging on each axis: the threshold that catches a target fraction of the truly
bad items (recall), and reports the precision / flag-rate you get for it.

Thresholds are on RAW signal values (E5 cosine, COMET score, MQM score), not
corpus-relative z-scores, so they transfer to scoring a fresh corpus. The output
`scoring-config.json` is consumed by review_queue.py.

    python calibrate_thresholds.py --labels-csv output/prolific-v2-es-AR.csv \
        --target-recall 0.80
"""

from __future__ import annotations

import argparse
import json
from argparse import Namespace
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np

from envload import load_env
from validate_evaluators import load_gold_v2


def threshold_at_recall(quality: List[Optional[float]], poor: List[int], target_recall: float):
    """Largest cutoff T (flag if quality < T) that catches >= target_recall of poors.
    Returns (T, achieved_recall, precision, flag_rate) on the calibration set."""
    pairs = [(q, p) for q, p in zip(quality, poor) if q is not None]
    if not pairs:
        return None
    poor_scores = [q for q, p in pairs if p == 1]
    if not poor_scores:
        return None
    # quantile of poor scores: flagging below it catches ~target_recall of them.
    t = float(np.quantile(poor_scores, target_recall))
    flagged = [(q, p) for q, p in pairs if q < t]
    n_flag = len(flagged)
    tp = sum(p for _, p in flagged)
    n_poor = sum(p for _, p in pairs)
    return {
        "threshold": round(t, 5),
        "achieved_recall": round(tp / n_poor, 3) if n_poor else None,
        "precision": round(tp / n_flag, 3) if n_flag else None,
        "flag_rate": round(n_flag / len(pairs), 3),
        "n": len(pairs),
        "n_poor": n_poor,
    }


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Calibrate flag thresholds from Prolific labels.")
    p.add_argument("--labels-csv", default="output/prolific-v2-es-AR.csv")
    p.add_argument("--target-recall", type=float, default=0.80)
    p.add_argument("--output", default="output/scoring-config.json")
    args = p.parse_args()

    gold = load_gold_v2(Namespace(labels_csv=args.labels_csv))
    if not gold:
        raise SystemExit("No labeled rows; run dashboard_labels.py first.")
    sources = [g["source"] for g in gold]
    targets = [g["target"] for g in gold]
    locales = [g["locale"] for g in gold]
    adq_poor = [1 if (g["adequacy"] is not None and g["adequacy"] <= 1) else 0 for g in gold]
    app_poor = [1 if (g["appropriateness"] is not None and g["appropriateness"] <= 1) else 0 for g in gold]

    from embedding_eval import EmbeddingEvaluator
    emb = EmbeddingEvaluator()
    e5 = [float(x) for x in emb.evaluate_batch(sources, targets)]

    from comet_eval import CometQEEvaluator
    comet = [float(x) for x in CometQEEvaluator().evaluate_batch(sources, targets)]

    from llm_mqm_eval import LlmMqmEvaluator
    ev = LlmMqmEvaluator()
    mqm_score: List[Optional[float]] = []
    mqm_major: List[Optional[int]] = []
    for s, t, loc in zip(sources, targets, locales):
        res = ev.evaluate_single(s, t, loc)
        if res["ok"]:
            mqm_score.append(float(res["score"]))
            mqm_major.append(sum(1 for e in res["errors"] if e["severity"] in ("major", "critical")))
        else:
            mqm_score.append(None)
            mqm_major.append(None)

    # major-count rule (>=1 major) reported as a fixed-rule operating point.
    def rule_major(poor):
        pairs = [(m, p) for m, p in zip(mqm_major, poor) if m is not None]
        flagged = [(m, p) for m, p in pairs if m >= 1]
        tp = sum(p for _, p in flagged)
        n_poor = sum(p for _, p in pairs)
        return {
            "rule": "mqm_major_count>=1",
            "achieved_recall": round(tp / n_poor, 3) if n_poor else None,
            "precision": round(tp / len(flagged), 3) if flagged else None,
            "flag_rate": round(len(flagged) / len(pairs), 3) if pairs else None,
        }

    config = {
        "calibrated_on": str(Path(args.labels_csv).name),
        "target_recall": args.target_recall,
        "locales_in_calibration": sorted(set(locales)),
        "adequacy": {
            "e5_direct_sim": threshold_at_recall(e5, adq_poor, args.target_recall),
            "comet_qe": threshold_at_recall(comet, adq_poor, args.target_recall),
            "flag_logic": "flag if e5_direct_sim < threshold OR comet_qe < threshold",
        },
        "appropriateness": {
            "mqm_score": threshold_at_recall(mqm_score, app_poor, args.target_recall),
            "mqm_major_rule": rule_major(app_poor),
            "flag_logic": "flag if mqm_score < threshold OR mqm_major_count >= 1",
        },
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(config, indent=2), encoding="utf-8")
    print(json.dumps(config, indent=2))
    print(f"\n[done] scoring config -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
