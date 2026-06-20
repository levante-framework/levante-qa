# ROAR SWR (Single Word Recognition) VLM difficulty screen VLM difficulty screen

Generated: 2026-06-15T09:19:06.603Z

A pre-launch screen: a panel of VLM "children" of varying ability answers each item; items the panel passes **below chance** are flagged BROKEN (candidate mis-key/mistranslation), the panel-hardest items HARD, and panel-easiest CEILING (uninformative). Flags are validated against human pass-rates where those exist.

## DE
- Respondents: **8** | common items (coverage >= 5): **73**
- Non-response: **0.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.44, median 0.52, max 0.59, SD 0.04 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **33** | HARD: **0** | CEILING: **9** | OK: 31
- Review list: `out/review_swr_de.csv` | full screen: `out/screen_swr_de.csv`

### Validation vs human labels
- Human item-level joins are not yet wired for this task in `diag_items_allstats_selected.csv` / translations.

## EN
- Respondents: **9** | common items (coverage >= 6): **71**
- Non-response: **0.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.42, median 0.52, max 0.61, SD 0.05 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **30** | HARD: **0** | CEILING: **9** | OK: 32
- Review list: `out/review_swr_en.csv` | full screen: `out/screen_swr_en.csv`

### Validation vs human labels
- Human item-level joins are not yet wired for this task in `diag_items_allstats_selected.csv` / translations.

## ES
- Respondents: **8** | common items (coverage >= 5): **30**
- Non-response: **0.0%** of scored encounters had no parseable VLM choice (excluded, not scored wrong)
- Spread: min 0.42, median 0.50, max 0.61, SD 0.07 -> INADEQUATE

### Screen flags
- BROKEN (below chance): **15** | HARD: **0** | CEILING: **4** | OK: 11
- Review list: `out/review_swr_es.csv` | full screen: `out/screen_swr_es.csv`

### Validation vs human labels
- Human item-level joins are not yet wired for this task in `diag_items_allstats_selected.csv` / translations.

## Cross-language difficulty shift vs en (translation-breakage signal)

### de - biggest drops vs en (candidate broken translations)
| item_key | p_en | p_de | delta |
|---|---|---|---|
| backen | 0.67 | 0.00 | -0.67 |
| f hlen | 0.71 | 0.14 | -0.57 |
| wilfen | 0.89 | 0.43 | -0.46 |
| enttirken | 1.00 | 0.57 | -0.43 |
| trampolin | 0.56 | 0.17 | -0.39 |
| tag | 0.33 | 0.00 | -0.33 |
| gummistiefel | 0.33 | 0.00 | -0.33 |
| stretten | 0.89 | 0.57 | -0.32 |
| berraschend | 0.43 | 0.13 | -0.30 |
| schatten | 0.43 | 0.13 | -0.30 |

### es - biggest drops vs en (candidate broken translations)
| item_key | p_en | p_es | delta |
|---|---|---|---|

