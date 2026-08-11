# Bank-scale difficulty estimates — stories / en

Generated: 2026-08-11T20:25:38.237Z

## Inputs

- Screen: `/home/david/levante/levante-qa/tools/vlm-panel/out/screen_stories_en_paper_ladder.csv` (31 items)
- Bank: `/home/david/levante/levante-qa/cypress/cache/sim-item-bank-theory-of-mind.csv` (31 rows)
- Bench item_params: `/home/david/levante/levante-bench/data/responses/v2/irt_models/theory-of-mind_item_params.csv` (66 d)

## Model (hybrid v2)

Robust multivariate: standardized features → ridge (λ=0.01) + Huber IRLS. Features:

- `z`

Coefficients (raw / unstandardized):

| feature | coef |
|---------|------|
| intercept | -0.3077 |
| z | -0.6728 |

Anchors: **27** / 31. Held-out: **LOO**.

## Held-out recovery of bank `d`

Bank `d` is difficulty-coded (higher = harder). `−p_*` columns are the p-only ranking ceiling.

| Metric | multivar d_est_cv | p-only affine CV | mean baseline | −p_vlm | −p_pred_child |
|--------|-------------------|------------------|---------------|--------|---------------|
| Spearman vs d_bank | **0.612** | 0.618 | — | 0.698 | 0.711 |
| Pearson vs d_bank | 0.863 | 0.860 | — | 0.806 | 0.811 |
| MAE | **0.897** | 0.910 | 1.824 | — | — |
| RMSE | 1.227 | 1.239 | 2.429 | — | — |
| Bias (est − bank) | -0.042 | 0.013 | -0.000 | — | — |

Multivar Spearman 0.612 vs p-only ceiling 0.711 (need features to clear ceiling by ≫0).

### Per-fold

| Fold | n_train | n_test | ρ multivar | MAE | ρ p-only |
|------|---------|--------|------------|-----|----------|
| 1 | 26 | 1 | — | 0.687 | — |
| 2 | 26 | 1 | — | 0.290 | — |
| 3 | 26 | 1 | — | 0.182 | — |
| 4 | 26 | 1 | — | 1.106 | — |
| 5 | 26 | 1 | — | 4.144 | — |
| 6 | 26 | 1 | — | 0.582 | — |
| 7 | 26 | 1 | — | 0.578 | — |
| 8 | 26 | 1 | — | 0.020 | — |
| 9 | 26 | 1 | — | 0.847 | — |
| 10 | 26 | 1 | — | 0.245 | — |
| 11 | 26 | 1 | — | 1.099 | — |
| 12 | 26 | 1 | — | 2.237 | — |
| 13 | 26 | 1 | — | 0.062 | — |
| 14 | 26 | 1 | — | 0.767 | — |
| 15 | 26 | 1 | — | 0.325 | — |
| 16 | 26 | 1 | — | 1.041 | — |
| 17 | 26 | 1 | — | 1.997 | — |
| 18 | 26 | 1 | — | 1.348 | — |
| 19 | 26 | 1 | — | 0.909 | — |
| 20 | 26 | 1 | — | 1.276 | — |
| 21 | 26 | 1 | — | 0.194 | — |
| 22 | 26 | 1 | — | 0.446 | — |
| 23 | 26 | 1 | — | 0.237 | — |
| 24 | 26 | 1 | — | 0.615 | — |
| 25 | 26 | 1 | — | 1.418 | — |
| 26 | 26 | 1 | — | 0.913 | — |
| 27 | 26 | 1 | — | 0.656 | — |

## Sanity vs human pass rates

n = 27

- Spearman(d_est_cv, −p_human): **0.570**
- Spearman(d_bank, −p_human): 0.941

## Cross-check vs bench `item_params` (report-only)

n = 27. Spearman(d_est_cv, d_bench)=-0.612; Spearman(d_bank, d_bench)=-1.000.

## Largest |residuals| (held-out)

| item_uid | d_bank | d_est_cv | resid | p_pred | p_human | tags |
|----------|--------|----------|-------|--------|---------|------|
| tom_deception_false_belief_3 | 3.885 | -0.259 | -4.144 | 0.730 | 0.483 | spatial |
| tom_interpretation_reality_check_2 | -2.380 | -0.142 | 2.237 | 0.730 | 0.968 | spatial |
| tom_moral_reasoning_reality_check_2 | -2.549 | -0.552 | 1.997 | 0.806 | 0.870 | other |
| tom_second_order_false_belief_2 | 1.159 | -0.259 | -1.418 | 0.638 | 0.638 | other |
| tom_reality_known_false_belief | 1.007 | -0.341 | -1.348 | 0.745 | 0.675 | other |
| tom_reference_emotion_reasoning_1 | -2.785 | -1.509 | 1.276 | 0.903 | 0.893 | spatial |
| tom_deception_false_belief_2 | 0.257 | -0.849 | -1.106 | 0.836 | 0.646 | spatial |
| tom_interpretation_reality_check_1 | -1.720 | -0.621 | 1.099 | 0.816 | 0.879 | spatial |
| tom_moral_reasoning_false_belief_2 | 0.195 | -0.846 | -1.041 | 0.836 | 0.712 | other |
| tom_second_order_false_belief_3 | 0.669 | -0.244 | -0.913 | 0.730 | 0.692 | other |
| tom_reality_known_reality_check | -1.657 | -0.748 | 0.909 | 0.836 | 0.926 | other |
| tom_interpretation_emotion_reasoning | -0.218 | -1.066 | -0.847 | 0.806 | 0.774 | spatial |
| tom_moral_reasoning_emotion_reasoning_2 | 1.387 | 0.620 | -0.767 | 0.394 | 0.418 | spatial |
| tom_deception_emotion_reasoning_1 | -2.235 | -1.549 | 0.687 | 0.903 | 0.912 | spatial |
| tom_second_order_reality_check | -1.299 | -0.643 | 0.656 | 0.816 | 0.871 | other |

## Outputs

- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_stories_en.csv`
- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_stories_en_report.md`

## How to read this

- **Spearman(d_est_cv, d_bank)** vs **−p_pred_child**: multivar should beat the p-only ceiling when construction/Zipf features help.
- Prompt changes only move the ceiling after an ungated panel recollect + re-analyze.
