# 3.x vs 2.5 xlang Δ compare (DE)

- Baseline: `out/review_xlang_de_25.csv` (strong=1)
- Current: `out/review_xlang_de.csv` (strong=2)
- Overlap: **0** | only 2.5: **1** | only 3.x: **2**
- Jaccard(strong_delta): **0.000**

**Verdict:** Large reshuffle — do not treat 2.5 triage as transferable to 3.x.

## Only in 2.5 strong_delta
- trog_abovebelow_square_below_star

## Only in 3.x strong_delta
- trog_conjcoord_kid_clean_but_forget
- trog_embedding_cat_cow_chase_black

## Largest |Δ_3x − Δ_25| shifts
| item_uid | Δ_25 | Δ_3x | |shift| |
|---|---:|---:|---:|
| trog_embedding_cat_cow_chase_black | -0.008 | -0.500 | 0.492 |
| trog_conjcoord_kid_clean_but_forget | -0.104 | 0.250 | 0.354 |
| trog_abovebelow_comb_below_spoon | -0.250 | 0.063 | 0.313 |
| trog_comparative_horse_taller_wall | 0.125 | -0.188 | 0.313 |
| trog_notonly_notonly_girl_cat_sit | 0.083 | -0.187 | 0.270 |
| trog_disjunctive_despite_noise_she_focus | 0.144 | -0.125 | 0.269 |
| trog_abovebelow_pencil_above_flower | 0.125 | -0.125 | 0.250 |
| trog_revactive_man_chase_dog | 0.110 | -0.125 | 0.235 |
| trog_abovebelow_square_below_star | -0.291 | -0.062 | 0.229 |
| trog_comparative_fork_longer_pencil | 0.104 | -0.125 | 0.229 |
| trog_embedding_boy_dog_chase_big | 0.075 | -0.125 | 0.200 |
| trog_revpassive_cow_pushed_man | 0.200 | 0.000 | 0.200 |
| trog_revpassrelclause_girl_wearing_backpack_shown_flower | -0.134 | 0.063 | 0.197 |
| trog_conditional_teacher_give_if_stand_line | 0.068 | -0.125 | 0.193 |
| trog_postmod_duck_following_turtle_walking | -0.058 | 0.125 | 0.183 |
