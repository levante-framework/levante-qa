# Matrix Reasoning VLM difficulty screen

Generated: 2026-08-11T02:52:54.905Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## Run reliability (failure triage)

6 runs for matrix/en: **6 done**, **0 failed**.
Failures by cause: TOOL/Google **0** · `-dev`/app **0** · unknown **0**
- ✅ No `-dev`/app failures — launch + audio looked healthy in this panel.

## EN
- Respondents: **6** | common items (coverage >= 4): **80** | matched to human: **78**
- Non-response: **0.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.33, median 0.45, max 0.80, SD 0.17 -> OK

### Screen flags
- BROKEN (below chance): **11** | HARD: **19** | CEILING: **9** | OK: 41
- Review list: `out/review_matrix_en.csv` | full screen: `out/screen_matrix_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=78: **0.261**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=0: ****
- BROKEN catch: of 32 human below-chance item(s), VLM flagged **13** as BROKEN/HARD
- BROKEN/HARD precision: of 30 VLM-flagged item(s), **29** are human-hard (p_correct < 0.5)
- CEILING catch: of 0 human-ceiling item(s) (p>0.95), VLM flagged **0**

### Child performance prediction (calibrated p_vlm → p_pred_child)
- Calibrator: fitted on en matched items (n=78); saved `vlm-panel/calibration/matrix_en_bench.json`
- In-sample (n=78): MAE calibrated **0.097** vs raw **0.223**; Spearman calibrated **0.258** vs raw **0.261**
- Held-out CV (5, n=78): MAE calibrated **0.100** vs raw **0.223**; bias 0.002
- Held-out CV Spearman: calibrated **0.195** vs raw **0.261**
- Age columns `p_pred_age_*`: empirical age×item rates from levante-bench trials when available; otherwise task-norm scaling of `p_pred_child` (approximate).

