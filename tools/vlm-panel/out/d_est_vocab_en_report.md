# Bank-scale difficulty estimates — vocab / en

Generated: 2026-08-10T23:09:51.738Z

## Inputs

- Screen: `/home/david/levante/levante-qa/tools/vlm-panel/out/screen_vocab_en.csv` (170 items)
- Bank: `/home/david/levante/levante-qa/cypress/cache/sim-item-bank-vocab.csv` (173 rows)
- Bench item_params: `/home/david/levante/levante-bench/data/responses/v2/irt_models/vocab_item_params.csv` (288 d)
- Zipf lexicon: `/home/david/levante/levante-qa/tools/vlm-panel/vocab_lexicon.json` (median fill 3.41)

## Model (hybrid v2)

Robust multivariate: standardized features → ridge (λ=0.01) + Huber IRLS. Features:

- `z`, `zipf`, `rare`

Coefficients (raw / unstandardized):

| feature | coef |
|---------|------|
| intercept | 1.4784 |
| z | -1.5698 |
| zipf | -0.4173 |
| rare | -0.6345 |

Anchors: **126** / 170. Held-out: **5-fold**.

## Held-out recovery of bank `d`

Bank `d` is difficulty-coded (higher = harder). `−p_*` columns are the p-only ranking ceiling.

| Metric | multivar d_est_cv | p-only affine CV | mean baseline | −p_vlm | −p_pred_child |
|--------|-------------------|------------------|---------------|--------|---------------|
| Spearman vs d_bank | **0.653** | 0.634 | — | 0.763 | 0.746 |
| Pearson vs d_bank | 0.483 | 0.383 | — | 0.721 | 0.731 |
| MAE | **1.302** | 1.410 | 1.662 | — | — |
| RMSE | 2.184 | 2.287 | 2.045 | — | — |
| Bias (est − bank) | 0.074 | 0.082 | -0.000 | — | — |

Multivar Spearman 0.653 vs p-only ceiling 0.746 (need features to clear ceiling by ≫0).

### Per-fold

| Fold | n_train | n_test | ρ multivar | MAE | ρ p-only |
|------|---------|--------|------------|-----|----------|
| 1 | 100 | 26 | 0.766 | 1.727 | 0.685 |
| 2 | 101 | 25 | 0.765 | 1.350 | 0.751 |
| 3 | 101 | 25 | 0.662 | 1.250 | 0.859 |
| 4 | 101 | 25 | 0.668 | 1.197 | 0.736 |
| 5 | 101 | 25 | 0.526 | 0.968 | 0.645 |

## Sanity vs human pass rates

n = 126

- Spearman(d_est_cv, −p_human): **0.516**
- Spearman(d_bank, −p_human): 0.627

## Cross-check vs bench `item_params` (report-only)

n = 125. Spearman(d_est_cv, d_bench)=-0.653; Spearman(d_bank, d_bench)=-0.935.

## Largest |residuals| (held-out)

| item_uid | d_bank | d_est_cv | resid | p_pred | p_human | tags |
|----------|--------|----------|-------|--------|---------|------|
| vocab_word_claw | 1.220 | 19.436 | 18.216 | 0.250 | 0.092 | rare_vocab |
| vocab_word_skimmer | 4.550 | -0.195 | -4.745 | 0.603 | 0.333 | rare_vocab |
| vocab_word_facade | 4.441 | 0.009 | -4.432 | 0.604 | 0.621 | rare_vocab |
| vocab_word_urban | 2.912 | -1.128 | -4.040 | 0.662 | 0.836 | rare_vocab |
| vocab_word_lollipop | -5.608 | -1.910 | 3.698 | 0.856 | 0.931 | rare_vocab |
| vocab_word_cheese | -0.072 | -2.715 | -2.643 | 0.856 | 0.712 | rare_vocab |
| vocab_word_fruitcake | -2.747 | -0.137 | 2.610 | 0.636 | 0.916 | rare_vocab |
| vocab_word_timid | 2.165 | -0.382 | -2.547 | 0.662 | 0.841 | rare_vocab |
| vocab_word_gourmet | -1.916 | 0.624 | 2.540 | 0.604 | 0.619 | rare_vocab |
| vocab_word_pitcher | -0.097 | -2.619 | -2.522 | 0.856 | 0.866 | rare_vocab |
| vocab_word_habit | 2.108 | -0.343 | -2.451 | 0.604 | 0.503 | rare_vocab |
| vocab_word_ball | -4.447 | -2.017 | 2.430 | 0.856 | 0.936 | rare_vocab |
| vocab_word_scaffolding | -0.162 | -2.560 | -2.398 | 0.856 | 0.721 | rare_vocab |
| vocab_word_gesticulate | 3.694 | 1.303 | -2.391 | 0.465 | 0.564 | rare_vocab |
| vocab_word_bear | -4.513 | -2.145 | 2.368 | 0.856 | 0.957 | rare_vocab |

## Outputs

- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_vocab_en.csv`
- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_vocab_en_report.md`

## How to read this

- **Spearman(d_est_cv, d_bank)** vs **−p_pred_child**: multivar should beat the p-only ceiling when construction/Zipf features help.
- Prompt changes only move the ceiling after an ungated panel recollect + re-analyze.
