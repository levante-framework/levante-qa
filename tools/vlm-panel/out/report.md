# TROG VLM difficulty screen

Generated: 2026-08-06T06:54:59.843Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## Run reliability (failure triage)

241 runs for trog/de+en+es+nl: **241 done**, **0 failed**.
Failures by cause: TOOL/Google **0** · `-dev`/app **0** · unknown **0**
- ✅ No `-dev`/app failures — launch + audio looked healthy in this panel.

## EN
- Respondents: **80** | common items (coverage >= 48): **99** | matched to human: **99**
- Non-response: **0.6%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.52, median 0.85, max 0.99, SD 0.13 -> OK

### Screen flags
- BROKEN (below chance): **3** | HARD: **12** | CEILING: **14** | OK: 70
- Review list: `out/review_en.csv` | full screen: `out/screen_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=99: **0.636**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=80: **-0.148**
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 15 VLM-flagged item(s), **6** are human-hard (p_correct < 0.5)
- CEILING catch: of 15 human-ceiling item(s) (p>0.95), VLM flagged **7**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on en matched items (n=99); saved `vlm-panel/calibration/trog_en_bench.json`
- In-sample (n=99): MAE calibrated **0.063** vs raw **0.104**; Spearman calibrated **0.690** vs raw **0.636**
- Held-out CV (5, n=99): MAE calibrated **0.078** vs raw **0.104**; bias 0.002
- Held-out CV Spearman: calibrated **0.575** vs raw **0.636**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## DE
- Respondents: **65** | common items (coverage >= 39): **99** | matched to human: **99**
- Non-response: **1.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.49, median 0.81, max 0.97, SD 0.13 -> OK

### Screen flags
- BROKEN (below chance): **3** | HARD: **14** | CEILING: **15** | OK: 67
- Review list: `out/review_de.csv` | full screen: `out/screen_de.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=99: **0.615**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=83: **-0.064**
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 17 VLM-flagged item(s), **6** are human-hard (p_correct < 0.5)
- CEILING catch: of 15 human-ceiling item(s) (p>0.95), VLM flagged **9**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on de matched items (n=99); saved `vlm-panel/calibration/trog_de_bench.json`
- In-sample (n=99): MAE calibrated **0.064** vs raw **0.121**; Spearman calibrated **0.624** vs raw **0.615**
- Held-out CV (5, n=99): MAE calibrated **0.078** vs raw **0.121**; bias 0.002
- Held-out CV Spearman: calibrated **0.564** vs raw **0.615**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## ES
- Respondents: **48** | common items (coverage >= 29): **99** | matched to human: **99**
- Non-response: **1.7%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.46, median 0.74, max 0.92, SD 0.13 -> OK

### Screen flags
- BROKEN (below chance): **6** | HARD: **9** | CEILING: **12** | OK: 72
- Review list: `out/review_es.csv` | full screen: `out/screen_es.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=99: **0.603**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=86: **-0.171**
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 15 VLM-flagged item(s), **6** are human-hard (p_correct < 0.5)
- CEILING catch: of 15 human-ceiling item(s) (p>0.95), VLM flagged **8**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on es matched items (n=99); saved `vlm-panel/calibration/trog_es_bench.json`
- In-sample (n=99): MAE calibrated **0.069** vs raw **0.166**; Spearman calibrated **0.637** vs raw **0.603**
- Held-out CV (5, n=99): MAE calibrated **0.080** vs raw **0.166**; bias 0.003
- Held-out CV Spearman: calibrated **0.509** vs raw **0.603**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## NL
- Respondents: **48** | common items (coverage >= 29): **98** | matched to human: **98**
- Non-response: **1.4%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.55, median 0.72, max 0.93, SD 0.13 -> OK

### Screen flags
- BROKEN (below chance): **3** | HARD: **13** | CEILING: **16** | OK: 66
- Review list: `out/review_nl.csv` | full screen: `out/screen_nl.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=98: **0.654**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=0: ****
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **2** as BROKEN/HARD
- BROKEN/HARD precision: of 16 VLM-flagged item(s), **5** are human-hard (p_correct < 0.5)
- CEILING catch: of 14 human-ceiling item(s) (p>0.95), VLM flagged **7**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on nl matched items (n=98); saved `vlm-panel/calibration/trog_nl_bench.json`
- In-sample (n=98): MAE calibrated **0.062** vs raw **0.157**; Spearman calibrated **0.678** vs raw **0.654**
- Held-out CV (5, n=98): MAE calibrated **0.078** vs raw **0.157**; bias -0.001
- Held-out CV Spearman: calibrated **0.591** vs raw **0.654**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## Cross-language difficulty shift vs en (translation-breakage signal)

