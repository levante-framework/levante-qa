# Theory of Mind (Stories): first `d_est` prior pass

**Date:** 2026-08-08  
**Task id:** `stories` (bank: `theory-of-mind`, UIDs `tom_*`)

## What we did

1. Wired **stories** into `estimate_difficulty.mjs` and `apply_d_est_prior.mjs`.
2. Because the CAT bank has **no shipped difficulties**, fit anchors are seeded from Redivis/bench human IRT (`theory-of-mind_item_params.csv`), **flipped** so higher = harder (same orientation as TROG bank `d`).
3. Refit bench calibrator (v2 trials) → `analyze --task stories --human-source=bench` → estimate → gated apply.

## Results (EN)

| Metric | Value |
|--------|-------|
| Panel screen | 18 respondents, 29 items; B3/H2/C11; ρ difficulty vs human ≈ **0.60**; MAE cal ≈ **0.12** |
| Anchors (seeded human IRT) | 26 |
| LOO Spearman(`d_est`, human-IRT scale) | **0.55** (multivar / z-only) |
| Ranking ceiling −`p_pred` | **0.63** (beats hybrid slightly — expected with z-only features) |
| Prior apply | preserved **0**, filled **23**, skipped BROKEN **2**, no panel match **6** |

Draft bank: `out/item_bank_stories_en_d_est_prior.csv` (fills `difficulty`).  
Metrics: `out/d_est_stories_en_report.md`, `out/d_est_prior_report_stories_en.md`.

## How to read this vs TROG

- TROG had a real bank `d` scale. ToM does **not** — so “recovery” here means matching **human IRT difficulty**, not a shipped CAT table.
- −`p_pred` ranks human difficulty about as well as (slightly better than) the fitted `d_est`. For ToM priors, either is usable; hybrid is mostly a scaled pass-rate map until we add ToM-specific features.
- Panel data are still the **June** collect: high non-response (~33%), spread marked INADEQUATE. A force recollect would likely tighten MAE / ranking before promoting to production.

## Next

- Optional: Stories force replay (`panel_grid_stories.json`) to refresh panel quality.
- Promote draft difficulties only after review of the 2 BROKEN skips and the 6 bank items missing from the screen.
- Do not treat ToM `d_est` as equal in strength to TROG’s ρ≈0.64 bank recovery until the panel is healthier.
