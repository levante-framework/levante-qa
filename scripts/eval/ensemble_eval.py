#!/usr/bin/env python3
"""
Ensemble evaluator: does combining signals beat the legacy score?

Validation showed no single new signal beats the legacy back-translation score on
the human-labeled es-AR set. This tests whether an ENSEMBLE does — specifically
the legacy quality score plus two things the legacy signal is blind to:

  * comet_qe            : neural adequacy (source->target), and
  * mqm_major_count     : count of MAJOR/CRITICAL MQM errors (appropriateness /
                          meaning breaks the lenient MQM scalar washed out).

A small logistic-regression blend is fit to predict the human "Poor" verdict,
evaluated with leave-one-out cross-validation (per-fold standardization, so there
is no train/test leakage and no in-sample optimism on n~70). We report the blend
against legacy-alone and each raw signal, using the same metrics as
validate_evaluators.py.

Run (uses the cached MQM results + locally cached COMET, so it is fast):
  .venv/bin/python ensemble_eval.py
"""

from __future__ import annotations

import argparse
import sys
from argparse import Namespace
from typing import List, Optional

import numpy as np

import stats
from envload import load_env
from validate_evaluators import load_gold, metrics_for


def loo_cv_proba(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Leave-one-out out-of-fold P(poor). Standardize on each train fold only."""
    from sklearn.linear_model import LogisticRegression

    n = len(y)
    oof = np.zeros(n, dtype=float)
    for i in range(n):
        mask = np.ones(n, dtype=bool)
        mask[i] = False
        x_tr, y_tr = X[mask], y[mask]
        mu, sd = x_tr.mean(axis=0), x_tr.std(axis=0)
        sd[sd == 0] = 1.0
        clf = LogisticRegression(max_iter=1000, class_weight="balanced")
        clf.fit((x_tr - mu) / sd, y_tr)
        oof[i] = clf.predict_proba(((X[i] - mu) / sd).reshape(1, -1))[0, 1]
    return oof


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Ensemble translation evaluator (validated by LOO-CV).")
    p.add_argument("--labels-csv", default="../../../levante-web-dashboard/data/validation/human-review-seed-es-AR.csv")
    p.add_argument("--target-locale", default="es-AR")
    args = p.parse_args()

    gold = load_gold(Namespace(
        labels_csv=args.labels_csv, notes_col="notes",
        source_col="source_en", target_col="translation_current", id_col="item_id",
    ))
    if not gold:
        sys.exit("No usable gold rows.")
    sources = [g["source"] for g in gold]
    targets = [g["target"] for g in gold]

    # --- features ---------------------------------------------------------- #
    legacy = [g["legacy_ai_score"] for g in gold]

    print("[comet] scoring gold pairs ...")
    from comet_eval import CometQEEvaluator
    comet = [float(x) for x in CometQEEvaluator().evaluate_batch(sources, targets)]

    print("[mqm] counting major/critical errors (cached) ...")
    from llm_mqm_eval import LlmMqmEvaluator
    ev = LlmMqmEvaluator()
    major_count: List[Optional[float]] = []
    for s, t in zip(sources, targets):
        res = ev.evaluate_single(s, t, args.target_locale)
        if not res["ok"]:
            major_count.append(None)
            continue
        major_count.append(float(sum(1 for e in res["errors"] if e["severity"] in ("major", "critical"))))

    # --- assemble matrix on rows with all features present ----------------- #
    rows = []
    for i, g in enumerate(gold):
        if legacy[i] is None or comet[i] is None or major_count[i] is None:
            continue
        rows.append((legacy[i], comet[i], major_count[i], g["ordinal"], g["is_poor"]))
    if len(rows) < 10:
        sys.exit(f"Too few complete rows for ensemble ({len(rows)}).")
    arr = np.array(rows, dtype=float)
    X_all = arr[:, :3]            # legacy, comet, major_count
    y = arr[:, 4].astype(int)
    gold_sub = [{"ordinal": int(r[3]), "is_poor": int(r[4])} for r in rows]
    print(f"[ensemble] {len(rows)} complete rows; poor={int(y.sum())}")

    # Raw single signals (as quality: higher = better). major_count negated.
    report = []
    for name, q in [
        ("legacy_ai_score", list(X_all[:, 0])),
        ("comet_qe", list(X_all[:, 1])),
        ("mqm_major_count", list(-X_all[:, 2])),
    ]:
        m = metrics_for(name, q, gold_sub)
        if m:
            report.append(m)

    # Logistic blends, leave-one-out CV. Quality = P(not poor) = 1 - P(poor).
    blends = {
        "LR legacy": [0],
        "LR legacy+comet": [0, 1],
        "LR legacy+comet+mqm_major": [0, 1, 2],
    }
    for name, cols in blends.items():
        proba = loo_cv_proba(X_all[:, cols], y)
        quality = list(1.0 - proba)
        m = metrics_for(name, quality, gold_sub)
        if m:
            report.append(m)

    _print(report)
    return 0


def _print(report):
    report.sort(key=lambda r: -(r["auc_detect_poor"] if r["auc_detect_poor"] == r["auc_detect_poor"] else 0))
    print("\n" + "=" * 92)
    print(f"{'method':<30}{'n':>5}{'spearman':>10}{'AUC_poor':>10}{'P@k':>8}{'R@k':>8}{'k':>5}")
    print("-" * 92)
    for r in report:
        k = r["k"]
        print(f"{r['method']:<30}{r['n']:>5}{r['spearman_vs_human']:>10}{r['auc_detect_poor']:>10}"
              f"{r[f'precision_at_{k}']:>8}{r[f'recall_at_{k}']:>8}{k:>5}")
    print("=" * 92)
    print("LR rows are leave-one-out cross-validated (out-of-fold). Higher is better everywhere.")


if __name__ == "__main__":
    sys.exit(main())
