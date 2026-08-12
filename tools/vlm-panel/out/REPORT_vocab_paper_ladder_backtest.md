# Vocab backtest: paper open-model ladder vs human IRT / bank `d`

**Date:** 2026-08-11
**Source:** `levante-bench/results/paper_models_forced_binary/*/vocab.csv` (15 models)
**Targets:** flipped bench `vocab_item_params.csv` difficulty (higher = harder); CAT bank `d` from `d_est_vocab_en.csv` where present
**UID join:** `vocab__X` → `vocab_word_X`
**Cypress baseline:** `screen_vocab_en.csv` (v3 DIGIT YES|NO panel)

## Model ladder (vocab accuracy)

| Model | Acc | n trials |
|-------|-----|----------|
| qwen35-0.8B | 0.000 | 542 |
| qwen35-4B | 0.000 | 2304 |
| internvl35-1B | 0.069 | 364 |
| gemma4-E2B-it | 0.480 | 173 |
| qwen35-9B | 0.547 | 170 |
| qwen35-27B | 0.553 | 170 |
| internvl35-2B | 0.721 | 179 |
| qwen35-2B | 0.770 | 187 |
| internvl35-4B | 0.782 | 179 |
| gemma4-31B-it | 0.818 | 192 |
| gemma4-E4B-it | 0.873 | 173 |
| molmo2-O-7B | 0.900 | 170 |
| internvl35-14B | 0.924 | 170 |
| internvl35-8B | 0.971 | 170 |
| gemma4-26B-A4B-it | 0.988 | 170 |

Accuracy span: **0.000 → 0.988** (many strong models near ceiling).

## Recovery of human IRT difficulty (−p vs flipped `d_human`)

Overlap: **144** items with human params.

| Method | Spearman | LOO affine ρ | LOO MAE |
|--------|----------|--------------|---------|
| Paper all mean −p | **0.308** | 0.164 | 1.510 |
| Paper all ability-weighted −p | **0.297** | 0.240 | 1.517 |
| Paper top-5 mean −p | **0.197** | −0.366 | 1.618 |
| Paper top-5 ability-weighted −p | **0.173** | −0.354 | 1.621 |
| Cypress panel −p_pred (v3 EN) | **0.746** | 0.506 | 1.078 |
| Cypress panel −p_vlm | **0.757** | 0.423 | 1.089 |

## Sensitivity (subsets)

Unlike Stories, **top-5-by-acc hurts** (all ≥0.87 → CEILING, less item discrimination). Mid / spread subsets stay ~0.27–0.30.

| Ladder subset | n models | Acc span | ρ(−p_mean) | ρ(−p_weighted) |
|---------------|----------|----------|------------|----------------|
| all_15 | 15 | 0.00→0.99 | **0.308** | 0.297 |
| acc≥0.20 | 12 | 0.48→0.99 | **0.301** | 0.292 |
| mid 0.45–0.85 | 7 | 0.48→0.82 | **0.302** | 0.294 |
| exclude acc≥0.95 | 10 | 0.48→0.92 | **0.303** | 0.293 |
| spread5 usable | 5 | 0.48→0.99 | **0.290** | 0.270 |
| top5_acc | 5 | 0.87→0.99 | **0.197** | 0.173 |

## vs CAT bank `d` (−p ranking)

| Method | n | Spearman vs bank `d` |
|--------|---|----------------------|
| Paper all / mid / spread | 170 | **~0.08–0.13** |
| Cypress −p_pred | 170 | **~0.53** (screen join; hybrid/p-only ceiling in `d_est_vocab_en_report.md` is higher on the estimate path) |

## Verdict

- **NO-GO** for replacing the Cypress vocab panel with the paper open-model ladder.
- Best paper ladder ≈ **ρ 0.31** vs human IRT; Cypress v3 ≈ **0.75**. Gap is large.
- Stories lesson (**curate top-5**) does **not** transfer: vocab paper models are too strong / ceiling-heavy, so top-5 is the *worst* subset.
- Keep **Approach A** (live Gemini + v3 ability prompt) for vocab research priors.

## Artifacts

- `out/backtest_vocab_paper_ladder.csv`
- This report
