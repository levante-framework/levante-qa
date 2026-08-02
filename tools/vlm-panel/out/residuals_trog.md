# Residual audit — trog / en

Generated: 2026-08-01T21:42:22.486Z
Source: `/home/david/levante/levante-qa/tools/vlm-panel/out/screen_en.csv`

## Summary
- Matched items: **90**
- Mean |p_vlm − p_human|: **0.164**
- Mean bias (vlm − human): **-0.036** (positive = VLM too easy)
- Mean |p_pred_child − p_human|: **0.093**

## By construction tag (mean |raw err|)
| tag | n | mae_raw | bias_raw |
|---|---:|---:|---:|
| passive | 4 | 0.264 | -0.207 |
| comparative | 3 | 0.257 | -0.257 |
| reverse_agent | 14 | 0.249 | -0.173 |
| disjunctive | 5 | 0.229 | -0.123 |
| adjective | 21 | 0.205 | -0.028 |
| relative_clause | 13 | 0.204 | -0.026 |
| temporal | 1 | 0.190 | -0.190 |
| spatial | 20 | 0.184 | -0.013 |
| other | 24 | 0.121 | 0.026 |
| negation | 16 | 0.108 | 0.026 |

## Top 20 raw residuals
| |err| | bias | p_vlm | p_human | item_uid | tags | transcript |
|---:|---:|---:|---:|---|---|---|
| 0.66 | -0.66 | 0.21 | 0.87 | trog_adjective_tall | adjective | Choose the picture that shows tall. |
| 0.57 | -0.57 | 0.12 | 0.68 | trog_disjunctive_despite_noise_she_focus | disjunctive | Despite the noise in the classroom, she focused on |
| 0.49 | -0.49 | 0.41 | 0.89 | trog_additive_hose_drink_sheep_eat | other | the horse drank water by the barn and the sheep at |
| 0.48 | -0.48 | 0.49 | 0.96 | trog_comparative_horse_taller_wall | comparative+adjective | the horse is taller than the wall |
| 0.45 | -0.45 | 0.50 | 0.95 | trog_revpassive_girl_chased_horse | reverse_agent+passive | the girl is chased by the horse |
| 0.43 | 0.43 | 0.93 | 0.50 | trog_embedding_circle_star_in_red | relative_clause+spatial+adjective | the circle the star is in is red |
| 0.39 | -0.39 | 0.43 | 0.82 | trog_relclause_girl_chase_dog_that_big | reverse_agent+adjective | the girl chases the dog that is big |
| 0.37 | -0.37 | 0.24 | 0.61 | trog_preploc_car_truck_follow_drive | relative_clause+reverse_agent+spatial | The car that the truck followed is driving toward  |
| 0.37 | -0.37 | 0.49 | 0.86 | trog_postmod_boy_chasing_horse_tall | relative_clause+adjective | the boy chasing the horse is tall |
| 0.37 | 0.37 | 0.46 | 0.09 | trog_embedding_boy_dog_chase_big | relative_clause+reverse_agent+adjective | the boy the dog chases is big |
| 0.36 | -0.36 | 0.42 | 0.78 | trog_xnoty_horse_not_boy_stand | negation | the horse but not the boy is standing |
| 0.32 | -0.32 | 0.58 | 0.90 | trog_revactive_boy_chase_sheep | reverse_agent | the boy is chasing the sheep |
| 0.31 | 0.31 | 0.79 | 0.48 | trog_relclause_square_in_star_that_blue | spatial+adjective | the square is in the star that is blue |
| 0.31 | -0.31 | 0.58 | 0.89 | trog_preploc_plane_gray_above_cloud | relative_clause+spatial | The plane that is gray is above the clouds. |
| 0.28 | 0.28 | 0.74 | 0.46 | trog_neither_pencil_long_nor_red | negation+adjective | the pencil is neither long nor red |
| 0.27 | -0.27 | 0.67 | 0.94 | trog_relclause_person_chase_dog_that_big | reverse_agent+spatial+adjective | The person chases the dog that is big. |
| 0.27 | -0.27 | 0.70 | 0.97 | trog_inon_fork_on_shoe | spatial | the fork is on the shoe |
| 0.26 | 0.26 | 0.81 | 0.55 | trog_disjunctive_he_like_however_choose | disjunctive | He likes swimming. However, he chose to play socce |
| 0.26 | -0.26 | 0.44 | 0.70 | trog_revpassive_horse_chased_man | reverse_agent+passive | the horse is chased by the man |
| 0.25 | -0.25 | 0.12 | 0.37 | trog_postmod_duck_following_turtle_walking | relative_clause+reverse_agent | The duck following the turtle is walking across th |

## Prompt / input guidance
- High |err| on negation / reverse_agent / spatial / comparative → strengthen literal grammar checklist in `trogVlmAgent` SYSTEM_PROMPT.
- Negative bias (VLM harder than kids) is common on TROG — model misses structure kids get; not fixed by age persona.
