# d_est prior apply — trog / en

Generated: 2026-08-08T23:22:21.053Z

## Policy

- Established bank `d` (finite) is **never** overwritten.
- Blank / NaN `d` is filled from hybrid `d_est` when a UID match exists.
- **Skip** fill when screen `flag=BROKEN` or UID is in `known_issues.json` (leave blank).
- This script does **not** upload to GCS; copy the draft CSV manually if promoting.

## Inputs

- Bank: `/home/david/levante/levante-qa/cypress/cache/sim-item-bank-trog.csv`
- d_est: `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_trog_en.csv`
- known_issues: `/home/david/levante/levante-qa/tools/vlm-panel/known_issues.json` (2 trog UID(s))
- Fill column: `d`

## Counts

| Metric | n |
|--------|---|
| Bank rows | 100 |
| Preserved (established d) | 80 |
| Filled from d_est | 15 |
| Skipped (BROKEN / known_issue) | 4 |
| Blank scored, no d_est match | 0 |
| Blank / non-scored (no answer) | 1 |

## Filled items

| item_uid | d_est | p_pred_child | flag | transcript |
|----------|-------|--------------|------|------------|
| trog_noun_shoe | -3.564 | 0.947 | CEILING | Choose the picture of the shoe. |
| trog_noun_bird | -3.564 | 0.947 | CEILING | Choose the picture of the bird. |
| trog_noun_comb | -3.564 | 0.947 | CEILING | Choose the picture of the comb. |
| trog_noun_apple | -3.564 | 0.947 | CEILING | Choose the picture of the apple. |
| trog_causal_she_trip_rock_drop_book | -2.915 | 0.909 | OK | She tripped on a rock and dropped her books. |
| trog_conditional_teacher_give_if_stand_line | -1.944 | 0.811 | OK | The teacher will give the students cake if they stand in a line. |
| trog_disjunctive_although_hot_i_wear | -2.609 | 0.829 | OK | Although it is hot outside, I am wearing a jacket with a hood. |
| trog_disjunctive_he_wear_despite_size | -2.466 | 0.811 | OK | He wore the clown's hat despite its large size. |
| trog_relclause_person_chase_dog_that_big | -2.273 | 0.829 | OK | The person chases the dog that is big. |
| trog_revpassrelclause_girl_wearing_backpack_shown_flower | -1.824 | 0.795 | HARD | The girl wearing a backpack was shown a flower by her friend. |
| trog_conjcoord_kid_clean_but_forget | -1.944 | 0.811 | OK | The kids cleaned the room, but forgot to put away the train. |
| trog_conjcoord_monkey_eat_nor_swing | -1.400 | 0.829 | OK | The monkey neither ate the banana nor swung on the vine. |
| trog_preploc_plane_gray_above_cloud | -1.441 | 0.829 | OK | The plane that is gray is above the clouds. |
| trog_preploc_fish_swim_beneath_whale | 0.921 | 0.459 | HARD | The fish swim beneath a whale and a sea turtle. |
| trog_compprepcond_instead_homework_she_do_puzzle | -1.284 | 0.834 | OK | Instead of doing homework she did a puzzle in her room. |

## Skipped (left blank)

| item_uid | d_est (unused) | flag | skip reason |
|----------|----------------|------|-------------|
| trog_disjunctive_despite_noise_she_focus | 0.070 | BROKEN | screen flag=BROKEN |
| trog_postmod_duck_following_turtle_walking | -0.638 | BROKEN | screen flag=BROKEN |
| trog_conjcoord_say_sunny_however_rain | 8.741 | BROKEN | screen flag=BROKEN |
| trog_preploc_car_truck_follow_drive | 0.207 | BROKEN | screen flag=BROKEN |

## Outputs

- Draft bank: `/home/david/levante/levante-qa/tools/vlm-panel/out/item_bank_trog_en_d_est_prior.csv`
- This report: `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_prior_report_trog_en.md`
