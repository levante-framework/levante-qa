# Bank-scale difficulty estimates — vocab / en

Generated: 2026-08-05T23:19:42.937Z

## Inputs

- Screen: `/home/david/levante/levante-qa/tools/vlm-panel/out/screen_vocab_en.csv` (170 items)
- Bank: `/home/david/levante/levante-qa/cypress/cache/sim-item-bank-vocab.csv` (173 rows)
- Bench item_params: `/home/david/levante/levante-bench/data/responses/v2/irt_models/vocab_item_params.csv` (144 d)
- Zipf lexicon: `/home/david/levante/levante-qa/tools/vlm-panel/vocab_lexicon.json` (median fill 3.41)

## Model (hybrid v2)

Robust multivariate: standardized features → ridge (λ=0.01) + Huber IRLS. Features:

- `z`, `zipf`, `rare`

Coefficients (raw / unstandardized):

| feature | coef |
|---------|------|
| intercept | 1.7278 |
| z | -1.1401 |
| zipf | -0.5739 |
| rare | -0.3161 |

Anchors: **126** / 170. Held-out: **5-fold**.

## Held-out recovery of bank `d`

Bank `d` is difficulty-coded (higher = harder). `−p_*` columns are the p-only ranking ceiling.

| Metric | multivar d_est_cv | p-only affine CV | mean baseline | −p_vlm | −p_pred_child |
|--------|-------------------|------------------|---------------|--------|---------------|
| Spearman vs d_bank | **0.613** | 0.624 | — | 0.650 | 0.661 |
| Pearson vs d_bank | 0.469 | 0.387 | — | 0.538 | 0.656 |
| MAE | **1.399** | 1.473 | 1.662 | — | — |
| RMSE | 1.982 | 2.095 | 2.045 | — | — |
| Bias (est − bank) | 0.032 | 0.052 | -0.000 | — | — |

Multivar Spearman 0.613 vs p-only ceiling 0.661 (need features to clear ceiling by ≫0).

### Per-fold

| Fold | n_train | n_test | ρ multivar | MAE | ρ p-only |
|------|---------|--------|------------|-----|----------|
| 1 | 100 | 26 | 0.675 | 1.697 | 0.750 |
| 2 | 101 | 25 | 0.610 | 1.295 | 0.596 |
| 3 | 101 | 25 | 0.655 | 1.350 | 0.677 |
| 4 | 101 | 25 | 0.592 | 1.190 | 0.616 |
| 5 | 101 | 25 | 0.560 | 1.449 | 0.672 |

## Sanity vs human pass rates

n = 126

- Spearman(d_est_cv, −p_human): **0.551**
- Spearman(d_bank, −p_human): 0.707

## Cross-check vs bench `item_params` (report-only)

n = 125. Spearman(d_est_cv, d_bench)=-0.643; Spearman(d_bank, d_bench)=-0.935.

## Largest |residuals| (held-out)

| item_uid | d_bank | d_est_cv | resid | p_pred | p_human | tags |
|----------|--------|----------|-------|--------|---------|------|
| vocab_word_claw | 1.220 | 14.388 | 13.168 | 0.250 | 0.089 | rare_vocab |
| vocab_word_skimmer | 4.550 | -0.268 | -4.818 | 0.630 | 0.484 | rare_vocab |
| vocab_word_urban | 2.912 | -1.420 | -4.332 | 0.700 | 0.906 | rare_vocab |
| vocab_word_facade | 4.441 | 0.620 | -3.822 | 0.442 | 0.611 | rare_vocab |
| vocab_word_gesticulate | 3.694 | -0.024 | -3.718 | 0.675 | 0.562 | rare_vocab |
| vocab_word_lollipop | -5.608 | -2.162 | 3.446 | 0.879 | 0.962 | rare_vocab |
| vocab_word_habit | 2.108 | -1.123 | -3.231 | 0.654 | 0.509 | rare_vocab |
| vocab_word_cheese | -0.072 | -2.909 | -2.837 | 0.879 | 0.738 | rare_vocab |
| vocab_word_triad | 2.190 | -0.601 | -2.792 | 0.654 | 0.507 | rare_vocab |
| vocab_word_percussion | 1.928 | -0.665 | -2.593 | 0.654 | 0.515 | rare_vocab |
| vocab_word_timid | 2.165 | -0.417 | -2.583 | 0.715 | 0.834 | rare_vocab |
| vocab_word_irrigation | 1.692 | -0.867 | -2.559 | 0.700 | 0.750 | rare_vocab |
| vocab_word_bear | -4.513 | -2.049 | 2.464 | 0.879 | 0.988 | rare_vocab |
| vocab_word_cornbread | -2.663 | -0.322 | 2.340 | 0.690 | 0.821 | rare_vocab |
| vocab_word_pitcher | -0.097 | -2.393 | -2.296 | 0.879 | 0.829 | rare_vocab |

## Outputs

- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_vocab_en.csv`
- `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_vocab_en_report.md`

## How to read this

- **Spearman(d_est_cv, d_bank)** vs **−p_pred_child**: multivar should beat the p-only ceiling when construction/Zipf features help.
- Prompt changes only move the ceiling after an ungated panel recollect + re-analyze.
