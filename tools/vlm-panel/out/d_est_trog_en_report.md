# Bank-scale difficulty estimates — trog / en

Generated: 2026-08-08T23:22:21.023Z

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
| intercept | -0.7601 |
| z | -1.0882 |
| passive | 0.1310 |
| comparative | 0.4932 |
| reverse_agent | -1.0310 |
| disjunctive | -0.5216 |
| negation | 0.6878 |
| spatial | 0.8454 |
| relative_clause | -0.1991 |

Anchors: **80** / 99. Held-out: **5-fold**.

## Held-out recovery of bank `d`

Bank `d` is difficulty-coded (higher = harder). `−p_*` columns are the p-only ranking ceiling.

| Metric | multivar d_est_cv | p-only affine CV | mean baseline | −p_vlm | −p_pred_child |
|--------|-------------------|------------------|---------------|--------|---------------|
| Spearman vs d_bank | **0.637** | 0.410 | — | 0.446 | 0.463 |
| Pearson vs d_bank | 0.465 | 0.327 | — | 0.167 | 0.298 |
| MAE | **0.843** | 1.006 | 1.107 | — | — |
| RMSE | 1.448 | 1.533 | 1.620 | — | — |
| Bias (est − bank) | -0.154 | 0.005 | 0.000 | — | — |

**Multivar beats p-only ceiling** (Δ Spearman = 0.175).

### Per-fold

| Fold | n_train | n_test | ρ multivar | MAE | ρ p-only |
|------|---------|--------|------------|-----|----------|
| 1 | 64 | 16 | 0.892 | 0.986 | 0.499 |
| 2 | 64 | 16 | 0.591 | 0.762 | 0.434 |
| 3 | 64 | 16 | 0.749 | 0.740 | 0.846 |
| 4 | 64 | 16 | 0.592 | 0.959 | 0.322 |
| 5 | 64 | 16 | 0.613 | 0.768 | 0.220 |

## Sanity vs human pass rates

n = 80

- Spearman(d_est_cv, −p_human): **0.521**
- Spearman(d_bank, −p_human): 0.320

## Cross-check vs bench `item_params` (report-only)

n = 76. Spearman(d_est_cv, d_bench)=-0.629; Spearman(d_bank, d_bench)=-0.554.

## Largest |residuals| (held-out)

| item_uid | d_bank | d_est_cv | resid | p_pred | p_human | tags |
|----------|--------|----------|-------|--------|---------|------|
| trog_prepphrase_he_find_under_couch | 7.658 | -1.568 | -9.226 | 0.829 | 0.725 | spatial |
| trog_temporal_student_open_notebook_draw_tree | 2.110 | -2.219 | -4.329 | 0.829 | 0.892 | temporal |
| trog_conditional_we_picnic_if_park_sunny | 0.425 | -2.474 | -2.900 | 0.861 | 0.917 | other |
| trog_xnoty_boy_sit_not_eat | -0.313 | -2.501 | -2.188 | 0.922 | 0.972 | negation |
| trog_abovebelow_square_below_star | -3.231 | -1.296 | 1.935 | 0.861 | 0.794 | spatial |
| trog_neither_boy_nor_horse_run | 0.026 | -1.881 | -1.907 | 0.861 | 0.895 | negation |
| trog_relclause_pencil_on_book_that_yellow | -2.727 | -0.841 | 1.886 | 0.829 | 0.792 | spatial |
| trog_neither_pencil_long_nor_red | -2.974 | -1.256 | 1.718 | 0.829 | 0.693 | negation+adjective |
| trog_abovebelow_star_above_circle | 0.039 | -1.648 | -1.687 | 0.861 | 0.925 | spatial |
| trog_notonly_box_notonly_big_blue | -0.743 | -2.380 | -1.637 | 0.904 | 0.927 | negation+adjective |
| trog_comparative_box_bigger_cup | -1.373 | -2.844 | -1.472 | 0.922 | 0.963 | comparative+adjective |
| trog_pluralmorph_boys_pick_apples | -1.618 | -3.089 | -1.470 | 0.909 | 0.892 | other |
| trog_depclause_she_gardener_wear_hat_flower | -1.281 | -2.625 | -1.344 | 0.861 | 0.808 | relative_clause |
| trog_comparative_fork_longer_pencil | -2.212 | -0.918 | 1.294 | 0.829 | 0.874 | comparative |
| trog_revactive_girl_push_horse | -3.005 | -4.207 | -1.202 | 0.904 | 0.936 | reverse_agent |

## Outputs

- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_trog_en.csv`
- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_trog_en_report.md`

## How to read this

- **Spearman(d_est_cv, d_bank)** vs **−p_pred_child**: multivar should beat the p-only ceiling when construction/Zipf features help.
- Prompt changes only move the ceiling after an ungated panel recollect + re-analyze.
