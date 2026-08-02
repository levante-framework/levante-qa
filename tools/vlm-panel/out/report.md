# TROG VLM difficulty screen

Generated: 2026-08-02T05:40:56.434Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## Run reliability (failure triage)

145 runs for trog/de+en+es+nl: **143 done**, **2 failed**.
Failures by cause: TOOL/Google **2** · `-dev`/app **0** · unknown **0**
- ✅ No `-dev`/app failures — launch + audio looked healthy in this panel.
- TOOL-failure rate 1.4% (within tolerance) — those are Google, not `-dev`.

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
- Respondents: **32** | common items (coverage >= 20): **99** | matched to human: **99**
- Non-response: **31.9%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.54, median 0.71, max 0.80, SD 0.09 -> OK

### Screen flags
- BROKEN (below chance): **5** | HARD: **11** | CEILING: **11** | OK: 72
- Review list: `out/review_es.csv` | full screen: `out/screen_es.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=99: **0.615**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=87: **-0.081**
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 16 VLM-flagged item(s), **6** are human-hard (p_correct < 0.5)
- CEILING catch: of 15 human-ceiling item(s) (p>0.95), VLM flagged **6**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on es matched items (n=99); saved `vlm-panel/calibration/trog_es_bench.json`
- In-sample (n=99): MAE calibrated **0.072** vs raw **0.198**; Spearman calibrated **0.633** vs raw **0.615**
- Held-out CV (5, n=99): MAE calibrated **0.085** vs raw **0.198**; bias 0.002
- Held-out CV Spearman: calibrated **0.536** vs raw **0.615**
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
| trog_xnoty_boy_sit_not_eat | 0.98 | 0.56 | -0.42 |
| trog_conditional_we_dance_if_music_play | 0.67 | 0.25 | -0.42 |
| trog_inon_circle_in_star | 0.63 | 0.25 | -0.38 |
| trog_xnoty_box_not_chair_red | 0.67 | 0.34 | -0.32 |
| trog_pluralpronoun_they_jump_wall | 0.88 | 0.59 | -0.28 |
| trog_compprepcond_instead_homework_she_do_puzzle | 0.85 | 0.59 | -0.25 |
| trog_gerund_bump_table_case_book_fall | 0.75 | 0.50 | -0.25 |
| trog_xnoty_horse_not_boy_stand | 0.40 | 0.16 | -0.24 |
| trog_comparative_fork_longer_pencil | 0.60 | 0.38 | -0.23 |
| trog_abovebelow_square_below_star | 0.85 | 0.63 | -0.23 |

### nl - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_nl | delta |
|---|---|---|---|

