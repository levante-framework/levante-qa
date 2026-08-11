# Stories `d_est` from paper open-model ladder

**Date:** 2026-08-11
**Idea:** Replace Cypress Gemini `p_pred` with curated paper ladder (top-5 ToM acc, ability-weighted `p_vlm`), calibrate to bench pass-rates, run the same `estimate_difficulty.mjs` Stories hybrid.

## Ladder

| Model | ToM acc |
|-------|---------|
| molmo2-O-7B | 0.387 |
| qwen35-27B | 0.484 |
| gemma4-26B-A4B-it | 0.742 |
| internvl35-14B | 0.742 |
| internvl35-8B | 0.806 |

Screen: `out/screen_stories_en_paper_ladder.csv` (n=31).

## Held-out recovery vs seeded human IRT (bank scale)

| Source | LOO ρ_multivar vs d_bank | −p_pred ceiling |
|--------|--------------------------|-----------------|
| Paper ladder → d_est | **0.612** | 0.711 |
| Cypress Gemini force → d_est | **0.353** | 0.683 |

## Agreement: paper `d_est_cv` vs Cypress `d_est_cv`

Anchors in both: **25**

| Comparison | Spearman | MAE |
|------------|----------|-----|
| paper d_est_cv vs Cypress d_est_cv | **0.785** | 0.464 |
| paper d_est_cv vs d_bank | **0.638** | 0.852 |
| Cypress d_est_cv vs d_bank | **0.362** | 1.124 |
| paper −p_pred vs d_bank | **0.726** | — |
| Cypress −p_pred vs d_bank | **0.688** | — |

## Verdict

- Paper ladder **does** produce a full Stories `d_est` table via the existing estimator.
- Ranking vs bank/human scale: prefer reading **−p_pred ceiling** and agreement with Cypress; hybrid LOO ρ is noisy on n≈26 for both sources.
- If paper −p_pred ≈ Cypress −p_pred vs bank, the ladder is a viable offline input for new-item priors once those items are scored on the same pinned models.

## Artifacts

- `out/screen_stories_en_paper_ladder.csv`
- `out/d_est_stories_en_paper_ladder.csv`
- `out/d_est_stories_en_paper_ladder_report.md`
- Cypress outputs restored as `out/d_est_stories_en.*`
