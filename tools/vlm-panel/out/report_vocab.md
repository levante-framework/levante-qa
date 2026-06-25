# Picture Vocabulary (4-AFC) VLM difficulty screen

Generated: 2026-06-24T06:20:59.539Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## NL
- Respondents: **26** | common items (coverage >= 16): **169** | matched to human: **0**
- Non-response: **1.2%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.75, median 0.96, max 0.99, SD 0.07 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **1** | HARD: **25** | CEILING: **92** | OK: 51
- Review list: `out/review_vocab_nl.csv` | full screen: `out/screen_vocab_nl.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=0: ****
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=0: ****
- BROKEN catch: of 0 human below-chance item(s), VLM flagged **0** as BROKEN/HARD
- BROKEN/HARD precision: of 0 VLM-flagged item(s), **0** are human-hard (p_correct < 0.5)
- CEILING catch: of 0 human-ceiling item(s) (p>0.95), VLM flagged **0**

