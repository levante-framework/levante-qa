# Bank-scale difficulty estimates — trog / en

Generated: 2026-08-08T21:05:36.099Z

## Inputs

- Screen: `/home/david/levante/levante-qa/tools/vlm-panel/out/screen_en.csv` (99 items)
- Bank: `/home/david/levante/levante-qa/cypress/cache/sim-item-bank-trog.csv` (99 rows)
- Bench item_params: `/home/david/levante/levante-bench/data/responses/v2/irt_models/trog_item_params.csv` (89 d)

## Model (hybrid v2)

Robust multivariate: standardized features → ridge (λ=0.01) + Huber IRLS. Features:

- `z`, `passive`, `comparative`, `reverse_agent`, `disjunctive`, `negation`, `spatial`, `relative_clause`

Coefficients (raw / unstandardized):

| feature | coef |
|---------|------|
| intercept | -0.9634 |
| z | -0.9069 |
| passive | 0.0834 |
| comparative | 0.5059 |
| reverse_agent | -0.8122 |
| disjunctive | -0.4977 |
| negation | 0.6435 |
| spatial | 0.8269 |
| relative_clause | 0.0611 |

Anchors: **80** / 99. Held-out: **5-fold**.

## Held-out recovery of bank `d`

Bank `d` is difficulty-coded (higher = harder). `−p_*` columns are the p-only ranking ceiling.

| Metric | multivar d_est_cv | p-only affine CV | mean baseline | −p_vlm | −p_pred_child |
|--------|-------------------|------------------|---------------|--------|---------------|
| Spearman vs d_bank | **0.647** | 0.404 | — | 0.444 | 0.456 |
| Pearson vs d_bank | 0.495 | 0.341 | — | 0.165 | 0.315 |
| MAE | **0.833** | 0.969 | 1.107 | — | — |
| RMSE | 1.422 | 1.524 | 1.620 | — | — |
| Bias (est − bank) | -0.196 | -0.000 | 0.000 | — | — |

**Multivar beats p-only ceiling** (Δ Spearman = 0.191).

### Per-fold

| Fold | n_train | n_test | ρ multivar | MAE | ρ p-only |
|------|---------|--------|------------|-----|----------|
| 1 | 64 | 16 | 0.480 | 1.339 | 0.303 |
| 2 | 64 | 16 | 0.713 | 0.911 | 0.619 |
| 3 | 64 | 16 | 0.668 | 0.739 | 0.776 |
| 4 | 64 | 16 | 0.729 | 0.598 | 0.204 |
| 5 | 64 | 16 | 0.664 | 0.577 | 0.352 |

## Sanity vs human pass rates

n = 80

- Spearman(d_est_cv, −p_human): **0.608**
- Spearman(d_bank, −p_human): 0.432

## Cross-check vs bench `item_params` (report-only)

n = 76. Spearman(d_est_cv, d_bench)=-0.669; Spearman(d_bank, d_bench)=-0.554.

## Largest |residuals| (held-out)

| item_uid | d_bank | d_est_cv | resid | p_pred | p_human | tags |
|----------|--------|----------|-------|--------|---------|------|
| trog_prepphrase_he_find_under_couch | 7.658 | -1.375 | -9.033 | 0.835 | 0.724 | spatial |
| trog_temporal_student_open_notebook_draw_tree | 2.110 | -2.248 | -4.357 | 0.835 | 0.886 | temporal |
| trog_conditional_we_picnic_if_park_sunny | 0.425 | -2.896 | -3.321 | 0.913 | 0.920 | other |
| trog_xnoty_boy_sit_not_eat | -0.313 | -2.429 | -2.117 | 0.931 | 0.965 | negation |
| trog_neither_boy_nor_horse_run | 0.026 | -1.825 | -1.851 | 0.879 | 0.895 | negation |
| trog_abovebelow_square_below_star | -3.231 | -1.409 | 1.822 | 0.879 | 0.836 | spatial |
| trog_comparative_box_bigger_cup | -1.373 | -2.988 | -1.616 | 0.936 | 0.956 | comparative+adjective |
| trog_abovebelow_star_above_circle | 0.039 | -1.564 | -1.603 | 0.879 | 0.925 | spatial |
| trog_pluralmorph_boys_pick_apples | -1.618 | -3.217 | -1.599 | 0.931 | 0.897 | other |
| trog_relclause_pencil_on_book_that_yellow | -2.727 | -1.201 | 1.526 | 0.835 | 0.848 | spatial |
| trog_neither_pencil_long_nor_red | -2.974 | -1.466 | 1.508 | 0.835 | 0.741 | negation+adjective |
| trog_notonly_box_notonly_big_blue | -0.743 | -2.233 | -1.490 | 0.913 | 0.938 | negation+adjective |
| trog_additive_hose_drink_sheep_eat | -0.920 | -2.206 | -1.286 | 0.835 | 0.941 | other |
| trog_depclause_she_gardener_wear_hat_flower | -1.281 | -2.492 | -1.212 | 0.879 | 0.812 | relative_clause |
| trog_adjective_red | -4.495 | -3.364 | 1.131 | 0.955 | 0.952 | adjective |

## Outputs

- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_trog_en.csv`
- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_trog_en_report.md`

## How to read this

- **Spearman(d_est_cv, d_bank)** vs **−p_pred_child**: multivar should beat the p-only ceiling when construction/Zipf features help.
- Prompt changes only move the ceiling after an ungated panel recollect + re-analyze.
