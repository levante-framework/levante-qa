# TROG VLM difficulty screen

Generated: 2026-08-02T20:04:09.842Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## Run reliability (failure triage)

192 runs for trog/de+en+es+nl: **192 done**, **0 failed**.
Failures by cause: TOOL/Google **0** · `-dev`/app **0** · unknown **0**
- ✅ No `-dev`/app failures — launch + audio looked healthy in this panel.

## EN
- Respondents: **48** | common items (coverage >= 29): **99** | matched to human: **99**
- Non-response: **0.9%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.52, median 0.80, max 0.94, SD 0.13 -> OK

### Screen flags
- BROKEN (below chance): **5** | HARD: **10** | CEILING: **14** | OK: 70
- Review list: `out/review_en.csv` | full screen: `out/screen_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=99: **0.629**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=80: **-0.181**
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 15 VLM-flagged item(s), **6** are human-hard (p_correct < 0.5)
- CEILING catch: of 15 human-ceiling item(s) (p>0.95), VLM flagged **7**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on en matched items (n=99); saved `vlm-panel/calibration/trog_en_bench.json`
- In-sample (n=99): MAE calibrated **0.064** vs raw **0.144**; Spearman calibrated **0.646** vs raw **0.629**
- Held-out CV (5, n=99): MAE calibrated **0.074** vs raw **0.144**; bias 0.003
- Held-out CV Spearman: calibrated **0.561** vs raw **0.629**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## DE
- Respondents: **48** | common items (coverage >= 29): **99** | matched to human: **99**
- Non-response: **1.4%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.49, median 0.78, max 0.96, SD 0.13 -> OK

### Screen flags
- BROKEN (below chance): **3** | HARD: **13** | CEILING: **16** | OK: 67
- Review list: `out/review_de.csv` | full screen: `out/screen_de.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=99: **0.614**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=82: **-0.143**
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 16 VLM-flagged item(s), **6** are human-hard (p_correct < 0.5)
- CEILING catch: of 15 human-ceiling item(s) (p>0.95), VLM flagged **9**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on de matched items (n=99); saved `vlm-panel/calibration/trog_de_bench.json`
- In-sample (n=99): MAE calibrated **0.070** vs raw **0.150**; Spearman calibrated **0.626** vs raw **0.614**
- Held-out CV (5, n=99): MAE calibrated **0.084** vs raw **0.150**; bias 0.003
- Held-out CV Spearman: calibrated **0.513** vs raw **0.614**
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
| trog_abovebelow_square_below_star | 0.85 | 0.56 | -0.29 |
| trog_abovebelow_comb_below_spoon | 0.71 | 0.46 | -0.25 |
| trog_compprepcond_instead_homework_she_do_puzzle | 0.85 | 0.67 | -0.17 |
| trog_postmod_boy_chasing_horse_tall | 0.46 | 0.30 | -0.16 |
| trog_pluralpronoun_they_jump_wall | 0.88 | 0.73 | -0.15 |
| trog_pluralpronoun_elephant_carry_them | 0.98 | 0.83 | -0.15 |
| trog_revpassrelclause_girl_wearing_backpack_shown_flower | 0.58 | 0.45 | -0.13 |
| trog_xnoty_boy_sit_not_eat | 0.98 | 0.85 | -0.13 |
| trog_neither_boy_hat_nor_shoe | 0.67 | 0.56 | -0.12 |
| trog_3combo_boy_jump_box | 0.98 | 0.88 | -0.10 |

### es - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_es | delta |
|---|---|---|---|
| trog_postmod_boy_chasing_horse_tall | 0.46 | 0.22 | -0.23 |
| trog_revactive_girl_push_horse | 0.92 | 0.72 | -0.19 |
| trog_revactive_boy_chase_sheep | 0.58 | 0.42 | -0.17 |
| trog_xnoty_boy_sit_not_eat | 0.98 | 0.81 | -0.17 |
| trog_conditional_teacher_give_if_stand_line | 0.49 | 0.34 | -0.15 |
| trog_inon_circle_in_star | 0.63 | 0.48 | -0.15 |
| trog_conjcoord_monkey_eat_nor_swing | 0.79 | 0.65 | -0.14 |
| trog_prepphrase_he_find_under_couch | 0.81 | 0.68 | -0.13 |
| trog_preploc_plane_gray_above_cloud | 0.58 | 0.46 | -0.13 |
| trog_3combo_woman_carry_bag | 0.94 | 0.81 | -0.13 |

### nl - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_nl | delta |
|---|---|---|---|
| trog_disjunctive_he_wear_despite_size | 0.58 | 0.33 | -0.25 |
| trog_preploc_plane_gray_above_cloud | 0.58 | 0.35 | -0.23 |
| trog_embedding_book_pencil_on_red | 0.66 | 0.49 | -0.17 |
| trog_abovebelow_square_below_star | 0.85 | 0.69 | -0.17 |
| trog_revactive_cow_push_lady | 0.71 | 0.55 | -0.17 |
| trog_conditional_teacher_give_if_stand_line | 0.49 | 0.32 | -0.16 |
| trog_conjcoord_kid_clean_but_forget | 0.63 | 0.48 | -0.15 |
| trog_3combo_boy_jump_box | 0.98 | 0.83 | -0.15 |
| trog_pluralpronoun_cow_look_them | 0.73 | 0.58 | -0.15 |
| trog_comparative_shoe_bigger_bird | 0.79 | 0.65 | -0.15 |

