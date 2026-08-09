# TROG VLM difficulty screen

Generated: 2026-08-08T23:22:20.349Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## Run reliability (failure triage)

270 runs for trog/de+en+es+nl: **270 done**, **0 failed**.
Failures by cause: TOOL/Google **0** · `-dev`/app **0** · unknown **0**
- ✅ No `-dev`/app failures — launch + audio looked healthy in this panel.

## EN
- Respondents: **88** | common items (coverage >= 53): **99** | matched to human: **99**
- Non-response: **0.5%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.52, median 0.82, max 0.97, SD 0.12 -> OK

### Screen flags
- BROKEN (below chance): **4** | HARD: **11** | CEILING: **14** | OK: 70
- Known issues suppressed from review: **2** (`trog_conjcoord_say_sunny_however_rain`, `trog_preploc_car_truck_follow_drive`) — see `known_issues.json`
- Review list: `out/review_en.csv` | full screen: `out/screen_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=99: **0.637**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=80: **-0.160**
- BROKEN catch: of 2 human below-chance item(s), VLM flagged **2** as BROKEN/HARD
- BROKEN/HARD precision: of 15 VLM-flagged item(s), **6** are human-hard (p_correct < 0.5)
- CEILING catch: of 10 human-ceiling item(s) (p>0.95), VLM flagged **5**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on en matched items (n=99); saved `vlm-panel/calibration/trog_en_bench.json`
- In-sample (n=99): MAE calibrated **0.060** vs raw **0.108**; Spearman calibrated **0.667** vs raw **0.637**
- Held-out CV (5, n=99): MAE calibrated **0.073** vs raw **0.108**; bias 0.002
- Held-out CV Spearman: calibrated **0.559** vs raw **0.637**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## DE
- Respondents: **69** | common items (coverage >= 42): **99** | matched to human: **99**
- Non-response: **1.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.49, median 0.81, max 0.97, SD 0.13 -> OK

### Screen flags
- BROKEN (below chance): **2** | HARD: **13** | CEILING: **16** | OK: 68
- Known issues suppressed from review: **2** (`trog_conjcoord_say_sunny_however_rain`, `trog_preploc_car_truck_follow_drive`) — see `known_issues.json`
- Review list: `out/review_de.csv` | full screen: `out/screen_de.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=99: **0.616**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=82: **-0.055**
- BROKEN catch: of 2 human below-chance item(s), VLM flagged **2** as BROKEN/HARD
- BROKEN/HARD precision: of 15 VLM-flagged item(s), **6** are human-hard (p_correct < 0.5)
- CEILING catch: of 10 human-ceiling item(s) (p>0.95), VLM flagged **6**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on de matched items (n=99); saved `vlm-panel/calibration/trog_de_bench.json`
- In-sample (n=99): MAE calibrated **0.066** vs raw **0.118**; Spearman calibrated **0.641** vs raw **0.616**
- Held-out CV (5, n=99): MAE calibrated **0.082** vs raw **0.118**; bias 0.002
- Held-out CV Spearman: calibrated **0.543** vs raw **0.616**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## ES
- Respondents: **64** | common items (coverage >= 39): **99** | matched to human: **99**
- Non-response: **1.2%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.46, median 0.80, max 0.99, SD 0.14 -> OK

