# Stories backtest: paper open-model ladder vs human IRT

**Date:** 2026-08-11
**Source:** `levante-bench/results/paper_models_forced_binary/*/theory-of-mind.csv` (17 models)
**Target:** bench `theory-of-mind_item_params.csv` difficulty, **flipped** (higher = harder)
**UID join:** strip `tom_storyN_` → `tom_*` (same as estimate_difficulty stories)

## Model ladder (ToM accuracy)

| Model | Acc |
|-------|-----|
| qwen35-0.8B | 0.000 |
| qwen35-4B | 0.000 |
| gemma4-31B-it | 0.032 |
| internvl35-1B | 0.097 |
| qwen35-2B | 0.258 |
| internvl35-2B | 0.290 |
| smolvlm2-256M | 0.290 |
| gemma4-E2B-it | 0.323 |
| gemma4-E4B-it | 0.323 |
| internvl35-4B | 0.323 |
| qwen35-9B | 0.323 |
| smolvlm2-500M | 0.323 |
| molmo2-O-7B | 0.387 |
| qwen35-27B | 0.484 |
| gemma4-26B-A4B-it | 0.742 |
| internvl35-14B | 0.742 |
| internvl35-8B | 0.806 |

Accuracy span: **0.000 → 0.806**

## Recovery of human IRT difficulty

Overlap items: **27**

| Method | Spearman vs d_human | LOO affine ρ | LOO MAE |
|--------|---------------------|--------------|---------|
| Paper ladder mean p (−p) | **0.261** | -0.020 | 1.919 |
| Ability-weighted p (−p) | **0.434** | 0.324 | 1.686 |
| Cypress panel −p_pred (force EN) | **0.688** | -0.033 | 1.307 |
| Cypress panel −p_vlm | 0.693 | — | — |

## Verdict

- **Naive all-17 ladder is weak** (ρ ≈ 0.26): floor/broken runs (0–3% ToM acc) add noise.
- **Curated ladder works:** top-5 by ToM acc + ability-weighted −p reaches **ρ ≈ 0.70**, matching Cypress force EN −p_pred (**0.69**).
- Dropping parse-floor models and ability-weighting matter more than “use every paper checkpoint.”
- This is ranking vs flipped human IRT on **established** items — not model-size = child θ.
- For **new** ToM items: pin a mid→strong open subset (e.g. Molmo / Qwen27B / Gemma26B / InternVL 8–14B), score offline, rank by −p (weighted), map onto the human-IRT scale from anchors.

## Artifacts

- `backtest_stories_paper_ladder.csv`
- This report

## Sensitivity (drop broken / floor models)

Several paper runs land near 0 ToM accuracy (parse/protocol failure). Recomputing after filters:

| Ladder subset | n models | Acc span | n items | ρ(−p_mean) | ρ(−p_weighted) |
|---------------|----------|----------|---------|------------|----------------|
| all_17 | 17 | 0.00→0.81 | 27 | **0.261** | 0.427 |
| acc>=0.20 | 13 | 0.26→0.81 | 27 | **0.274** | 0.520 |
| acc 0.30–0.85 | 10 | 0.32→0.81 | 27 | **0.421** | 0.636 |
| top5_acc | 5 | 0.39→0.81 | 27 | **0.621** | **0.698** |
| spread5_usable | 5 | 0.26→0.81 | 27 | **0.113** | 0.249 |

Cypress force EN −p_pred (same human target): **0.688** (n=25).

**Reading:** A **curated mid/strong open ladder** (not the full noisy set) is competitive with the live Gemini panel for Stories difficulty ranking, with the reproducibility upside of pinned open weights.
