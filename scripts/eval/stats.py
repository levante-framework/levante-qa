"""
Small, dependency-free statistics for validating translation evaluators against
human judgments. Implemented with numpy only (no scipy) so the validation harness
stays light and runs anywhere.

The functions here answer one question: "How well does an automatic score agree
with the human verdict?" via rank correlation (Spearman, Kendall tau-b), ranking
quality (ROC-AUC), and top-k detection (precision/recall@k).
"""

from __future__ import annotations

from typing import List, Sequence, Tuple

import numpy as np


def _rankdata(values: Sequence[float]) -> np.ndarray:
    """Average ranks (1-based), ties share the mean of their rank span."""
    arr = np.asarray(values, dtype=float)
    order = arr.argsort(kind="mergesort")
    ranks = np.empty(len(arr), dtype=float)
    ranks[order] = np.arange(1, len(arr) + 1, dtype=float)
    # Resolve ties to average rank.
    _, inv, counts = np.unique(arr, return_inverse=True, return_counts=True)
    sums = np.zeros(len(counts), dtype=float)
    np.add.at(sums, inv, ranks)
    return sums[inv] / counts[inv]


def pearson(x: Sequence[float], y: Sequence[float]) -> float:
    a = np.asarray(x, dtype=float)
    b = np.asarray(y, dtype=float)
    if len(a) < 2 or np.std(a) == 0 or np.std(b) == 0:
        return float("nan")
    return float(np.corrcoef(a, b)[0, 1])


def spearman(x: Sequence[float], y: Sequence[float]) -> float:
    """Spearman rho = Pearson correlation of the ranks."""
    if len(x) < 2:
        return float("nan")
    return pearson(_rankdata(x), _rankdata(y))


def kendall_tau_b(x: Sequence[float], y: Sequence[float]) -> float:
    """Kendall tau-b (handles ties). O(n^2) — fine for validation-set sizes."""
    a = np.asarray(x, dtype=float)
    b = np.asarray(y, dtype=float)
    n = len(a)
    if n < 2:
        return float("nan")
    concordant = discordant = ties_x = ties_y = 0
    for i in range(n):
        for j in range(i + 1, n):
            dx = a[i] - a[j]
            dy = b[i] - b[j]
            prod = dx * dy
            if prod > 0:
                concordant += 1
            elif prod < 0:
                discordant += 1
            else:
                if dx == 0:
                    ties_x += 1
                if dy == 0:
                    ties_y += 1
    n0 = n * (n - 1) / 2
    denom = np.sqrt((n0 - ties_x) * (n0 - ties_y))
    if denom == 0:
        return float("nan")
    return float((concordant - discordant) / denom)


def roc_auc(scores: Sequence[float], labels: Sequence[int]) -> float:
    """
    Area under the ROC curve via the Mann-Whitney U statistic.

    `labels` are 0/1 with 1 = positive class. `scores` are the predictor where a
    HIGHER value should indicate the positive class. Returns NaN if only one
    class is present. AUC=0.5 is chance; 1.0 is perfect.
    """
    s = np.asarray(scores, dtype=float)
    y = np.asarray(labels, dtype=int)
    n_pos = int((y == 1).sum())
    n_neg = int((y == 0).sum())
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    ranks = _rankdata(s)
    sum_pos = ranks[y == 1].sum()
    return float((sum_pos - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def precision_recall_at_k(
    scores: Sequence[float],
    labels: Sequence[int],
    k: int,
    higher_is_positive: bool = True,
) -> Tuple[float, float, int]:
    """
    Rank items by `scores` and look at the top k. Returns (precision, recall,
    hits). `labels` are 0/1 with 1 = the class we are trying to surface.

    For "find the bad translations", the positive class is "bad" and the score
    that flags badness should be high — so pass `higher_is_positive=True` with a
    badness score, or negate a quality score before calling.
    """
    s = np.asarray(scores, dtype=float)
    y = np.asarray(labels, dtype=int)
    if not higher_is_positive:
        s = -s
    order = np.argsort(-s, kind="mergesort")
    kk = min(k, len(order))
    top = order[:kk]
    hits = int(y[top].sum())
    total_pos = int((y == 1).sum())
    precision = hits / kk if kk else 0.0
    recall = hits / total_pos if total_pos else 0.0
    return precision, recall, hits