### Screen flags
- BROKEN (below chance): **2** | HARD: **13** | CEILING: **12** | OK: 72
- Known issues suppressed from review: **2** (`trog_conjcoord_say_sunny_however_rain`, `trog_preploc_car_truck_follow_drive`) — see `known_issues.json`
- Review list: `out/review_es.csv` | full screen: `out/screen_es.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=99: **0.593**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=86: **-0.126**
- BROKEN catch: of 2 human below-chance item(s), VLM flagged **2** as BROKEN/HARD
- BROKEN/HARD precision: of 15 VLM-flagged item(s), **6** are human-hard (p_correct < 0.5)
- CEILING catch: of 10 human-ceiling item(s) (p>0.95), VLM flagged **5**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on es matched items (n=99); saved `vlm-panel/calibration/trog_es_bench.json`
- In-sample (n=99): MAE calibrated **0.073** vs raw **0.129**; Spearman calibrated **0.623** vs raw **0.593**
- Held-out CV (5, n=99): MAE calibrated **0.086** vs raw **0.129**; bias 0.003
- Held-out CV Spearman: calibrated **0.491** vs raw **0.593**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## NL
- Respondents: **48** | common items (coverage >= 29): **98** | matched to human: **98**
- Non-response: **1.4%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.55, median 0.72, max 0.93, SD 0.13 -> OK

### Screen flags
- BROKEN (below chance): **3** | HARD: **13** | CEILING: **16** | OK: 66
- Known issues suppressed from review: **2** (`trog_conjcoord_say_sunny_however_rain`, `trog_preploc_car_truck_follow_drive`) — see `known_issues.json`
- Review list: `out/review_nl.csv` | full screen: `out/screen_nl.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=98: **0.639**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=0: ****
- BROKEN catch: of 2 human below-chance item(s), VLM flagged **1** as BROKEN/HARD
- BROKEN/HARD precision: of 16 VLM-flagged item(s), **5** are human-hard (p_correct < 0.5)
- CEILING catch: of 9 human-ceiling item(s) (p>0.95), VLM flagged **5**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on nl matched items (n=98); saved `vlm-panel/calibration/trog_nl_bench.json`
- In-sample (n=98): MAE calibrated **0.067** vs raw **0.152**; Spearman calibrated **0.669** vs raw **0.639**
- Held-out CV (5, n=98): MAE calibrated **0.084** vs raw **0.152**; bias -0.001
- Held-out CV Spearman: calibrated **0.574** vs raw **0.639**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## Cross-language difficulty shift vs en (translation-breakage signal)

Spreadsheet triage: `out/review_xlang_<lang>.csv` (all items sorted by delta; |delta| ≥ 0.25 is a strong candidate).

### de - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_de | delta |
|---|---|---|---|
| trog_abovebelow_square_below_star | 0.92 | 0.65 | -0.27 |
| trog_abovebelow_comb_below_spoon | 0.84 | 0.59 | -0.25 |
| trog_postmod_boy_chasing_horse_tall | 0.59 | 0.35 | -0.24 |
| trog_preploc_plane_gray_above_cloud | 0.72 | 0.57 | -0.16 |
| trog_compprepcond_instead_homework_she_do_puzzle | 0.91 | 0.75 | -0.16 |
| trog_relclause_person_chase_dog_that_big | 0.80 | 0.67 | -0.14 |
| trog_neither_boy_hat_nor_shoe | 0.76 | 0.63 | -0.13 |
| trog_postmod_duck_following_turtle_walking | 0.23 | 0.11 | -0.12 |
| trog_pluralpronoun_they_jump_wall | 0.93 | 0.81 | -0.12 |
| trog_embedding_cat_cow_chase_black | 0.39 | 0.28 | -0.12 |

### es - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_es | delta |
|---|---|---|---|
| trog_postmod_boy_chasing_horse_tall | 0.59 | 0.31 | -0.28 |
| trog_adjective_tall | 0.56 | 0.33 | -0.23 |
| trog_revactive_boy_chase_sheep | 0.69 | 0.47 | -0.22 |
| trog_preploc_plane_gray_above_cloud | 0.72 | 0.52 | -0.21 |
| trog_inon_circle_in_star | 0.80 | 0.61 | -0.19 |
| trog_revactive_girl_push_horse | 0.95 | 0.79 | -0.16 |
| trog_postmod_cow_chasing_cat_brown | 0.80 | 0.64 | -0.15 |
| trog_relclause_person_chase_dog_that_big | 0.80 | 0.66 | -0.15 |
| trog_abovebelow_square_below_star | 0.92 | 0.78 | -0.14 |
| trog_abovebelow_comb_below_spoon | 0.84 | 0.70 | -0.14 |

### nl - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_nl | delta |
|---|---|---|---|
| trog_preploc_plane_gray_above_cloud | 0.72 | 0.35 | -0.37 |
| trog_disjunctive_he_wear_despite_size | 0.67 | 0.33 | -0.33 |
| trog_conditional_teacher_give_if_stand_line | 0.61 | 0.32 | -0.29 |
| trog_revactive_cow_push_lady | 0.82 | 0.55 | -0.28 |
| trog_temporal_student_open_notebook_draw_tree | 0.84 | 0.57 | -0.28 |
| trog_pluralpronoun_cow_look_them | 0.85 | 0.58 | -0.27 |
| trog_inon_fork_on_shoe | 0.80 | 0.54 | -0.25 |
| trog_postmod_cow_chasing_cat_brown | 0.80 | 0.54 | -0.25 |
| trog_gerund_bump_table_case_book_fall | 0.86 | 0.62 | -0.25 |
| trog_comparative_shoe_bigger_bird | 0.89 | 0.65 | -0.24 |

