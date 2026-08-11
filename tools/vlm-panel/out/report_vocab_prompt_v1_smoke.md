# Picture Vocabulary (4-AFC) VLM difficulty screen

Generated: 2026-08-09T21:50:20.710Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## Run reliability (failure triage)

66 runs for vocab/en+nl: **64 done**, **2 failed**.
Failures by cause: TOOL/Google **1** · `-dev`/app **0** · unknown **1**
- ✅ No `-dev`/app failures — launch + audio looked healthy in this panel.
- TOOL-failure rate 1.5% (within tolerance) — those are Google, not `-dev`.

## EN
- Respondents: **12** | common items (coverage >= 8): **170** | matched to human: **162**
- Non-response: **0.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.83, median 0.98, max 0.99, SD 0.06 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **1** | HARD: **30** | CEILING: **132** | OK: 7
- Review list: `out/review_vocab_en.csv` | full screen: `out/screen_vocab_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=162: **0.432**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=36: **-0.330**
- BROKEN catch: of 5 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 31 VLM-flagged item(s), **7** are human-hard (p_correct < 0.5)
- CEILING catch: of 19 human-ceiling item(s) (p>0.95), VLM flagged **18**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on en matched items (n=162); saved `vlm-panel/calibration/vocab_en_bench.json`
- In-sample (n=162): MAE calibrated **0.124** vs raw **0.193**; Spearman calibrated **0.430** vs raw **0.432**
- Held-out CV (5, n=162): MAE calibrated **0.127** vs raw **0.193**; bias 0.001
- Held-out CV Spearman: calibrated **0.271** vs raw **0.432**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## Cross-language difficulty shift vs en (translation-breakage signal)

Spreadsheet triage: `out/review_xlang_vocab_<lang>.csv` (all items sorted by delta; |delta| ≥ 0.25 is a strong candidate).

### nl - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_nl | delta |
|---|---|---|---|

