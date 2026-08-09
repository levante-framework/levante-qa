# Blank bank `d` — panel ICC vs hybrid `d_est` (TROG EN)

Generated: 2026-08-08 (from refreshed `d_icc_trog_en_*` + current `d_est_trog_en.csv` / `screen_en.csv`).

## Method

Traditional panel ICC via `fit_icc_difficulty.mjs`:

$$P(\mathrm{correct}\mid\theta) = c + (1-c)\,\sigma(\theta - d_{\mathrm{icc}})$$

- Trials: accumulated ungated EN panel runs (n_runs=**87** this refresh; force still may add more)
- θ from persona age (`age_task_ability.json`); ages seen include 6/8/10/12/13
- `d_icc_linked` = full-sample affine onto bank scale (anchors with established bank `d`)

## Bank-scale recovery (anchors, not blanks)

| Metric | Value |
|--------|-------|
| Spearman `d_icc` CV vs bank `d` | **0.080** |
| Spearman hybrid `d_est` vs bank `d` | **0.647** |
| MAE `d_icc` CV | 1.066 |

**Verdict:** panel ICC is **NO-GO** as a CAT prior. Prefer hybrid `d_est` for blank fill (gated: skip BROKEN / `known_issues.json`). Do not promote `d_icc` / `d_icc_linked` into the bank.

## The 19 blank scored items

| item_uid | n | d_icc | reason | d_icc_linked | d_est | flag | skip prior |
|----------|---|-------|--------|--------------|-------|------|------------|
| trog_causal_she_trip_rock_drop_book | 86 | -4.09 | ok | -2.03 | -2.90 | OK | |
| trog_compprepcond_instead_homework_she_do_puzzle | 84 | -2.88 | ok | -1.89 | -1.28 | OK | |
| trog_conditional_teacher_give_if_stand_line | 81 | -0.36 | ok | -1.60 | -2.11 | OK | |
| trog_conjcoord_kid_clean_but_forget | 86 | -0.74 | ok | -1.64 | -2.11 | OK | |
| trog_conjcoord_monkey_eat_nor_swing | 85 | -1.54 | ok | -1.74 | -1.47 | OK | |
| trog_conjcoord_say_sunny_however_rain | 85 | +8.00 | boundary | -0.63 | +6.89 | BROKEN | yes |
| trog_disjunctive_although_hot_i_wear | 85 | -1.35 | ok | -1.72 | -2.61 | OK | |
| trog_disjunctive_despite_noise_she_focus | 85 | +8.00 | boundary | -0.63 | -0.51 | BROKEN | yes |
| trog_disjunctive_he_wear_despite_size | 86 | -1.05 | ok | -1.68 | -2.61 | OK | |
| trog_noun_apple | 87 | -8.00 | all_correct | -2.49 | -3.46 | CEILING | |
| trog_noun_bird | 87 | -8.00 | all_correct | -2.49 | -3.46 | CEILING | |
| trog_noun_comb | 87 | -8.00 | all_correct | -2.49 | -3.46 | CEILING | |
| trog_noun_shoe | 87 | -8.00 | all_correct | -2.49 | -3.46 | CEILING | |
| trog_postmod_duck_following_turtle_walking | 86 | +2.41 | ok | -1.28 | -0.76 | BROKEN | yes |
| trog_preploc_car_truck_follow_drive | 85 | +8.00 | boundary | -0.63 | +0.07 | BROKEN | yes |
| trog_preploc_fish_swim_beneath_whale | 85 | +0.83 | ok | -1.46 | +0.88 | HARD | |
| trog_preploc_plane_gray_above_cloud | 86 | -1.36 | ok | -1.72 | -1.22 | OK | |
| trog_relclause_person_chase_dog_that_big | 86 | -1.90 | ok | -1.78 | -2.10 | OK | |
| trog_revpassrelclause_girl_wearing_backpack_shown_flower | 81 | -0.01 | ok | -1.56 | -2.10 | HARD | |

CSV: [`blank_d_icc_vs_d_est_trog_en.csv`](blank_d_icc_vs_d_est_trog_en.csv). Full ICC: [`d_icc_trog_en_report.md`](d_icc_trog_en_report.md).

## Notes

- Linked column is nearly compressed (flat affine); boundary / all-correct items are not usable as difficulties.
- Re-run `fit_icc_difficulty.mjs` again after EN full-force completes for a final trial count.
