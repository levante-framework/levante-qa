# VLM → child performance: results so far

Branch: `improve-vlm-fidelity`  
Date: 2026-08-01  

Goal: use ungated VLM panels to **predict average child item pass-rates** for new
items/translations (not IRT-gated twins — those need item `d`).

## Pipeline

```
ungated VLM panel → p_vlm → monotonic calibrator f → p_pred_child
                              ↑
                    human targets (diag CSV or levante-bench trials)
```

Age columns: empirical age×item rates from bench trials when the item is known;
otherwise approximate scaling via `age_task_accuracy.json`.

## Calibration accuracy (existing panels)

Human target = levante-bench `trials.csv` aggregated `correct` (not
`proportions.csv` image1 — vocab option columns are unreliable).

| Task | Target | In-sample MAE cal / raw | Spearman cal / raw |
|------|--------|-------------------------|--------------------|
| vocab | diag | 0.117 / 0.244 | 0.629 / 0.623 |
| vocab | **bench trials** | **0.104 / 0.161** | 0.624 / 0.622 |
| trog | diag | 0.104 / 0.200 | 0.401 / 0.393 |
| trog | **bench trials** | **0.072 / 0.186** | **0.605 / 0.599** |

Held-out CV MAE stays close to in-sample (vocab bench ~0.109, trog bench ~0.078).
Diag vs bench humans still disagree somewhat (vocab MAE ~0.14; trog ~0.08).

Artifacts:

- `calibration/{vocab,trog}_en_bench.json`
- `calibration/item_pass_rates_{vocab,trog}.json`
- `calibration/age_item_rates_{vocab,trog}.json`
- `out/bench_calibration_{vocab,trog}.md`

## Residual audit (raw `p_vlm` vs human)

| Task | Mean \|p_vlm−p_human\| | Bias (vlm−human) | Pattern |
|------|------------------------|------------------|---------|
| vocab | 0.161 | **+0.15** (too easy) | Rare words (squash, divan, …) — adult lexicon |
| trog | 0.200 | **−0.10** (too hard) | Negation, reverse agent/patient, spatial, comparative |

Artifacts: `out/residuals_{vocab,trog}.{md,json}`

## Prompt / input changes (pending panel remeasure)

| Change | File | Intent |
|--------|------|--------|
| TROG grammar checklist + transcript-conditioned user hints | `cypress/support/agents/trogVlmAgent.ts` | Cut structure misses kids get right |
| Vocab “ordinary concrete sense” | `cypress/support/agents/vocabVlmAgent.ts` | Reduce exotic-sense errors |
| Default Gemini retries 6→8 | `cypress/plugins/vlmClients/gemini.ts` | Fewer TOOL dropouts |
| Residual auditor | `tools/vlm-panel/audit_residuals.mjs` | Find next prompt targets |
| Bench human loader + fit/compare | `benchHuman.mjs`, `fit_bench_calibrator.mjs` | Better `f` |

Soft age personas were **not** pursued further (already failed for age curves).

## Panel quality note

Vocab EN last analyze: **TOOL-failure ~18.5% → INCONCLUSIVE**. Nine
`gemini-2.5-flash-lite` cells failed with no trial log. Flash/pro cells completed
under **pre-prompt-fix** prompts.

## Recollect results (2026-08-01)

Finished **16:16 UTC** (~11.3 h). Log: `out/recollect.log`

| Task | Done | Failed | Notes |
|------|-----:|-------:|-------|
| vocab EN | 24 / 27 | 3 | Was 18/27; TOOL rate much improved |
| trog EN | 16 / 48 | 32 | Thin panel; many ~5 min Cypress fails (flash/pro) |

Post-recollect vs pre (bench-trial targets, in-sample):

| Task | Pre MAE cal/raw | Post MAE cal/raw | Pre ρ | Post ρ |
|------|-----------------|------------------|-------|--------|
| vocab | 0.104 / 0.161 | 0.109 / 0.168 | 0.62 | 0.60 |
| trog | 0.072 / 0.186 | 0.072 / 0.157 | 0.60 | 0.58 |

TROG **raw** error improved (~19→16 pp) with new prompts, but only 16 respondents — treat as provisional until failed cells are retried. Vocab absolute match is essentially flat (adult rare-word ceiling remains).

```bash
# Retry only missing cells (no --force):
VLM_MAX_RETRIES=8 node tools/vlm-panel/run_panel.mjs \
  --grid tools/vlm-panel/panel_grid_vocab.json --lang en-US
VLM_MAX_RETRIES=8 node tools/vlm-panel/run_panel.mjs \
  --grid tools/vlm-panel/panel_grid.json --lang en-US
```

## Recollect plan (original)

Remeasure requires new ungated runs (prompt text is baked into each respondent).

Started **2026-08-01T04:56:14Z** (vocab EN `--force` 27 cells, then TROG EN `--force` 48 cells).  
Live log: `tools/vlm-panel/out/recollect.log`

## What we did not change

- IRT Bernoulli gate / child-twins (wrong tool for new unscored items)
- Vision/MQM daily translation screen (complementary)
- Full multi-language panel recollect (EN first)
