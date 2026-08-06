# Residual audit — trog / en

Generated: 2026-08-05T23:19:42.848Z
Source: `/home/david/levante/levante-qa/tools/vlm-panel/out/screen_en.csv`

## Summary
- Matched items: **99**
- Mean |p_vlm − p_human|: **0.108**
- Mean bias (vlm − human): **0.063** (positive = VLM too easy)
- Mean |p_pred_child − p_human|: **0.076**

## By construction tag (mean |raw err|)
| tag | n | mae_raw | bias_raw |
|---|---:|---:|---:|
| relative_clause | 13 | 0.226 | 0.105 |
| passive | 4 | 0.186 | 0.031 |
| reverse_agent | 15 | 0.166 | 0.021 |
| spatial | 20 | 0.164 | 0.131 |
| adjective | 22 | 0.126 | 0.075 |
| temporal | 1 | 0.114 | 0.114 |
| disjunctive | 5 | 0.098 | 0.082 |
| other | 30 | 0.078 | 0.049 |
| negation | 17 | 0.073 | 0.065 |
| comparative | 4 | 0.071 | 0.005 |

## Top 20 raw residuals
| |err| | bias | p_vlm | p_human | item_uid | tags | transcript |
|---:|---:|---:|---:|---|---|---|
| 0.45 | 0.45 | 0.69 | 0.24 | trog_embedding_cat_cow_chase_black | relative_clause+reverse_agent | the cat the cow chases is black |
| 0.45 | 0.45 | 0.69 | 0.24 | trog_embedding_boy_dog_chase_big | relative_clause+reverse_agent+adjective | the boy the dog chases is big |
| 0.38 | 0.38 | 1.00 | 0.62 | trog_compprepcond_instead_homework_she_do_puzzle | spatial | Instead of doing homework she did a puzzle in her  |
| 0.35 | 0.35 | 1.00 | 0.65 | trog_embedding_circle_star_in_red | relative_clause+spatial+adjective | the circle the star is in is red |
| 0.32 | 0.32 | 1.00 | 0.68 | trog_embedding_book_pencil_on_red | relative_clause+spatial+adjective | the book the pencil is on is red |
| 0.30 | -0.30 | 0.19 | 0.49 | trog_postmod_duck_following_turtle_walking | relative_clause+reverse_agent | The duck following the turtle is walking across th |
| 0.28 | 0.28 | 1.00 | 0.72 | trog_relclause_square_in_star_that_blue | spatial+adjective | the square is in the star that is blue |
| 0.25 | -0.25 | 0.69 | 0.94 | trog_additive_hose_drink_sheep_eat | other | the horse drank water by the barn and the sheep at |
| 0.24 | -0.24 | 0.69 | 0.93 | trog_adjective_tall | adjective | Choose the picture that shows tall. |
| 0.24 | -0.24 | 0.38 | 0.62 | trog_preploc_car_truck_follow_drive | relative_clause+reverse_agent+spatial | The car that the truck followed is driving toward  |
| 0.24 | 0.24 | 1.00 | 0.76 | trog_revpassive_elephant_pushed_boy | reverse_agent+passive | the elephant is pushed by the boy |
| 0.21 | 0.21 | 0.94 | 0.72 | trog_prepphrase_he_find_under_couch | spatial | he found his keys under the couch with the pillows |
| 0.20 | -0.20 | 0.69 | 0.89 | trog_revpassive_girl_chased_horse | reverse_agent+passive | the girl is chased by the horse |
| 0.20 | 0.20 | 1.00 | 0.80 | trog_inon_circle_in_star | spatial | the circle is in the star |
| 0.20 | 0.20 | 0.94 | 0.74 | trog_neither_pencil_long_nor_red | negation+adjective | the pencil is neither long nor red |
| 0.19 | 0.19 | 1.00 | 0.81 | trog_revpassive_cow_pushed_man | reverse_agent+passive | the cow is pushed by the man |
| 0.19 | 0.19 | 0.94 | 0.75 | trog_postmod_circle_in_star_yellow | relative_clause+spatial | the circle in the star is yellow |
| 0.17 | 0.17 | 1.00 | 0.83 | trog_neither_dog_nor_ball_brown | negation | neither the dog nor the ball is brown |
| 0.17 | 0.17 | 0.63 | 0.46 | trog_preploc_fish_swim_beneath_whale | relative_clause+spatial | The fish swim beneath a whale and a sea turtle. |
| 0.16 | 0.16 | 1.00 | 0.84 | trog_abovebelow_square_below_star | spatial | the square is below the star |

## Prompt / input guidance
- High |err| on negation / reverse_agent / spatial / comparative → strengthen literal grammar checklist in `trogVlmAgent` SYSTEM_PROMPT.
- Negative bias (VLM harder than kids) is common on TROG — model misses structure kids get; not fixed by age persona.
