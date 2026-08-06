# Bank-scale difficulty estimates — trog / en

Generated: 2026-08-06T00:22:27.156Z

## Inputs

- Screen: `/home/david/levante/levante-qa/tools/vlm-panel/out/screen_en_prompt_eval.csv` (99 items)
- Bank: `/home/david/levante/levante-qa/cypress/cache/sim-item-bank-trog.csv` (99 rows)
- Bench item_params: `/home/david/levante/levante-bench/data/responses/v2/irt_models/trog_item_params.csv` (89 d)

## Model (hybrid v2)

Robust multivariate: standardized features → ridge (λ=0.01) + Huber IRLS. Features:

- `z`, `passive`, `comparative`, `reverse_agent`, `disjunctive`, `negation`, `spatial`, `relative_clause`

Coefficients (raw / unstandardized):

| feature | coef |
|---------|------|
| intercept | -1.9599 |
| z | -0.5190 |
| passive | 0.2079 |
| comparative | 1.1630 |
| reverse_agent | -0.2808 |
| disjunctive | 0.3528 |
| negation | 1.0586 |
| spatial | 1.2199 |
| relative_clause | 0.5034 |

Anchors: **80** / 99. Held-out: **5-fold**.

## Held-out recovery of bank `d`

Bank `d` is difficulty-coded (higher = harder). `−p_*` columns are the p-only ranking ceiling.

| Metric | multivar d_est_cv | p-only affine CV | mean baseline | −p_vlm | −p_pred_child |
|--------|-------------------|------------------|---------------|--------|---------------|
| Spearman vs d_bank | **0.478** | 0.148 | — | 0.199 | 0.211 |
| Pearson vs d_bank | 0.313 | 0.079 | — | 0.133 | 0.135 |
| MAE | **0.937** | 1.101 | 1.107 | — | — |
| RMSE | 1.564 | 1.624 | 1.620 | — | — |
| Bias (est − bank) | -0.222 | 0.006 | -0.000 | — | — |

**Multivar beats p-only ceiling** (Δ Spearman = 0.267).

### Per-fold

| Fold | n_train | n_test | ρ multivar | MAE | ρ p-only |
|------|---------|--------|------------|-----|----------|
| 1 | 64 | 16 | 0.363 | 1.048 | 0.079 |
| 2 | 64 | 16 | 0.619 | 0.674 | 0.108 |
| 3 | 64 | 16 | 0.411 | 1.039 | 0.389 |
| 4 | 64 | 16 | 0.629 | 1.100 | 0.271 |
| 5 | 64 | 16 | 0.590 | 0.825 | 0.262 |

## Before / after (baseline snapshot)

Baseline from 2026-08-05T23:19:42.872Z:

| Metric | baseline | current | Δ |
|--------|----------|---------|---|
| Spearman multivar | 0.532 | 0.478 | -0.054 |
| Spearman −p_pred (ceiling) | 0.284 | 0.211 | -0.073 |
| MAE multivar | 0.886 | 0.937 | 0.052 |

## Sanity vs human pass rates

n = 80

- Spearman(d_est_cv, −p_human): **0.416**
- Spearman(d_bank, −p_human): 0.432

## Cross-check vs bench `item_params` (report-only)

n = 76. Spearman(d_est_cv, d_bench)=-0.469; Spearman(d_bank, d_bench)=-0.554.

## Largest |residuals| (held-out)

| item_uid | d_bank | d_est_cv | resid | p_pred | p_human | tags |
|----------|--------|----------|-------|--------|---------|------|
| trog_prepphrase_he_find_under_couch | 7.658 | -1.767 | -9.426 | 0.821 | 0.724 | spatial |
| trog_temporal_student_open_notebook_draw_tree | 2.110 | -3.056 | -5.166 | 0.905 | 0.886 | temporal |
| trog_conditional_we_picnic_if_park_sunny | 0.425 | -2.728 | -3.154 | 0.821 | 0.920 | other |
| trog_postmod_boy_chasing_horse_tall | -2.846 | -0.123 | 2.723 | 0.470 | 0.850 | relative_clause+adjective |
| trog_neither_boy_nor_horse_run | 0.026 | -2.343 | -2.369 | 0.905 | 0.895 | negation |
| trog_abovebelow_square_below_star | -3.231 | -1.150 | 2.081 | 0.821 | 0.836 | spatial |
| trog_abovebelow_star_above_circle | 0.039 | -2.020 | -2.059 | 0.905 | 0.925 | spatial |
| trog_additive_hose_drink_sheep_eat | -0.920 | -2.683 | -1.763 | 0.821 | 0.941 | other |
| trog_pluralmorph_boy_stand_chairs | -1.373 | -3.002 | -1.630 | 0.905 | 0.841 | other |
| trog_neither_pencil_long_nor_red | -2.974 | -1.368 | 1.606 | 0.821 | 0.741 | negation+adjective |
| trog_xnoty_boy_sit_not_eat | -0.313 | -1.909 | -1.596 | 0.905 | 0.965 | negation |
| trog_adjective_red | -4.495 | -2.907 | 1.588 | 0.905 | 0.952 | adjective |
| trog_negative_dog_not_drink | -3.320 | -1.745 | 1.575 | 0.905 | 0.924 | negation |
| trog_xnoty_horse_not_boy_stand | -0.228 | -1.697 | -1.469 | 0.751 | 0.752 | negation |
| trog_negative_girl_not_jump | -3.190 | -1.734 | 1.457 | 0.905 | 0.958 | negation |

## Outputs

- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_trog_en.csv`
- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_trog_en_report.md`

## How to read this

- **Spearman(d_est_cv, d_bank)** vs **−p_pred_child**: multivar should beat the p-only ceiling when construction/Zipf features help.
- Prompt changes only move the ceiling after an ungated panel recollect + re-analyze.
