# TROG VLM difficulty screen

Generated: 2026-08-03T04:11:46.023Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## Run reliability (failure triage)

241 runs for trog/de+en+es+nl: **240 done**, **1 failed**.
Failures by cause: TOOL/Google **1** · `-dev`/app **0** · unknown **0**
- ✅ No `-dev`/app failures — launch + audio looked healthy in this panel.
- TOOL-failure rate 0.4% (within tolerance) — those are Google, not `-dev`.

## EN
- Respondents: **16** | common items (coverage >= 10): **99** | matched to human: **99**
- Non-response: **0.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.80, median 0.95, max 0.98, SD 0.06 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **2** | HARD: **17** | CEILING: **57** | OK: 23
- Review list: `out/review_en.csv` | full screen: `out/screen_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=99: **0.455**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=39: **-0.181**
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 19 VLM-flagged item(s), **6** are human-hard (p_correct < 0.5)
- CEILING catch: of 15 human-ceiling item(s) (p>0.95), VLM flagged **12**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on en matched items (n=99); saved `vlm-panel/calibration/trog_en_bench.json`
- In-sample (n=99): MAE calibrated **0.076** vs raw **0.108**; Spearman calibrated **0.455** vs raw **0.455**
- Held-out CV (5, n=99): MAE calibrated **0.085** vs raw **0.108**; bias 0.006
- Held-out CV Spearman: calibrated **0.311** vs raw **0.455**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## DE
- Respondents: **16** | common items (coverage >= 10): **99** | matched to human: **99**
- Non-response: **0.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.80, median 0.95, max 0.97, SD 0.07 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **2** | HARD: **15** | CEILING: **53** | OK: 29
- Review list: `out/review_de.csv` | full screen: `out/screen_de.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=99: **0.487**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=45: **0.245**
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 17 VLM-flagged item(s), **6** are human-hard (p_correct < 0.5)
- CEILING catch: of 15 human-ceiling item(s) (p>0.95), VLM flagged **12**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on de matched items (n=99); saved `vlm-panel/calibration/trog_de_bench.json`
- In-sample (n=99): MAE calibrated **0.064** vs raw **0.105**; Spearman calibrated **0.498** vs raw **0.487**
- Held-out CV (5, n=99): MAE calibrated **0.074** vs raw **0.105**; bias 0.001
- Held-out CV Spearman: calibrated **0.377** vs raw **0.487**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## Cross-language difficulty shift vs en (translation-breakage signal)

Spreadsheet triage: `out/review_xlang_<lang>.csv` (all items sorted by delta; |delta| ≥ 0.25 is a strong candidate).

### de - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_de | delta |
|---|---|---|---|
| trog_embedding_cat_cow_chase_black | 0.69 | 0.19 | -0.50 |
| trog_comparative_horse_taller_wall | 0.81 | 0.63 | -0.19 |
| trog_notonly_notonly_girl_cat_sit | 1.00 | 0.81 | -0.19 |
| trog_relclause_person_chase_dog_that_big | 0.88 | 0.69 | -0.19 |
| trog_revactive_boy_chase_sheep | 0.88 | 0.75 | -0.13 |
| trog_revactive_man_chase_dog | 0.94 | 0.81 | -0.13 |
| trog_revactive_cow_push_lady | 0.88 | 0.75 | -0.13 |
| trog_comparative_fork_longer_pencil | 1.00 | 0.88 | -0.13 |
| trog_postmod_boy_chasing_horse_tall | 0.69 | 0.56 | -0.13 |
| trog_abovebelow_pencil_above_flower | 1.00 | 0.88 | -0.13 |

### es - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_es | delta |
|---|---|---|---|

### nl - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_nl | delta |
|---|---|---|---|

