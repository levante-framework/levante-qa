# Residual audit — trog / en

Generated: 2026-08-01T16:29:13.111Z
Source: `/home/david/levante/levante-qa/tools/vlm-panel/out/screen_en.csv`

## Summary
- Matched items: **99**
- Mean |p_vlm − p_human|: **0.157**
- Mean bias (vlm − human): **-0.084** (positive = VLM too easy)
- Mean |p_pred_child − p_human|: **0.072**

## By construction tag (mean |raw err|)
| tag | n | mae_raw | bias_raw |
|---|---:|---:|---:|
| passive | 4 | 0.370 | -0.313 |
| reverse_agent | 15 | 0.341 | -0.300 |
| temporal | 1 | 0.261 | -0.261 |
| comparative | 4 | 0.220 | -0.198 |
| relative_clause | 13 | 0.206 | -0.074 |
| spatial | 20 | 0.174 | -0.051 |
| adjective | 22 | 0.169 | -0.085 |
| disjunctive | 5 | 0.155 | -0.118 |
| other | 30 | 0.090 | -0.014 |
| negation | 17 | 0.071 | -0.017 |

## Top 20 raw residuals
| |err| | bias | p_vlm | p_human | item_uid | tags | transcript |
|---:|---:|---:|---:|---|---|---|
| 0.74 | -0.74 | 0.19 | 0.93 | trog_adjective_tall | adjective | Choose the picture that shows tall. |
| 0.67 | -0.67 | 0.25 | 0.92 | trog_relclause_girl_chase_dog_that_big | reverse_agent+adjective | the girl chases the dog that is big |
| 0.63 | -0.63 | 0.31 | 0.94 | trog_additive_hose_drink_sheep_eat | other | the horse drank water by the barn and the sheep at |
| 0.52 | -0.52 | 0.44 | 0.95 | trog_revactive_boy_chase_sheep | reverse_agent | the boy is chasing the sheep |
| 0.51 | -0.51 | 0.44 | 0.95 | trog_revactive_man_chase_dog | reverse_agent | the man is chasing the dog |
| 0.49 | -0.49 | 0.31 | 0.81 | trog_revpassive_cow_pushed_man | reverse_agent+passive | the cow is pushed by the man |
| 0.45 | -0.45 | 0.44 | 0.89 | trog_comparative_fork_longer_pencil | comparative | the fork is longer than the pencil |
| 0.45 | -0.45 | 0.44 | 0.89 | trog_abovebelow_pencil_above_flower | spatial | the pencil is above the flower |
| 0.45 | -0.45 | 0.44 | 0.89 | trog_revpassive_girl_chased_horse | reverse_agent+passive | the girl is chased by the horse |
| 0.42 | -0.42 | 0.06 | 0.49 | trog_postmod_duck_following_turtle_walking | relative_clause+reverse_agent | The duck following the turtle is walking across th |
| 0.42 | -0.42 | 0.38 | 0.80 | trog_revpassive_horse_chased_man | reverse_agent+passive | the horse is chased by the man |
| 0.42 | -0.42 | 0.00 | 0.42 | trog_disjunctive_despite_noise_she_focus | disjunctive | Despite the noise in the classroom, she focused on |
| 0.41 | -0.41 | 0.44 | 0.85 | trog_postmod_boy_chasing_horse_tall | relative_clause+adjective | the boy chasing the horse is tall |
| 0.37 | -0.37 | 0.50 | 0.87 | trog_conditional_teacher_give_if_stand_line | other | The teacher will give the students cake if they st |
| 0.35 | -0.35 | 0.44 | 0.79 | trog_relclause_dog_chase_horse_that_brown | reverse_agent | the dog chases the horse that is brown |
| 0.33 | -0.33 | 0.56 | 0.89 | trog_relclause_person_chase_dog_that_big | reverse_agent+spatial+adjective | The person chases the dog that is big. |
| 0.31 | -0.31 | 0.63 | 0.94 | trog_comparative_horse_taller_wall | comparative+adjective | the horse is taller than the wall |
| 0.31 | -0.31 | 0.44 | 0.75 | trog_xnoty_horse_not_boy_stand | negation | the horse but not the boy is standing |
| 0.29 | -0.29 | 0.63 | 0.92 | trog_inon_fork_on_shoe | spatial | the fork is on the shoe |
| 0.29 | 0.29 | 0.94 | 0.65 | trog_embedding_circle_star_in_red | relative_clause+spatial+adjective | the circle the star is in is red |

## Prompt / input guidance
- High |err| on negation / reverse_agent / spatial / comparative → strengthen literal grammar checklist in `trogVlmAgent` SYSTEM_PROMPT.
- Negative bias (VLM harder than kids) is common on TROG — model misses structure kids get; not fixed by age persona.
