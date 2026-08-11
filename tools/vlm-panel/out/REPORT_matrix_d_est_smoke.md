# Matrix Reasoning — first AI `d_est` smoke (research)

**Date:** 2026-08-10 (panel overnight → analyze 2026-08-11 UTC)  
**Task id:** `matrix` (bank: matrix-reasoning; UIDs `matrix_set*_…`)  
**Goal:** Research whether VLM panel + hybrid `d_est` recovers established bank `difficulty` for human researchers. **Not** GCS promote.

## What we wired

1. [`analyze.mjs`](../analyze.mjs) `TASKS.matrix` — identity = `stimulusAlt` (= bank `item_id`); `joinByItemId` (shared prompt audio/text must not be the join key).
2. [`benchHuman.mjs`](../benchHuman.mjs) `matrix → matrix-reasoning`.
3. [`estimate_difficulty.mjs`](../estimate_difficulty.mjs) / [`apply_d_est_prior.mjs`](../apply_d_est_prior.mjs) — bank `difficulty` anchors; features = `z` only.
4. Smoke grid: [`panel_grid_matrix_smoke.json`](../panel_grid_matrix_smoke.json) — 2 models × 3 ages × 1 temp × 1 rep = **6 cells**, `--live`.

## Panel

| Cell | Result |
|------|--------|
| `35flashlite` a6/a8/a11 | done (~6–10 min each) |
| `36flash` a6/a8/a11 | done (~17 min each) |
| Failures | **0 / 6** |

## Join + screen

| Metric | Value |
|--------|-------|
| Respondents | 6 |
| Items | 80 |
| With `item_uid` | **78 / 80** (2 practice rows lack bank uid) |
| Flags | BROKEN **11** / HARD **19** / OK **41** / CEILING **9** |
| ρ(`p_vlm`, bench `p_human`) | **0.26** |
| MAE cal / raw | **0.10** / 0.22 |

## `d_est` vs bank `difficulty`

| Metric | Value |
|--------|-------|
| Anchors | **75** |
| Spearman ρ_multivar (held-out) | **0.196** |
| ρ p-only affine | 0.183 |
| Ranking ceiling −`p_pred` | **0.282** |
| MAE | 0.837 |

Hybrid does **not** beat the weak p-only ceiling. −`p_pred` ranking vs bank is still only ~0.28 — far below TROG (~0.64) / vocab (~0.65).

Draft prior fill (secondary): preserved **75**, filled **3**, blank_no_match **2** (`out/item_bank_matrix_en_d_est_prior.csv`).

## How to read this

- **Pipeline GO:** stimulusAlt → `item_uid` join works; bench calibrator + estimate run end-to-end.
- **Research signal NO-GO (smoke):** AI rankings do not yet usefully recover matrix bank `d` on this 6-cell panel. Weak VLM↔human pass-rate ρ (~0.26) is the bottleneck, not the hybrid mapper.
- Bench `item_params` vs bank `difficulty` also disagree in sign/scale on this slice (Spearman ≈ −0.30) — treat bank `difficulty` as the research target for now; don’t mix scales casually.

## Artifacts

- `out/screen_matrix_en.csv`, `out/report_matrix.md`
- `out/bench_calibration_matrix.md`, `calibration/matrix_en_bench.json`
- `out/d_est_matrix_en.csv`, `out/d_est_matrix_en_report.md`
- `out/d_est_prior_report_matrix_en.md`

## Next (if continuing)

- Denser panel (temps / repeats) only if you want stabler `p_vlm`; don’t expect TROG-level ρ without better age/model spread or matrix-specific prompting.
- Same wiring pattern can clone to mental rotation once matrix research questions are settled.
