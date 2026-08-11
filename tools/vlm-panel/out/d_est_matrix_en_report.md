# Bank-scale difficulty estimates — matrix / en

Generated: 2026-08-11T02:52:55.001Z

## Inputs

- Screen: `/home/david/levante/levante-qa/tools/vlm-panel/out/screen_matrix_en.csv` (78 items)
- Bank: `/home/david/levante/levante-qa/cypress/cache/sim-item-bank-matrix-reasoning.csv` (78 rows)
- Bench item_params: `/home/david/levante/levante-bench/data/responses/v2/irt_models/matrix-reasoning_item_params.csv` (153 d)

## Model (hybrid v2)

Robust multivariate: standardized features → ridge (λ=0.01) + Huber IRLS. Features:

- `z`

Coefficients (raw / unstandardized):

| feature | coef |
|---------|------|
| intercept | 0.4682 |
| z | -0.1131 |

Anchors: **75** / 78. Held-out: **5-fold**.

## Held-out recovery of bank `d`

Bank `d` is difficulty-coded (higher = harder). `−p_*` columns are the p-only ranking ceiling.

| Metric | multivar d_est_cv | p-only affine CV | mean baseline | −p_vlm | −p_pred_child |
|--------|-------------------|------------------|---------------|--------|---------------|
| Spearman vs d_bank | **0.196** | 0.183 | — | 0.284 | 0.282 |
| Pearson vs d_bank | 0.186 | 0.183 | — | 0.292 | 0.316 |
| MAE | **0.837** | 0.833 | 0.832 | — | — |
| RMSE | 1.054 | 1.053 | 1.068 | — | — |
| Bias (est − bank) | -0.013 | -0.001 | 0.000 | — | — |

Multivar Spearman 0.196 vs p-only ceiling 0.282 (need features to clear ceiling by ≫0).

### Per-fold

| Fold | n_train | n_test | ρ multivar | MAE | ρ p-only |
|------|---------|--------|------------|-----|----------|
| 1 | 60 | 15 | 0.437 | 0.665 | 0.437 |
| 2 | 60 | 15 | -0.077 | 0.601 | -0.077 |
| 3 | 60 | 15 | 0.694 | 0.997 | 0.694 |
| 4 | 60 | 15 | 0.314 | 0.762 | 0.314 |
| 5 | 60 | 15 | 0.093 | 1.162 | 0.093 |

## Sanity vs human pass rates

n = 75

- Spearman(d_est_cv, −p_human): **0.277**
- Spearman(d_bank, −p_human): 0.133

## Cross-check vs bench `item_params` (report-only)

n = 75. Spearman(d_est_cv, d_bench)=-0.302; Spearman(d_bank, d_bench)=-0.298.

## Largest |residuals| (held-out)

| item_uid | d_bank | d_est_cv | resid | p_pred | p_human | tags |
|----------|--------|----------|-------|--------|---------|------|
| matrix_set1_md_mat51 | 3.636 | 0.802 | -2.834 | 0.303 | 0.407 | other |
| matrix_set1_md_mat78 | -1.870 | 0.693 | 2.563 | 0.337 | 0.210 | other |
| matrix_set1_md_mat59 | -0.737 | 1.529 | 2.266 | 0.250 | 0.123 | other |
| matrix_set1_md_mat44 | 2.971 | 0.706 | -2.265 | 0.366 | 0.233 | other |
| matrix_set1_md_mat26 | -1.328 | 0.799 | 2.127 | 0.287 | 0.206 | other |
| matrix_set1_md_mat19 | 2.867 | 0.799 | -2.068 | 0.287 | 0.447 | other |
| matrix_set1_md_mat77 | 2.754 | 0.768 | -1.986 | 0.287 | 0.461 | other |
| matrix_set1_md_mat5 | -1.301 | 0.500 | 1.801 | 0.660 | 0.836 | other |
| matrix_set1_md_mat12 | 3.029 | 1.268 | -1.761 | 0.250 | 0.132 | other |
| matrix_set1_md_mat13 | 2.385 | 0.768 | -1.617 | 0.287 | 0.244 | other |
| matrix_set1_md_mat61 | -0.737 | 0.802 | 1.539 | 0.303 | 0.336 | other |
| matrix_set1_md_mat74 | 2.237 | 0.852 | -1.385 | 0.287 | 0.181 | other |
| matrix_set1_md_mat65 | -0.367 | 0.852 | 1.219 | 0.287 | 0.404 | other |
| matrix_set1_md_mat2 | -0.741 | 0.471 | 1.212 | 0.660 | 0.783 | other |
| matrix_set1_md_mat49 | 0.399 | 1.610 | 1.211 | 0.250 | 0.447 | other |

## Outputs

- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_matrix_en.csv`
- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_matrix_en_report.md`

## How to read this

- **Spearman(d_est_cv, d_bank)** vs **−p_pred_child**: multivar should beat the p-only ceiling when construction/Zipf features help.
- Prompt changes only move the ceiling after an ungated panel recollect + re-analyze.
