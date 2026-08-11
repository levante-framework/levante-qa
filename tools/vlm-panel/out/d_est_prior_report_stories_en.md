# d_est prior apply — stories / en

Generated: 2026-08-11T06:10:48.136Z

## Policy

- Established bank `d` (finite) is **never** overwritten.
- Blank / NaN `d` is filled from hybrid `d_est` when a UID match exists.
- **Skip** fill when screen `flag=BROKEN` or UID is in `known_issues.json` (leave blank).
- This script does **not** upload to GCS; copy the draft CSV manually if promoting.

## Inputs

- Bank: `/home/david/levante/levante-qa/cypress/cache/sim-item-bank-theory-of-mind.csv`
- d_est: `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_stories_en.csv`
- known_issues: `/home/david/levante/levante-qa/tools/vlm-panel/known_issues.json` (0 stories UID(s))
- Fill column: `difficulty`

## Counts

| Metric | n |
|--------|---|
| Bank rows | 61 |
| Preserved (established d) | 0 |
| Filled from d_est | 21 |
| Skipped (BROKEN / known_issue) | 4 |
| Blank scored, no d_est match | 6 |
| Blank / non-scored (no answer) | 30 |

## Filled items

| item_uid | d_est | p_pred_child | flag | transcript |
|----------|-------|--------------|------|------------|
| tom_reality_known_false_belief | -0.636 | 0.820 | CEILING |  |
| tom_reality_known_reality_check | -0.636 | 0.820 | CEILING |  |
| tom_moral_reasoning_false_belief_1 | -0.636 | 0.820 | CEILING |  |
| tom_moral_reasoning_emotion_reasoning_1 | -1.035 | 0.820 | CEILING |  |
| tom_moral_reasoning_false_belief_2 | -0.636 | 0.820 | CEILING |  |
| tom_interpretation_reality_check_1 | -0.636 | 0.820 | CEILING |  |
| tom_interpretation_false_belief | -0.636 | 0.820 | CEILING |  |
| tom_interpretation_reality_check_2 | -0.636 | 0.820 | CEILING |  |
| tom_interpretation_emotion_reasoning | -1.035 | 0.820 | CEILING |  |
| tom_deception_emotion_reasoning_1 | -1.035 | 0.820 | CEILING |  |
| tom_deception_emotion_reasoning_2 | -1.035 | 0.820 | CEILING |  |
| tom_deception_false_belief_1 | -0.636 | 0.820 | CEILING |  |
| tom_deception_false_belief_2 | -0.636 | 0.820 | CEILING |  |
| tom_deception_false_belief_3 | 0.321 | 0.654 | OK |  |
| tom_deception_reality_check_1 | -0.636 | 0.820 | CEILING |  |
| tom_reference_reality_check | -0.931 | 0.820 | CEILING |  |
| tom_reference_emotion_reasoning_1 | -1.035 | 0.820 | CEILING |  |
| tom_reference_emotion_reasoning_2 | -1.035 | 0.820 | CEILING |  |
| tom_second_order_reality_check | -0.636 | 0.820 | CEILING |  |
| tom_second_order_false_belief_1 | -0.636 | 0.820 | CEILING |  |
| tom_second_order_false_belief_2 | -0.931 | 0.820 | CEILING |  |

## Skipped (left blank)

| item_uid | d_est (unused) | flag | skip reason |
|----------|----------------|------|-------------|
| tom_moral_reasoning_emotion_reasoning_2 | 0.908 | BROKEN | screen flag=BROKEN |
| tom_deception_reality_check_2 | 6.128 | BROKEN | screen flag=BROKEN |
| tom_deception_reality_check_3 | 6.128 | BROKEN | screen flag=BROKEN |
| tom_reference_reference | 1.667 | BROKEN | screen flag=BROKEN |

## Blank scored items without d_est

- tom_moral_reasoning_false_belief_3
- tom_moral_reasoning_reality_check_1
- tom_moral_reasoning_reality_check_2
- tom_second_order_false_belief_3
- tom_second_order_false_belief_4
- tom_second_order_false_belief_5

## Outputs

- Draft bank: `/home/david/levante/levante-qa/tools/vlm-panel/out/item_bank_stories_en_d_est_prior.csv`
- This report: `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_prior_report_stories_en.md`
