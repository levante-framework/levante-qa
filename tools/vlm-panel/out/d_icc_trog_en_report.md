# ICC difficulty from panel θ grid — trog / en

Generated: 2026-08-08T23:22:21.147Z

## Model

Fixed-guessing Rasch ICC on ungated panel trials:

$$P(\mathrm{correct}\mid\theta) = c + (1-c)\,\sigma(\theta - d_{\mathrm{icc}})$$

- θ = mean child ability for the run’s persona age ([age_task_ability.json](/home/david/levante/levante-qa/cypress/support/persona/age_task_ability.json))
- c = bank `chance_level` (default 0.25)
- Bank link: held-out CV affine `d_icc_cv = α + β · d_icc`

## θ grid used

| age | θ |
|-----|---|
| 6 | -2.0140 |
| 8 | -0.9061 |
| 10 | -0.4399 |
| 12 | -0.2238 |
| 13 | -0.1508 |

Runs used: **88** (skipped no-θ: 0, no-log: 1). Items: **99**. Reliable anchors: **70**. Unreliable fits: **16**.

## Held-out recovery of bank `d`

| Metric | d_icc CV (linked) | −p_vlm | −p_pred_child | multivar d_est (prior) |
|--------|-------------------|--------|---------------|------------------------|
| Spearman vs d_bank | **0.080** | 0.226 | 0.246 | 0.637 |
| MAE | **1.065** | — | — | 0.843 |
| Pearson | -0.033 | — | — | — |
| Spearman(d_icc raw, d_bank) | 0.221 | — | — | — |

Linked ICC does **not** beat −p_pred ceiling (Δ Spearman = -0.166). Flat or weakly ordered VLM×age curves limit identification.

## Fold metrics

| Fold | n_train | n_test | ρ | MAE |
|------|---------|--------|---|-----|
| 1 | 56 | 14 | 0.560 | 0.876 |
| 2 | 56 | 14 | 0.297 | 1.359 |
| 3 | 56 | 14 | -0.244 | 1.175 |
| 4 | 56 | 14 | 0.323 | 0.739 |
| 5 | 56 | 14 | 0.301 | 1.175 |

## Link coefficients (full-sample)

`d_linked = -1.5589 + 0.1152 · d_icc`

## Notes

- `d_icc` is identified from persona-θ labels, not true child ability draws.
- All-correct / all-incorrect / boundary fits are marked unreliable and excluded from anchors.
- Artifacts: `/home/david/levante/levante-qa/tools/vlm-panel/out/d_icc_trog_en.csv`, `/home/david/levante/levante-qa/tools/vlm-panel/out/d_icc_trog_en_metrics.json`.
