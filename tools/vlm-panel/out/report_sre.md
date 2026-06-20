# ROAR SRE (Sentence Reading Efficiency) VLM difficulty screen VLM difficulty screen

Generated: 2026-06-15T09:19:06.659Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## DE
- Respondents: **8** | common items (coverage >= 5): **8**
- Non-response: **0.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.86, median 1.00, max 1.00, SD 0.05 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **0** | HARD: **8** | CEILING: **0** | OK: 0
- Review list: `out/review_sre_de.csv` | full screen: `out/screen_sre_de.csv`

### Validation vs human labels
- Human item-level joins are not yet wired for this task in `diag_items_allstats_selected.csv` / translations.

## EN
- Respondents: **9** | common items (coverage >= 6): **4**
- Non-response: **0.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 1.00, median 1.00, max 1.00, SD 0.00 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **0** | HARD: **4** | CEILING: **0** | OK: 0
- Review list: `out/review_sre_en.csv` | full screen: `out/screen_sre_en.csv`

### Validation vs human labels
- Human item-level joins are not yet wired for this task in `diag_items_allstats_selected.csv` / translations.

## ES
- Respondents: **9** | common items (coverage >= 6): **3**
- Non-response: **0.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 1.00, median 1.00, max 1.00, SD 0.00 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **0** | HARD: **3** | CEILING: **0** | OK: 0
- Review list: `out/review_sre_es.csv` | full screen: `out/screen_sre_es.csv`

### Validation vs human labels
- Human item-level joins are not yet wired for this task in `diag_items_allstats_selected.csv` / translations.

## Cross-language difficulty shift vs en (translation-breakage signal)

### de - biggest drops vs en (candidate broken translations)
| item_key | p_en | p_de | delta |
|---|---|---|---|

### es - biggest drops vs en (candidate broken translations)
| item_key | p_en | p_es | delta |
|---|---|---|---|

