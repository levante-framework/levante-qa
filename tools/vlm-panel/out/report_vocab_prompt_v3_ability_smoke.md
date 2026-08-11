# Picture Vocabulary (4-AFC) VLM difficulty screen

Generated: 2026-08-10T23:07:46.648Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## Run reliability (failure triage)

78 runs for vocab/en+nl: **75 done**, **3 failed**.
Failures by cause: TOOL/Google **2** · `-dev`/app **0** · unknown **1**
- ✅ No `-dev`/app failures — launch + audio looked healthy in this panel.
- TOOL-failure rate 2.6% (within tolerance) — those are Google, not `-dev`.

## EN
- Respondents: **12** | common items (coverage >= 8): **170** | matched to human: **162**
- Non-response: **0.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.72, median 0.88, max 0.96, SD 0.08 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **2** | HARD: **29** | CEILING: **107** | OK: 32
- Known issues suppressed from review: **1** (`vocab_word_claw`) — see `known_issues.json`
- Review list: `out/review_vocab_en.csv` | full screen: `out/screen_vocab_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=162: **0.637**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=61: **0.177**
- BROKEN catch: of 5 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 31 VLM-flagged item(s), **7** are human-hard (p_correct < 0.5)
- CEILING catch: of 19 human-ceiling item(s) (p>0.95), VLM flagged **19**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on en matched items (n=162); saved `vlm-panel/calibration/vocab_en_bench.json`
- In-sample (n=162): MAE calibrated **0.108** vs raw **0.171**; Spearman calibrated **0.639** vs raw **0.637**
- Held-out CV (5, n=162): MAE calibrated **0.113** vs raw **0.171**; bias 0.000
- Held-out CV Spearman: calibrated **0.514** vs raw **0.637**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## Cross-language difficulty shift vs en (translation-breakage signal)

Spreadsheet triage: `out/review_xlang_vocab_<lang>.csv` (all items sorted by delta; |delta| ≥ 0.25 is a strong candidate).

### nl - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_nl | delta |
|---|---|---|---|

