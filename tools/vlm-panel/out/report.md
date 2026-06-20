# TROG VLM difficulty screen

Generated: 2026-06-14T22:40:18.534Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## DE
- Respondents: **32** | common items (coverage >= 20): **99** | matched to human: **94**
- Non-response: **31.9%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.51, median 0.74, max 0.83, SD 0.10 -> OK

### Screen flags
- BROKEN (below chance): **7** | HARD: **11** | CEILING: **15** | OK: 66
- Review list: `out/review_de.csv` | full screen: `out/screen_de.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=94: **0.558**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=82: **-0.186**
- BROKEN catch: of 1 human below-chance item(s), VLM flagged **1** as BROKEN/HARD
- BROKEN/HARD precision: of 17 VLM-flagged item(s), **3** are human-hard (p_correct < 0.5)
- CEILING catch: of 43 human-ceiling item(s) (p>0.95), VLM flagged **11**

## EN
- Respondents: **32** | common items (coverage >= 20): **99** | matched to human: **88**
- Non-response: **32.3%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.57, median 0.72, max 0.86, SD 0.09 -> OK

### Screen flags
- BROKEN (below chance): **8** | HARD: **9** | CEILING: **20** | OK: 62
- Review list: `out/review_en.csv` | full screen: `out/screen_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=88: **0.396**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=72: **-0.126**
- BROKEN catch: of 2 human below-chance item(s), VLM flagged **2** as BROKEN/HARD
- BROKEN/HARD precision: of 17 VLM-flagged item(s), **5** are human-hard (p_correct < 0.5)
- CEILING catch: of 3 human-ceiling item(s) (p>0.95), VLM flagged **0**

## ES
- Respondents: **32** | common items (coverage >= 20): **99** | matched to human: **97**
- Non-response: **31.9%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.54, median 0.71, max 0.80, SD 0.09 -> OK

### Screen flags
- BROKEN (below chance): **5** | HARD: **11** | CEILING: **11** | OK: 72
- Review list: `out/review_es.csv` | full screen: `out/screen_es.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=97: **0.623**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=85: **-0.077**
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 16 VLM-flagged item(s), **7** are human-hard (p_correct < 0.5)
- CEILING catch: of 6 human-ceiling item(s) (p>0.95), VLM flagged **4**

## Cross-language difficulty shift vs en (translation-breakage signal)

### de - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_de | delta |
|---|---|---|---|
| trog_revpassive_girl_chased_horse | 0.72 | 0.44 | -0.28 |
| trog_postmod_circle_in_star_yellow | 1.00 | 0.72 | -0.28 |
| trog_disjunctive_he_wear_despite_size | 0.50 | 0.25 | -0.25 |
| trog_notonly_girl_notonly_food_drink | 0.97 | 0.75 | -0.22 |
| trog_comparative_horse_taller_wall | 0.59 | 0.41 | -0.19 |
| trog_inon_fork_on_shoe | 0.63 | 0.44 | -0.19 |
| trog_neither_boy_hat_nor_shoe | 0.78 | 0.59 | -0.19 |
| trog_embedding_cat_cow_chase_black | 0.34 | 0.16 | -0.19 |
| trog_3combo_boy_jump_box | 1.00 | 0.84 | -0.16 |
| trog_notonly_box_notonly_big_blue | 0.97 | 0.81 | -0.16 |

### es - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_es | delta |
|---|---|---|---|
| trog_revpassive_girl_chased_horse | 0.72 | 0.31 | -0.41 |
| trog_inon_circle_in_star | 0.56 | 0.25 | -0.31 |
| trog_postmod_circle_in_star_yellow | 1.00 | 0.72 | -0.28 |
| trog_xnoty_boy_sit_not_eat | 0.81 | 0.56 | -0.25 |
| trog_xnoty_box_not_chair_red | 0.53 | 0.34 | -0.19 |
| trog_conditional_we_dance_if_music_play | 0.44 | 0.25 | -0.19 |
| trog_compprepcond_instead_homework_she_do_puzzle | 0.78 | 0.59 | -0.19 |
| trog_pluralpronoun_they_jump_wall | 0.75 | 0.59 | -0.16 |
| trog_revpassive_cow_pushed_man | 0.59 | 0.44 | -0.16 |
| trog_notonly_notonly_bird_flower_blue | 0.91 | 0.75 | -0.16 |

