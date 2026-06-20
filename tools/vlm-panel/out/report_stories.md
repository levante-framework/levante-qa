# Stories (Theory of Mind) VLM difficulty screen

Generated: 2026-06-14T22:40:19.062Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## DE
- Respondents: **18** | common items (coverage >= 11): **26** | matched to human: **23**
- Non-response: **33.3%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.65, median 0.81, max 0.92, SD 0.06 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **2** | HARD: **3** | CEILING: **14** | OK: 7
- Review list: `out/review_stories_de.csv` | full screen: `out/screen_stories_de.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=23: **0.433**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=9: **0.500**
- BROKEN catch: of 2 human below-chance item(s), VLM flagged **1** as BROKEN/HARD
- BROKEN/HARD precision: of 5 VLM-flagged item(s), **2** are human-hard (p_correct < 0.5)
- CEILING catch: of 5 human-ceiling item(s) (p>0.95), VLM flagged **5**

## EN
- Respondents: **18** | common items (coverage >= 11): **29** | matched to human: **26**
- Non-response: **33.3%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.62, median 0.79, max 0.86, SD 0.08 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **3** | HARD: **2** | CEILING: **11** | OK: 13
- Review list: `out/review_stories_en.csv` | full screen: `out/screen_stories_en.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=26: **0.572**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=14: **0.064**
- BROKEN catch: of 4 human below-chance item(s), VLM flagged **2** as BROKEN/HARD
- BROKEN/HARD precision: of 5 VLM-flagged item(s), **3** are human-hard (p_correct < 0.5)
- CEILING catch: of 0 human-ceiling item(s) (p>0.95), VLM flagged **0**

## ES
- Respondents: **18** | common items (coverage >= 11): **22** | matched to human: **21**
- Non-response: **48.4%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.64, median 0.77, max 0.86, SD 0.06 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **4** | HARD: **0** | CEILING: **11** | OK: 7
- Review list: `out/review_stories_es.csv` | full screen: `out/screen_stories_es.csv`

### Validation vs human labels (matched items)
- Spearman rho difficulty (p_vlm vs human p_correct), n=21: **0.537**
- Spearman rho discrimination (rpb_vlm vs human point_biserial), n=9: **0.286**
- BROKEN catch: of 3 human below-chance item(s), VLM flagged **1** as BROKEN/HARD
- BROKEN/HARD precision: of 4 VLM-flagged item(s), **2** are human-hard (p_correct < 0.5)
- CEILING catch: of 0 human-ceiling item(s) (p>0.95), VLM flagged **0**

## Cross-language difficulty shift vs en (translation-breakage signal)

### de - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_de | delta |
|---|---|---|---|
| tom_deception_reality_check_1 | 0.78 | 0.50 | -0.28 |
| tom_interpretation_emotion_reasoning | 0.61 | 0.44 | -0.17 |
| tom_reference_reference | 0.33 | 0.17 | -0.17 |
| tom_interpretation_false_belief | 0.67 | 0.50 | -0.17 |
| tom_moral_reasoning_reality_check | 0.94 | 0.83 | -0.11 |
| tom_moral_reasoning_false_belief | 0.78 | 0.72 | -0.06 |
| tom_deception_false_belief_3 | 1.00 | 0.94 | -0.06 |
| tom_reality_known_reality_check | 1.00 | 1.00 | 0.00 |
| tom_moral_reasoning_emotion_reasoning_2 | 0.11 | 0.11 | 0.00 |
| tom_interpretation_reality_check_1 | 1.00 | 1.00 | 0.00 |

### es - biggest drops vs en (candidate broken translations)
| item_uid | p_en | p_es | delta |
|---|---|---|---|
| tom_moral_reasoning_emotion_reasoning_2 | 0.11 | 0.00 | -0.11 |
| tom_reference_reference | 0.33 | 0.22 | -0.11 |
| tom_reality_known_false_belief | 0.72 | 0.61 | -0.11 |
| tom_reference_emotion_reasoning_2 | 1.00 | 0.94 | -0.06 |
| tom_reality_known_reality_check | 1.00 | 1.00 | 0.00 |
| tom_deception_emotion_reasoning_1 | 1.00 | 1.00 | 0.00 |
| tom_deception_false_belief_1 | 1.00 | 1.00 | 0.00 |
| tom_deception_false_belief_2 | 1.00 | 1.00 | 0.00 |
| tom_deception_false_belief_3 | 1.00 | 1.00 | 0.00 |
| tom_deception_reality_check_2 | 0.00 | 0.00 | 0.00 |

