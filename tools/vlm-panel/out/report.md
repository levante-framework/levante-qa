# TROG VLM difficulty screen

Generated: 2026-08-01T16:29:09.090Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## Run reliability (failure triage)

145 runs for trog/de+en+es+nl: **110 done**, **35 failed**.
Failures by cause: TOOL/Google **4** · `-dev`/app **0** · unknown **31**
- ✅ No `-dev`/app failures — launch + audio looked healthy in this panel.
- TOOL-failure rate 2.8% (within tolerance) — those are Google, not `-dev`.

## EN
- Respondents: **16** | common items (coverage >= 10): **99** | matched to human: **99**
- Non-response: **0.8%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.55, median 0.81, max 0.89, SD 0.11 -> OK

### Screen flags
- BROKEN (below chance): **4** | HARD: **16** | CEILING: **30** | OK: 49
- Review list: `out/review_en.csv` | full screen: `out/screen_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=99: **0.581**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=65: **-0.317**
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 20 VLM-flagged item(s), **6** are human-hard (p_correct < 0.5)
- CEILING catch: of 15 human-ceiling item(s) (p>0.95), VLM flagged **12**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on en matched items (n=99); saved `vlm-panel/calibration/trog_en_bench.json`
- In-sample (n=99): MAE calibrated **0.072** vs raw **0.157**; Spearman calibrated **0.583** vs raw **0.581**
- Held-out CV (5, n=99): MAE calibrated **0.080** vs raw **0.157**; bias 0.000
- Held-out CV Spearman: calibrated **0.524** vs raw **0.581**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## DE
- Respondents: **32** | common items (coverage >= 20): **99** | matched to human: **99**
- Non-response: **31.9%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.51, median 0.74, max 0.83, SD 0.10 -> OK

### Screen flags
- BROKEN (below chance): **7** | HARD: **11** | CEILING: **15** | OK: 66
- Review list: `out/review_de.csv` | full screen: `out/screen_de.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=99: **0.599**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=83: **-0.188**
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 18 VLM-flagged item(s), **6** are human-hard (p_correct < 0.5)
- CEILING catch: of 15 human-ceiling item(s) (p>0.95), VLM flagged **8**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on de matched items (n=99); saved `vlm-panel/calibration/trog_de_bench.json`
- In-sample (n=99): MAE calibrated **0.063** vs raw **0.194**; Spearman calibrated **0.611** vs raw **0.599**
- Held-out CV (5, n=99): MAE calibrated **0.075** vs raw **0.194**; bias 0.004
- Held-out CV Spearman: calibrated **0.523** vs raw **0.599**
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

### de - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_de | delta |
|---|---|---|---|
| trog_abovebelow_comb_below_spoon | 1.00 | 0.31 | -0.69 |
| trog_xnoty_box_not_chair_red | 0.94 | 0.44 | -0.50 |
| trog_abovebelow_square_below_star | 0.88 | 0.44 | -0.44 |
| trog_embedding_book_pencil_on_red | 0.87 | 0.44 | -0.43 |
| trog_xnoty_horse_not_boy_stand | 0.44 | 0.06 | -0.38 |
| trog_disjunctive_although_hot_i_wear | 0.88 | 0.53 | -0.34 |
| trog_revpassrelclause_girl_wearing_backpack_shown_flower | 0.73 | 0.41 | -0.33 |
| trog_gerund_bump_table_case_book_fall | 0.81 | 0.50 | -0.31 |
| trog_xnoty_boy_sit_not_eat | 1.00 | 0.72 | -0.28 |
| trog_pluralpronoun_they_jump_wall | 0.94 | 0.69 | -0.25 |

### es - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_es | delta |
|---|---|---|---|
| trog_xnoty_box_not_chair_red | 0.94 | 0.34 | -0.59 |
| trog_abovebelow_comb_below_spoon | 1.00 | 0.50 | -0.50 |
| trog_xnoty_boy_sit_not_eat | 1.00 | 0.56 | -0.44 |
| trog_conditional_we_dance_if_music_play | 0.69 | 0.25 | -0.44 |
| trog_inon_circle_in_star | 0.63 | 0.25 | -0.38 |
| trog_disjunctive_although_hot_i_wear | 0.88 | 0.50 | -0.38 |
| trog_pluralpronoun_cow_look_them | 0.88 | 0.53 | -0.34 |
| trog_pluralpronoun_they_jump_wall | 0.94 | 0.59 | -0.34 |
| trog_embedding_book_pencil_on_red | 0.87 | 0.53 | -0.34 |
| trog_gerund_bump_table_case_book_fall | 0.81 | 0.50 | -0.31 |

### nl - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_nl | delta |
|---|---|---|---|

