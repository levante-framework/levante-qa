# Stories (Theory of Mind) VLM difficulty screen

Generated: 2026-08-11T06:10:47.904Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## Run reliability (failure triage)

100 runs for stories/de+en+es+nl: **99 done**, **1 failed**.
Failures by cause: TOOL/Google **1** · `-dev`/app **0** · unknown **0**
- ✅ No `-dev`/app failures — launch + audio looked healthy in this panel.
- TOOL-failure rate 1.0% (within tolerance) — those are Google, not `-dev`.

## EN
- Respondents: **18** | common items (coverage >= 11): **29** | matched to human: **26**
- Non-response: **0.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.79, median 0.83, max 0.86, SD 0.03 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **4** | HARD: **1** | CEILING: **22** | OK: 2
- Review list: `out/review_stories_en.csv` | full screen: `out/screen_stories_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=26: **0.623**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=2: ****
- BROKEN catch: of 4 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 4 VLM-flagged item(s), **4** are human-hard (p_correct < 0.5)
- CEILING catch: of 1 human-ceiling item(s) (p>0.95), VLM flagged **1**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on en matched items (n=26); saved `vlm-panel/calibration/stories_en_bench.json`
- In-sample (n=26): MAE calibrated **0.091** vs raw **0.219**; Spearman calibrated **0.629** vs raw **0.623**
- Held-out CV (loo, n=26): MAE calibrated **0.105** vs raw **0.219**; bias 0.019
- Held-out CV Spearman: calibrated **-0.049** vs raw **0.623**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

## Cross-language difficulty shift vs en (translation-breakage signal)

Spreadsheet triage: `out/review_xlang_stories_<lang>.csv` (all items sorted by delta; |delta| ≥ 0.25 is a strong candidate).

### de - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_de | delta |
|---|---|---|---|

### es - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_es | delta |
|---|---|---|---|

### nl - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_nl | delta |
|---|---|---|---|

