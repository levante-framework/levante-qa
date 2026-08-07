# ICC difficulty from panel θ grid — trog / en

Generated: 2026-08-07T01:39:29.056Z

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

Runs used: **79** (skipped no-θ: 0, no-log: 0). Items: **99**. Reliable anchors: **70**. Unreliable fits: **17**.

## Held-out recovery of bank `d`

| Metric | d_icc CV (linked) | −p_vlm | −p_pred_child | multivar d_est (prior) |
|--------|-------------------|--------|---------------|------------------------|
| Spearman vs d_bank | **0.062** | 0.207 | 0.270 | 0.637 |
| MAE | **1.069** | — | — | 0.822 |
| Pearson | -0.025 | — | — | — |
| Spearman(d_icc raw, d_bank) | 0.207 | — | — | — |

Linked ICC does **not** beat −p_pred ceiling (Δ Spearman = -0.208). Flat or weakly ordered VLM×age curves limit identification.

## Fold metrics

| Fold | n_train | n_test | ρ | MAE |
|------|---------|--------|---|-----|
| 1 | 56 | 14 | 0.534 | 0.875 |
| 2 | 56 | 14 | 0.284 | 1.371 |
| 3 | 56 | 14 | -0.266 | 1.188 |
| 4 | 56 | 14 | 0.156 | 0.743 |
| 5 | 56 | 14 | 0.293 | 1.166 |

## Link coefficients (full-sample)

`d_linked = -1.5290 + 0.1275 · d_icc`

## Notes

- `d_icc` is identified from persona-θ labels, not true child ability draws.
- All-correct / all-incorrect / boundary fits are marked unreliable and excluded from anchors.
- Artifacts: `/home/david/levante/levante-qa/tools/vlm-panel/out/d_icc_trog_en.csv`, `/home/david/levante/levante-qa/tools/vlm-panel/out/d_icc_trog_en_metrics.json`.
