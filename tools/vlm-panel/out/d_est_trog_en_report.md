# Bank-scale difficulty estimates — trog / en

Generated: 2026-08-06T06:55:00.414Z

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
| intercept | -1.0065 |
| z | -0.9105 |
| passive | 0.0426 |
| comparative | 0.4907 |
| reverse_agent | -0.7006 |
| disjunctive | -0.4429 |
| negation | 0.6973 |
| spatial | 0.8283 |
| relative_clause | 0.2744 |

Anchors: **80** / 99. Held-out: **5-fold**.

## Held-out recovery of bank `d`

Bank `d` is difficulty-coded (higher = harder). `−p_*` columns are the p-only ranking ceiling.

| Metric | multivar d_est_cv | p-only affine CV | mean baseline | −p_vlm | −p_pred_child |
|--------|-------------------|------------------|---------------|--------|---------------|
| Spearman vs d_bank | **0.637** | 0.411 | — | 0.435 | 0.471 |
| Pearson vs d_bank | 0.471 | 0.291 | — | 0.167 | 0.270 |
| MAE | **0.822** | 1.000 | 1.107 | — | — |
| RMSE | 1.438 | 1.554 | 1.620 | — | — |
| Bias (est − bank) | -0.158 | 0.000 | 0.000 | — | — |

**Multivar beats p-only ceiling** (Δ Spearman = 0.166).

### Per-fold

| Fold | n_train | n_test | ρ multivar | MAE | ρ p-only |
|------|---------|--------|------------|-----|----------|
| 1 | 64 | 16 | 0.826 | 0.634 | 0.478 |
| 2 | 64 | 16 | 0.554 | 0.739 | 0.513 |
| 3 | 64 | 16 | 0.798 | 0.748 | 0.530 |
| 4 | 64 | 16 | 0.582 | 0.570 | 0.392 |
| 5 | 64 | 16 | 0.377 | 1.421 | 0.436 |

## Before / after (baseline snapshot)

Baseline from 2026-08-06T00:51:17.328Z:

| Metric | baseline | current | Δ |
|--------|----------|---------|---|
| Spearman multivar | 0.532 | 0.637 | 0.105 |
| Spearman −p_pred (ceiling) | 0.284 | 0.471 | 0.187 |
| MAE multivar | 0.886 | 0.822 | -0.063 |

## Sanity vs human pass rates

n = 80

- Spearman(d_est_cv, −p_human): **0.573**
- Spearman(d_bank, −p_human): 0.432

## Cross-check vs bench `item_params` (report-only)

n = 76. Spearman(d_est_cv, d_bench)=-0.615; Spearman(d_bank, d_bench)=-0.554.

## Largest |residuals| (held-out)

| item_uid | d_bank | d_est_cv | resid | p_pred | p_human | tags |
|----------|--------|----------|-------|--------|---------|------|
| trog_prepphrase_he_find_under_couch | 7.658 | -1.452 | -9.111 | 0.836 | 0.724 | spatial |
| trog_temporal_student_open_notebook_draw_tree | 2.110 | -2.120 | -4.229 | 0.836 | 0.886 | temporal |
| trog_conditional_we_picnic_if_park_sunny | 0.425 | -2.691 | -3.116 | 0.891 | 0.920 | other |
| trog_postmod_boy_chasing_horse_tall | -2.846 | -0.336 | 2.510 | 0.603 | 0.850 | relative_clause+adjective |
| trog_xnoty_boy_sit_not_eat | -0.313 | -2.476 | -2.163 | 0.931 | 0.965 | negation |
| trog_adjective_tall | -2.736 | -0.841 | 1.895 | 0.603 | 0.932 | adjective |
| trog_neither_boy_nor_horse_run | 0.026 | -1.819 | -1.845 | 0.891 | 0.895 | negation |
| trog_abovebelow_star_above_circle | 0.039 | -1.800 | -1.839 | 0.884 | 0.925 | spatial |
| trog_abovebelow_square_below_star | -3.231 | -1.532 | 1.699 | 0.884 | 0.836 | spatial |
| trog_neither_pencil_long_nor_red | -2.974 | -1.415 | 1.559 | 0.836 | 0.741 | negation+adjective |
| trog_relclause_pencil_on_book_that_yellow | -2.727 | -1.169 | 1.557 | 0.836 | 0.848 | spatial |
| trog_pluralmorph_boys_pick_apples | -1.618 | -3.130 | -1.511 | 0.931 | 0.897 | other |
| trog_comparative_box_bigger_cup | -1.373 | -2.870 | -1.497 | 0.936 | 0.956 | comparative+adjective |
| trog_additive_hose_drink_sheep_eat | -0.920 | -2.287 | -1.367 | 0.836 | 0.941 | other |
| trog_depclause_she_gardener_wear_hat_flower | -1.281 | -2.431 | -1.150 | 0.891 | 0.812 | relative_clause |

## Outputs

- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_trog_en.csv`
- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_trog_en_report.md`

## How to read this

- **Spearman(d_est_cv, d_bank)** vs **−p_pred_child**: multivar should beat the p-only ceiling when construction/Zipf features help.
- Prompt changes only move the ceiling after an ungated panel recollect + re-analyze.
