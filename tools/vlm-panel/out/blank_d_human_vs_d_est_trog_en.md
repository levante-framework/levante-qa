# Blind VLM `d_est` vs human-trial `d` on blank-bank TROG EN items

**Date:** 2026-08-08  
**Artifacts:** [`blank_d_human_vs_d_est_trog_en.csv`](blank_d_human_vs_d_est_trog_en.csv), hybrid metrics in [`d_est_trog_en_metrics.json`](d_est_trog_en_metrics.json), human params from `levante-bench/data/responses/v2/irt_models/trog_item_params.csv` (Redivis `levante_data_latest`).

## Question

For EN TROG items that **lack a shipped CAT bank `d`**, how does a **panel hybrid `d_est`** (built without using that item’s child responses) compare to the difficulty we’d get if we only used **human trial data** already collected?

## What each estimate is

### A. “Blind” VLM `d_est` (per blank item)

Pipeline: ungated VLM panel → `p_vlm` → calibrator → `p_pred_child` → hybrid `estimate_difficulty.mjs` (`z` + construction tags → bank-scale `d_est`).

**Blind with respect to that item:** that UID’s child trials / `p_human` / human IRT row are **not** inputs to its `d_est`.

**Not fully human-free:** the calibrator and hybrid coefficients are fit on **other** items that do have human pass rates and bank `d`. So this is “new-item blind,” not “never saw a child.”

### B. Human-trial `d` on bank scale (`d_human_bank`)

1. Start from Redivis human IRT `item_params` (fit on child trials; this export is **easiness-coded**).
2. Flip: `d_human_raw = −difficulty` (harder → higher).
3. Affine-link onto CAT bank `d` using the **76** items that have both bank `d` and human params:

`d_human_bank ≈ −0.901 + 0.403 · d_human_raw`

Held-out CV for that link alone: **ρ ≈ 0.50**, MAE ≈ 1.01.

This is the practical “no VLM” path: take the human IRT already run on collected trials and put it on the same scale as the shipped bank.

## Two comparisons (different referees)

| Setting | Referee | Why |
|---------|---------|-----|
| **Anchors** (80 items with shipped bank `d`) | Bank `d` | Can ask which method recovers CAT difficulty better. |
| **Blanks** (19 without bank `d`) | Each other | No bank `d` to hit; ask whether blind VLM and human-linked `d` **agree**. |

## Results

### Anchors (recovering bank `d`)

| Method | Held-out / CV Spearman vs bank `d` | MAE |
|--------|-------------------------------------|-----|
| Hybrid VLM `d_est` | **0.637** | 0.843 |
| Human params → bank link | **0.502** | 1.014 |

On the scale that matters for CAT priors, **blind hybrid is competitive and slightly stronger** than rescaling the published human IRT params.

### Blanks (agreement where both exist)

- **19** scored bank rows lack `d`.
- **13** have a human IRT row → both `d_est` and `d_human_bank`.
- **6** have no human IRT row (4 Bishop nouns, `sunny_however_rain`, `kid_clean_but_forget`) → human `d` unavailable; only pass rates / VLM.

On the **13**:

| Metric | Value |
|--------|-------|
| Spearman(`d_est`, `d_human_bank`) | **0.709** |
| MAE(`d_est`, `d_human_bank`) | 0.64 |
| Spearman(`d_est`, −`p_human`) | 0.801 |
| Spearman(`d_human_bank`, −`p_human`) | 0.979 |

| item_uid | d_human_bank | d_est (VLM) | p_human | flag |
|----------|-------------:|------------:|--------:|------|
| trog_causal_she_trip_rock_drop_book | -1.96 | -2.91 | 0.88 | OK |
| trog_compprepcond_instead_homework_she_do_puzzle | -1.12 | -1.28 | 0.62 | OK |
| trog_conditional_teacher_give_if_stand_line | -1.91 | -1.94 | 0.87 | OK |
| trog_conjcoord_monkey_eat_nor_swing | -2.03 | -1.40 | 0.87 | OK |
| trog_disjunctive_although_hot_i_wear | -1.81 | -2.61 | 0.84 | OK |
| trog_disjunctive_despite_noise_she_focus | -0.46 | +0.07 | 0.42 | BROKEN |
| trog_disjunctive_he_wear_despite_size | -1.37 | -2.47 | 0.72 | OK |
| trog_postmod_duck_following_turtle_walking | -0.71 | -0.64 | 0.49 | BROKEN |
| trog_preploc_car_truck_follow_drive | -1.23 | +0.21 | 0.62 | BROKEN |
| trog_preploc_fish_swim_beneath_whale | -0.70 | +0.92 | 0.46 | HARD |
| trog_preploc_plane_gray_above_cloud | -1.89 | -1.44 | 0.82 | OK |
| trog_relclause_person_chase_dog_that_big | -2.20 | -2.27 | 0.89 | OK |
| trog_revpassrelclause_girl_wearing_backpack_shown_flower | -1.32 | -1.82 | 0.64 | HARD |

Largest disagreements (VLM harder than human-linked): `fish_swim_beneath_whale`, `car_truck_follow_drive` — both panel-HARD/BROKEN. Closest agreement: conditionals / relative clause / duck.

## Verdict

For blank-bank EN TROG items, **new-item-blind hybrid `d_est` is competitive with a human-IRT-derived bank-scale `d`**: rankings agree (ρ ≈ **0.71** on 13 items), and on anchors the VLM hybrid recovers shipped bank `d` **at least as well** as rescaling human `item_params` (ρ **0.64** vs **0.50**).

Use as a **prior / screen**, not as final field IRT. Skip BROKEN / known_issues when filling blanks. Where human IRT never published a row, VLM (or pass-rate heuristics) is the only difficulty signal until kids are scored into a model.
