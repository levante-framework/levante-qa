# Bank-scale difficulty estimates — trog / en

Generated: 2026-08-07T20:42:33.718Z

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
| intercept | -1.7103 |
| z | -0.5948 |
| passive | -0.2670 |
| comparative | 1.0816 |
| reverse_agent | -0.4464 |
| disjunctive | 0.2714 |
| negation | 0.9299 |
| spatial | 1.0373 |
| relative_clause | 0.4071 |

Anchors: **80** / 99. Held-out: **5-fold**.

## Held-out recovery of bank `d`

Bank `d` is difficulty-coded (higher = harder). `−p_*` columns are the p-only ranking ceiling.

| Metric | multivar d_est_cv | p-only affine CV | mean baseline | −p_vlm | −p_pred_child |
|--------|-------------------|------------------|---------------|--------|---------------|
| Spearman vs d_bank | **0.499** | 0.119 | — | 0.236 | 0.234 |
| Pearson vs d_bank | 0.334 | -0.006 | — | 0.099 | 0.107 |
| MAE | **0.915** | 1.106 | 1.107 | — | — |
| RMSE | 1.546 | 1.634 | 1.620 | — | — |
| Bias (est − bank) | -0.191 | 0.001 | 0.000 | — | — |

**Multivar beats p-only ceiling** (Δ Spearman = 0.265).

### Per-fold

| Fold | n_train | n_test | ρ multivar | MAE | ρ p-only |
|------|---------|--------|------------|-----|----------|
| 1 | 64 | 16 | 0.570 | 0.844 | 0.273 |
| 2 | 64 | 16 | 0.459 | 1.231 | 0.032 |
| 3 | 64 | 16 | 0.288 | 0.916 | 0.567 |
| 4 | 64 | 16 | 0.572 | 0.629 | 0.261 |
| 5 | 64 | 16 | 0.594 | 0.952 | 0.169 |

## Sanity vs human pass rates

n = 80

- Spearman(d_est_cv, −p_human): **0.366**
- Spearman(d_bank, −p_human): 0.432

## Cross-check vs bench `item_params` (report-only)

n = 76. Spearman(d_est_cv, d_bench)=-0.438; Spearman(d_bank, d_bench)=-0.554.

## Largest |residuals| (held-out)

| item_uid | d_bank | d_est_cv | resid | p_pred | p_human | tags |
|----------|--------|----------|-------|--------|---------|------|
| trog_prepphrase_he_find_under_couch | 7.658 | -2.025 | -9.684 | 0.908 | 0.724 | spatial |
| trog_temporal_student_open_notebook_draw_tree | 2.110 | -2.835 | -4.944 | 0.908 | 0.886 | temporal |
| trog_conditional_we_picnic_if_park_sunny | 0.425 | -2.919 | -3.345 | 0.908 | 0.920 | other |
| trog_abovebelow_star_above_circle | 0.039 | -2.025 | -2.064 | 0.908 | 0.925 | spatial |
| trog_embedding_book_pencil_on_red | -1.528 | 0.473 | 2.001 | 0.537 | 0.682 | relative_clause+spatial+adjective |
| trog_abovebelow_square_below_star | -3.231 | -1.478 | 1.753 | 0.908 | 0.836 | spatial |
| trog_neither_boy_nor_horse_run | 0.026 | -1.658 | -1.684 | 0.810 | 0.895 | negation |
| trog_adjective_red | -4.495 | -2.835 | 1.661 | 0.908 | 0.952 | adjective |
| trog_xnoty_boy_sit_not_eat | -0.313 | -1.896 | -1.583 | 0.908 | 0.965 | negation |
| trog_neither_pencil_long_nor_red | -2.974 | -1.392 | 1.582 | 0.810 | 0.741 | negation+adjective |
| trog_negative_dog_not_drink | -3.320 | -1.759 | 1.561 | 0.908 | 0.924 | negation |
| trog_pluralmorph_boy_stand_chairs | -1.373 | -2.919 | -1.547 | 0.908 | 0.841 | other |
| trog_additive_hose_drink_sheep_eat | -0.920 | -2.414 | -1.494 | 0.810 | 0.941 | other |
| trog_notonly_box_notonly_big_blue | -0.743 | -2.177 | -1.434 | 0.908 | 0.938 | negation+adjective |
| trog_negative_girl_not_jump | -3.190 | -1.818 | 1.372 | 0.908 | 0.958 | negation |

## Outputs

- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_trog_en.csv`
- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_trog_en_report.md`

## How to read this

- **Spearman(d_est_cv, d_bank)** vs **−p_pred_child**: multivar should beat the p-only ceiling when construction/Zipf features help.
- Prompt changes only move the ceiling after an ungated panel recollect + re-analyze.
