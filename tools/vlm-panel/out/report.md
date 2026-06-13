# TROG VLM difficulty screen

Generated: 2026-06-13T02:25:33.021Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## DE
- Respondents: **47** | common items (coverage >= 29): **99** | matched to human: **94**
- Spread: min 0.00, median 0.60, max 0.83, SD 0.33 -> OK

### Screen flags
- BROKEN (below chance): **12** | HARD: **6** | CEILING: **15** | OK: 66
- Review list: `out/review_de.csv` | full screen: `out/screen_de.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=94: **0.558**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=94: **-0.007**
- BROKEN catch: of 1 human below-chance item(s), VLM flagged **1** as BROKEN/HARD
- BROKEN/HARD precision: of 17 VLM-flagged item(s), **3** are human-hard (p_correct < 0.5)
- CEILING catch: of 43 human-ceiling item(s) (p>0.95), VLM flagged **11**

## EN
- Respondents: **48** | common items (coverage >= 29): **99** | matched to human: **88**
- Spread: min 0.00, median 0.62, max 0.86, SD 0.34 -> OK

### Screen flags
- BROKEN (below chance): **11** | HARD: **6** | CEILING: **20** | OK: 62
- Review list: `out/review_en.csv` | full screen: `out/screen_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=88: **0.389**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=87: **0.187**
- BROKEN catch: of 2 human below-chance item(s), VLM flagged **2** as BROKEN/HARD
- BROKEN/HARD precision: of 17 VLM-flagged item(s), **5** are human-hard (p_correct < 0.5)
- CEILING catch: of 3 human-ceiling item(s) (p>0.95), VLM flagged **0**

## ES
- Respondents: **47** | common items (coverage >= 29): **99** | matched to human: **97**
- Spread: min 0.00, median 0.59, max 0.80, SD 0.32 -> OK

### Screen flags
- BROKEN (below chance): **16** | HARD: **0** | CEILING: **11** | OK: 72
- Review list: `out/review_es.csv` | full screen: `out/screen_es.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=97: **0.623**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=96: **-0.208**
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 16 VLM-flagged item(s), **7** are human-hard (p_correct < 0.5)
- CEILING catch: of 6 human-ceiling item(s) (p>0.95), VLM flagged **4**

## Cross-language difficulty shift vs en (translation-breakage signal)

### de - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_de | delta |
|---|---|---|---|
| trog_revpassive_girl_chased_horse | 0.49 | 0.30 | -0.19 |
| trog_postmod_circle_in_star_yellow | 0.68 | 0.49 | -0.19 |
| trog_disjunctive_he_wear_despite_size | 0.34 | 0.17 | -0.17 |
| trog_notonly_girl_notonly_food_drink | 0.66 | 0.51 | -0.15 |
| trog_inon_fork_on_shoe | 0.43 | 0.30 | -0.13 |
| trog_neither_boy_hat_nor_shoe | 0.53 | 0.40 | -0.13 |
| trog_embedding_cat_cow_chase_black | 0.23 | 0.11 | -0.13 |
| trog_comparative_horse_taller_wall | 0.40 | 0.28 | -0.13 |
| trog_neither_dog_nor_ball_brown | 0.57 | 0.47 | -0.11 |
| trog_relclause_person_chase_dog_that_big | 0.40 | 0.30 | -0.11 |

### es - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_es | delta |
|---|---|---|---|
| trog_revpassive_girl_chased_horse | 0.49 | 0.21 | -0.28 |
| trog_inon_circle_in_star | 0.38 | 0.17 | -0.21 |
| trog_postmod_circle_in_star_yellow | 0.68 | 0.49 | -0.19 |
| trog_xnoty_boy_sit_not_eat | 0.55 | 0.38 | -0.17 |
| trog_xnoty_box_not_chair_red | 0.36 | 0.23 | -0.13 |
| trog_compprepcond_instead_homework_she_do_puzzle | 0.53 | 0.40 | -0.13 |
| trog_conditional_we_dance_if_music_play | 0.30 | 0.17 | -0.13 |
| trog_notonly_notonly_bird_flower_blue | 0.62 | 0.51 | -0.11 |
| trog_additive_hose_drink_sheep_eat | 0.32 | 0.21 | -0.11 |
| trog_revpassive_cow_pushed_man | 0.40 | 0.30 | -0.11 |

