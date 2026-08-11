# d_est prior apply — matrix / en

Generated: 2026-08-11T02:52:55.049Z

## Policy

- Established bank `d` (finite) is **never** overwritten.
- Blank / NaN `d` is filled from hybrid `d_est` when a UID match exists.
- **Skip** fill when screen `flag=BROKEN` or UID is in `known_issues.json` (leave blank).
- This script does **not** upload to GCS; copy the draft CSV manually if promoting.

## Inputs

- Bank: `/home/david/levante/levante-qa/cypress/cache/sim-item-bank-matrix-reasoning.csv`
- d_est: `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_matrix_en.csv`
- known_issues: `/home/david/levante/levante-qa/tools/vlm-panel/known_issues.json` (0 matrix UID(s))
- Fill column: `difficulty`

## Counts

| Metric | n |
|--------|---|
| Bank rows | 80 |
| Preserved (established d) | 75 |
| Filled from d_est | 3 |
| Skipped (BROKEN / known_issue) | 0 |
| Blank scored, no d_est match | 2 |
| Blank / non-scored (no answer) | 0 |

## Filled items

| item_uid | d_est | p_pred_child | flag | transcript |
|----------|-------|--------------|------|------------|
| matrix_set1_md_mat52 | 0.759 | 0.303 | OK |  |
| matrix_set1_md_mat55 | 0.759 | 0.303 | OK |  |
| matrix_set1_md_mat56 | 0.698 | 0.337 | OK |  |

## Blank scored items without d_est

- tf1_1_M_ss3
- tf1_3_M_ss2

## Outputs

- Draft bank: `/home/david/levante/levante-qa/tools/vlm-panel/out/item_bank_matrix_en_d_est_prior.csv`
- This report: `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_prior_report_matrix_en.md`
