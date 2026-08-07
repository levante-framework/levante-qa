# ICC difficulty from panel θ grid — trog / en

Generated: 2026-08-07T00:26:30.301Z

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
| 13 | -0.1508 |

Runs used: **80** (skipped no-θ: 0, no-log: 0). Items: **99**. Reliable anchors: **70**. Unreliable fits: **17**.

## Held-out recovery of bank `d`

| Metric | d_icc CV (linked) | −p_vlm | −p_pred_child | multivar d_est (prior) |
|--------|-------------------|--------|---------------|------------------------|
| Spearman vs d_bank | **0.054** | 0.210 | 0.253 | 0.637 |
| MAE | **1.074** | — | — | 0.822 |
| Pearson | -0.050 | — | — | — |
| Spearman(d_icc raw, d_bank) | 0.210 | — | — | — |

Linked ICC does **not** beat −p_pred ceiling (Δ Spearman = -0.199). Flat or weakly ordered VLM×age curves limit identification.

## Fold metrics

| Fold | n_train | n_test | ρ | MAE |
|------|---------|--------|---|-----|
| 1 | 56 | 14 | 0.534 | 0.879 |
| 2 | 56 | 14 | 0.328 | 1.373 |
| 3 | 56 | 14 | -0.319 | 1.198 |
| 4 | 56 | 14 | 0.130 | 0.751 |
| 5 | 56 | 14 | 0.293 | 1.169 |

## Link coefficients (full-sample)

`d_linked = -1.5429 + 0.1191 · d_icc`

## Notes

- `d_icc` is identified from persona-θ labels, not true child ability draws.
- All-correct / all-incorrect / boundary fits are marked unreliable and excluded from anchors.
- Artifacts: `/home/david/levante/levante-qa/tools/vlm-panel/out/d_icc_trog_en.csv`, `/home/david/levante/levante-qa/tools/vlm-panel/out/d_icc_trog_en_metrics.json`.