Spreadsheet triage: `out/review_xlang_<lang>.csv` (all items sorted by delta; |delta| ≥ 0.25 is a strong candidate).

### de - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_de | delta |
|---|---|---|---|
| trog_abovebelow_square_below_star | 0.91 | 0.66 | -0.25 |
| trog_abovebelow_comb_below_spoon | 0.79 | 0.58 | -0.20 |
| trog_embedding_cat_cow_chase_black | 0.51 | 0.32 | -0.18 |
| trog_relclause_person_chase_dog_that_big | 0.77 | 0.62 | -0.16 |
| trog_preploc_car_truck_follow_drive | 0.36 | 0.21 | -0.15 |
| trog_compprepcond_instead_homework_she_do_puzzle | 0.88 | 0.75 | -0.13 |
| trog_pluralpronoun_elephant_carry_them | 0.99 | 0.86 | -0.13 |
| trog_pluralpronoun_they_jump_wall | 0.93 | 0.80 | -0.13 |
| trog_revactive_boy_chase_sheep | 0.69 | 0.57 | -0.12 |
| trog_revpassrelclause_girl_wearing_backpack_shown_flower | 0.66 | 0.55 | -0.12 |

### es - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_es | delta |
|---|---|---|---|
| trog_conditional_teacher_give_if_stand_line | 0.66 | 0.34 | -0.32 |
| trog_adjective_tall | 0.47 | 0.17 | -0.31 |
| trog_inon_circle_in_star | 0.78 | 0.48 | -0.30 |
| trog_revactive_boy_chase_sheep | 0.69 | 0.42 | -0.27 |
| trog_postmod_boy_chasing_horse_tall | 0.47 | 0.22 | -0.25 |
| trog_postmod_cow_chasing_cat_brown | 0.75 | 0.52 | -0.23 |
| trog_revactive_girl_push_horse | 0.95 | 0.72 | -0.23 |
| trog_inon_fork_on_shoe | 0.78 | 0.56 | -0.21 |
| trog_temporal_student_open_notebook_draw_tree | 0.82 | 0.63 | -0.20 |
| trog_preploc_plane_gray_above_cloud | 0.66 | 0.46 | -0.20 |

### nl - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_nl | delta |
|---|---|---|---|
| trog_conditional_teacher_give_if_stand_line | 0.66 | 0.32 | -0.34 |
| trog_disjunctive_he_wear_despite_size | 0.65 | 0.33 | -0.31 |
| trog_preploc_plane_gray_above_cloud | 0.66 | 0.35 | -0.30 |
| trog_temporal_student_open_notebook_draw_tree | 0.82 | 0.57 | -0.26 |
| trog_embedding_book_pencil_on_red | 0.75 | 0.49 | -0.26 |
| trog_pluralpronoun_cow_look_them | 0.84 | 0.58 | -0.25 |
| trog_conjcoord_kid_clean_but_forget | 0.72 | 0.48 | -0.24 |
| trog_revactive_cow_push_lady | 0.78 | 0.55 | -0.23 |
| trog_inon_fork_on_shoe | 0.78 | 0.54 | -0.23 |
| trog_gerund_bump_table_case_book_fall | 0.85 | 0.62 | -0.23 |

