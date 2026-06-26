# Picture Vocabulary (4-AFC) VLM difficulty screen

Generated: 2026-06-26T04:35:59.509Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## EN
- Respondents: **18** | common items (coverage >= 11): **170** | matched to human: **146**
- Non-response: **1.4%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.68, median 0.98, max 0.99, SD 0.10 -> OK

### Screen flags
- BROKEN (below chance): **1** | HARD: **25** | CEILING: **105** | OK: 39
- Review list: `out/review_vocab_en.csv` | full screen: `out/screen_vocab_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=146: **0.623**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=62: **-0.284**
- BROKEN catch: of 5 human below-chance item(s), VLM flagged **3** as BROKEN/HARD
- BROKEN/HARD precision: of 26 VLM-flagged item(s), **13** are human-hard (p_correct < 0.5)
- CEILING catch: of 3 human-ceiling item(s) (p>0.95), VLM flagged **3**

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

## Cross-language difficulty shift vs en (translation-breakage signal)

### nl - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_nl | delta |
|---|---|---|---|
| vocab_word_puddle | 1.00 | 0.43 | -0.57 |
| vocab_word_dumpling | 0.94 | 0.52 | -0.42 |
| vocab_word_mammalogy | 0.92 | 0.56 | -0.36 |
| vocab_word_triad | 1.00 | 0.68 | -0.32 |
| vocab_word_chat | 1.00 | 0.69 | -0.31 |
| vocab_word_pitcher | 1.00 | 0.71 | -0.29 |
| vocab_word_squash | 0.88 | 0.62 | -0.26 |
| vocab_word_slope | 0.61 | 0.36 | -0.25 |
| vocab_word_gutter | 1.00 | 0.75 | -0.25 |
| vocab_word_preserve | 0.89 | 0.64 | -0.25 |

