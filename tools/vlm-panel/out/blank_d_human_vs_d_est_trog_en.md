# Blank bank `d` from human IRT (no VLM) vs hybrid `d_est`

Generated: 2026-08-08

## Method (traditional human path)

1. Take Redivis / levante-bench human IRT item parameters:  
   `levante-bench/data/responses/v2/irt_models/trog_item_params.csv`  
   (already fit from child trials; **easiness-coded** in this export).
2. Flip to harder-is-higher: `d_human_raw = −difficulty`.
3. Affine-link onto **CAT bank `d`** using the 76 items that have both bank `d` and human params:

`d_human_bank ≈ −0.901 + 0.403 · d_human_raw`

Held-out CV on those anchors: **ρ ≈ 0.50**, MAE ≈ 1.01  
(vs hybrid VLM `d_est` on bank anchors: ρ ≈ **0.64**).

This is the bank-scale number you’d use if you only had human IRT and needed to put blanks on the same scale as the shipped bank — **not** a new fit from scratch (the human IRT already exists; we only rescaled it).

## The 19 blanks

| item_uid | d_human_bank | d_est (VLM) | p_human | flag |
|----------|-------------:|------------:|--------:|------|
| trog_causal_she_trip_rock_drop_book | -1.96 | -2.91 | 0.88 | OK |
| trog_compprepcond_instead_homework_she_do_puzzle | -1.12 | -1.28 | 0.62 | OK |
| trog_conditional_teacher_give_if_stand_line | -1.91 | -1.94 | 0.87 | OK |
| trog_conjcoord_kid_clean_but_forget | — | -1.94 | 0.83 | OK |
| trog_conjcoord_monkey_eat_nor_swing | -2.03 | -1.40 | 0.87 | OK |
| trog_conjcoord_say_sunny_however_rain | — | +8.74 | 0.04 | BROKEN |
| trog_disjunctive_although_hot_i_wear | -1.81 | -2.61 | 0.84 | OK |
| trog_disjunctive_despite_noise_she_focus | -0.46 | +0.07 | 0.42 | BROKEN |
| trog_disjunctive_he_wear_despite_size | -1.37 | -2.47 | 0.72 | OK |
| trog_noun_apple | — | -3.56 | 0.98 | CEILING |
| trog_noun_bird | — | -3.56 | 0.95 | CEILING |
| trog_noun_comb | — | -3.56 | 0.93 | CEILING |
| trog_noun_shoe | — | -3.56 | 0.95 | CEILING |
| trog_postmod_duck_following_turtle_walking | -0.71 | -0.64 | 0.49 | BROKEN |
| trog_preploc_car_truck_follow_drive | -1.23 | +0.21 | 0.62 | BROKEN |
| trog_preploc_fish_swim_beneath_whale | -0.70 | +0.92 | 0.46 | HARD |
| trog_preploc_plane_gray_above_cloud | -1.89 | -1.44 | 0.82 | OK |
| trog_relclause_person_chase_dog_that_big | -2.20 | -2.27 | 0.89 | OK |
| trog_revpassrelclause_girl_wearing_backpack_shown_flower | -1.32 | -1.82 | 0.64 | HARD |

CSV: [`blank_d_human_vs_d_est_trog_en.csv`](blank_d_human_vs_d_est_trog_en.csv).

On the **13** blanks with human IRT: Spearman(`d_human_bank`, `d_est`) ≈ **0.71**.

## Gaps

- **6 blanks** have no human IRT row (4 nouns, sunny/however, kid_clean) — traditional pipeline never published a param; only pass rates exist.
- Link quality to bank scale is moderate (CV ρ ~0.5); human params and bank `d` are related but not the same fit.
- Do **not** overwrite established bank `d`; this is a diagnostic / alternate prior for blanks only.
