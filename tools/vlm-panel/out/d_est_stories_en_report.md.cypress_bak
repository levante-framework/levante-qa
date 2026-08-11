# Bank-scale difficulty estimates — stories / en

Generated: 2026-08-11T06:10:48.099Z

## Inputs

- Screen: `/home/david/levante/levante-qa/tools/vlm-panel/out/screen_stories_en.csv` (29 items)
- Bank: `/home/david/levante/levante-qa/cypress/cache/sim-item-bank-theory-of-mind.csv` (31 rows)
- Bench item_params: `/home/david/levante/levante-bench/data/responses/v2/irt_models/theory-of-mind_item_params.csv` (66 d)

## Model (hybrid v2)

Robust multivariate: standardized features → ridge (λ=0.01) + Huber IRLS. Features:

- `z`

Coefficients (raw / unstandardized):

| feature | coef |
|---------|------|
| intercept | -0.2383 |
| z | -0.6912 |

Anchors: **26** / 29. Held-out: **LOO**.

## Held-out recovery of bank `d`

Bank `d` is difficulty-coded (higher = harder). `−p_*` columns are the p-only ranking ceiling.

| Metric | multivar d_est_cv | p-only affine CV | mean baseline | −p_vlm | −p_pred_child |
|--------|-------------------|------------------|---------------|--------|---------------|
| Spearman vs d_bank | **0.353** | 0.353 | — | 0.684 | 0.683 |
| Pearson vs d_bank | 0.795 | 0.787 | — | 0.802 | 0.797 |
| MAE | **1.106** | 1.141 | 1.798 | — | — |
| RMSE | 1.481 | 1.513 | 2.416 | — | — |
| Bias (est − bank) | -0.197 | 0.013 | 0.000 | — | — |

Multivar Spearman 0.353 vs p-only ceiling 0.683 (need features to clear ceiling by ≫0).

### Per-fold

| Fold | n_train | n_test | ρ multivar | MAE | ρ p-only |
|------|---------|--------|------------|-----|----------|
| 1 | 25 | 1 | — | 0.515 | — |
| 2 | 25 | 1 | — | 1.278 | — |
| 3 | 25 | 1 | — | 0.552 | — |
| 4 | 25 | 1 | — | 4.188 | — |
| 5 | 25 | 1 | — | 0.355 | — |
| 6 | 25 | 1 | — | 3.647 | — |
| 7 | 25 | 1 | — | 1.730 | — |
| 8 | 25 | 1 | — | 1.077 | — |
| 9 | 25 | 1 | — | 0.100 | — |
| 10 | 25 | 1 | — | 0.044 | — |
| 11 | 25 | 1 | — | 0.891 | — |
| 12 | 25 | 1 | — | 1.144 | — |
| 13 | 25 | 1 | — | 0.213 | — |
| 14 | 25 | 1 | — | 1.823 | — |
| 15 | 25 | 1 | — | 0.883 | — |
| 16 | 25 | 1 | — | 1.281 | — |
| 17 | 25 | 1 | — | 0.149 | — |
| 18 | 25 | 1 | — | 0.204 | — |
| 19 | 25 | 1 | — | 0.957 | — |
| 20 | 25 | 1 | — | 0.634 | — |
| 21 | 25 | 1 | — | 0.603 | — |
| 22 | 25 | 1 | — | 1.840 | — |
| 23 | 25 | 1 | — | 0.786 | — |
| 24 | 25 | 1 | — | 0.708 | — |
| 25 | 25 | 1 | — | 0.669 | — |
| 26 | 25 | 1 | — | 2.183 | — |

## Sanity vs human pass rates

n = 26

- Spearman(d_est_cv, −p_human): **0.276**
- Spearman(d_bank, −p_human): 0.938

## Cross-check vs bench `item_params` (report-only)

n = 26. Spearman(d_est_cv, d_bench)=-0.353; Spearman(d_bank, d_bench)=-1.000.

## Largest |residuals| (held-out)

| item_uid | d_bank | d_est_cv | resid | p_pred | p_human | tags |
|----------|--------|----------|-------|--------|---------|------|
| tom_reference_reference | 5.730 | 1.542 | -4.188 | 0.370 | 0.222 | other |
| tom_deception_false_belief_3 | 3.885 | 0.238 | -3.647 | 0.654 | 0.483 | spatial |
| tom_second_order_false_belief_2 | 1.159 | -1.024 | -2.183 | 0.820 | 0.638 | other |
| tom_reference_emotion_reasoning_1 | -2.785 | -0.945 | 1.840 | 0.820 | 0.893 | spatial |
| tom_interpretation_reality_check_2 | -2.380 | -0.556 | 1.823 | 0.820 | 0.968 | spatial |
| tom_reality_known_false_belief | 1.007 | -0.723 | -1.730 | 0.820 | 0.675 | other |
| tom_deception_emotion_reasoning_1 | -2.235 | -0.954 | 1.281 | 0.820 | 0.912 | spatial |
| tom_deception_reality_check_2 | 5.498 | 6.775 | 1.278 | 0.500 | 0.470 | spatial |
| tom_interpretation_reality_check_1 | -1.720 | -0.575 | 1.144 | 0.820 | 0.879 | spatial |
| tom_reality_known_reality_check | -1.657 | -0.580 | 1.077 | 0.820 | 0.926 | other |
| tom_deception_false_belief_2 | 0.257 | -0.700 | -0.957 | 0.820 | 0.646 | spatial |
| tom_moral_reasoning_false_belief_2 | 0.195 | -0.696 | -0.891 | 0.820 | 0.712 | other |
| tom_interpretation_emotion_reasoning | -0.218 | -1.101 | -0.883 | 0.820 | 0.774 | spatial |
| tom_reference_emotion_reasoning_2 | -1.776 | -0.991 | 0.786 | 0.820 | 0.877 | spatial |
| tom_second_order_reality_check | -1.299 | -0.592 | 0.708 | 0.820 | 0.871 | other |

## Outputs

- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_stories_en.csv`
- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_stories_en_report.md`

## How to read this

- **Spearman(d_est_cv, d_bank)** vs **−p_pred_child**: multivar should beat the p-only ceiling when construction/Zipf features help.
- Prompt changes only move the ceiling after an ungated panel recollect + re-analyze.
