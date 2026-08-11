# Stories (ToM) EN force recollect — research refresh

**Date:** 2026-08-10/11  
**Grid:** `panel_grid_stories.json` — `--live --lang en-US --force`  
**Filter:** `--run-id-re '35flashlite|36flash'` (18 cells; all exit 0)

## Panel quality vs June baseline

| Metric | June (pre-force) | Post-force (current models) |
|--------|------------------|-----------------------------|
| Respondents | 18 | **18** |
| Non-response | **~33%** | **0.0%** |
| Spread | INADEQUATE | still **INADEQUATE** (min 0.79 / med 0.83 / max 0.86, SD 0.03) |
| Flags | B3/H2/C11 | B4/H1/**C22** |
| ρ(p_vlm, human) | ~0.56–0.60 | **0.62** (bench) |
| MAE cal | ~0.12 | **0.10** |

## `d_est` vs seeded human IRT (flipped)

| Metric | Pre-force | Post-force |
|--------|-----------|------------|
| Anchors | 26 | **26** |
| LOO ρ_multivar | **0.55** | **0.353** |
| −`p_pred` ranking ceiling | **0.63** | **0.683** |
| MAE | (prior report) | **1.106** |

Prior apply: preserved 0 / filled **21** / skipped_blocked **4** / blank_no_match **6**.

## Verdict

- **Ops GO:** Force recollect killed non-response (33% → 0%) on current Gemini; panel is usable for screens.
- **Spread still weak:** Models sit at the ceiling (C22) — ability ladder not separating ToM items well.
- **Research:** Prefer **−`p_pred` ranking** (~**0.68** vs human IRT) over hybrid `d_est` LOO ρ (0.35; z-only, LOO noisy). Same story as before: hybrid doesn’t beat pass-rate ranking for ToM.

## Artifacts

- `out/screen_stories_en.csv`, `out/report_stories.md`
- `out/bench_calibration_stories.md`
- `out/d_est_stories_en.csv`, `out/d_est_stories_en_report.md`
- `out/d_est_prior_report_stories_en.md`
- `out/item_bank_stories_en_d_est_prior.csv`
