# Picture Vocabulary (4-AFC) VLM difficulty screen

Generated: 2026-08-01T21:42:13.805Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## Run reliability (failure triage)

54 runs for vocab/en+nl: **52 done**, **2 failed**.
Failures by cause: TOOL/Google **1** · `-dev`/app **0** · unknown **1**
- ✅ No `-dev`/app failures — launch + audio looked healthy in this panel.
- TOOL-failure rate 1.9% (within tolerance) — those are Google, not `-dev`.

## EN
- Respondents: **26** | common items (coverage >= 16): **170** | matched to human: **162**
- Non-response: **1.3%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.71, median 0.98, max 0.99, SD 0.08 -> OK

### Screen flags
- BROKEN (below chance): **1** | HARD: **27** | CEILING: **101** | OK: 41
- Review list: `out/review_vocab_en.csv` | full screen: `out/screen_vocab_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=162: **0.602**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=67: **-0.207**
- BROKEN catch: of 5 human below-chance item(s), VLM flagged **4** as BROKEN/HARD
- BROKEN/HARD precision: of 28 VLM-flagged item(s), **8** are human-hard (p_correct < 0.5)
- CEILING catch: of 25 human-ceiling item(s) (p>0.95), VLM flagged **24**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on en matched items (n=162); saved `vlm-panel/calibration/vocab_en_bench.json`
- In-sample (n=162): MAE calibrated **0.109** vs raw **0.168**; Spearman calibrated **0.611** vs raw **0.602**
- Held-out CV (5, n=162): MAE calibrated **0.116** vs raw **0.168**; bias -0.002
- Held-out CV Spearman: calibrated **0.506** vs raw **0.602**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## NL
- Respondents: **26** | common items (coverage >= 16): **169** | matched to human: **160**
- Non-response: **1.2%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.75, median 0.96, max 0.99, SD 0.07 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **1** | HARD: **25** | CEILING: **92** | OK: 51
- Review list: `out/review_vocab_nl.csv` | full screen: `out/screen_vocab_nl.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=160: **0.504**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=0: ****
- BROKEN catch: of 4 human below-chance item(s), VLM flagged **2** as BROKEN/HARD
- BROKEN/HARD precision: of 25 VLM-flagged item(s), **5** are human-hard (p_correct < 0.5)
- CEILING catch: of 25 human-ceiling item(s) (p>0.95), VLM flagged **22**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on nl matched items (n=160); saved `vlm-panel/calibration/vocab_nl_bench.json`
- In-sample (n=160): MAE calibrated **0.114** vs raw **0.167**; Spearman calibrated **0.538** vs raw **0.504**
- Held-out CV (5, n=160): MAE calibrated **0.121** vs raw **0.167**; bias 0.001
- Held-out CV Spearman: calibrated **0.405** vs raw **0.504**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## Cross-language difficulty shift vs en (translation-breakage signal)

### nl - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_nl | delta |
|---|---|---|---|
| vocab_word_puddle | 1.00 | 0.43 | -0.57 |
| vocab_word_dumpling | 0.96 | 0.52 | -0.44 |
| vocab_word_slope | 0.73 | 0.36 | -0.37 |
| vocab_word_pitcher | 1.00 | 0.71 | -0.29 |
| vocab_word_degression | 0.76 | 0.48 | -0.28 |
| vocab_word_rosette | 0.88 | 0.62 | -0.27 |
| vocab_word_gutter | 1.00 | 0.75 | -0.25 |
| vocab_word_precarious | 0.75 | 0.50 | -0.25 |
| vocab_word_aesthete | 0.64 | 0.40 | -0.24 |
| vocab_word_preserve | 0.88 | 0.64 | -0.23 |

