# d_est prior apply — vocab / en

Generated: 2026-08-10T23:09:51.822Z

## Policy

- Established bank `d` (finite) is **never** overwritten.
- Blank / NaN `d` is filled from hybrid `d_est` when a UID match exists.
- **Skip** fill when screen `flag=BROKEN` or UID is in `known_issues.json` (leave blank).
- This script does **not** upload to GCS; copy the draft CSV manually if promoting.

## Inputs

- Bank: `/home/david/levante/levante-qa/cypress/cache/sim-item-bank-vocab.csv`
- d_est: `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_vocab_en.csv`
- known_issues: `/home/david/levante/levante-qa/tools/vlm-panel/known_issues.json` (2 vocab UID(s))
- Fill column: `d`

## Counts

| Metric | n |
|--------|---|
| Bank rows | 173 |
| Preserved (established d) | 126 |
| Filled from d_est | 44 |
| Skipped (BROKEN / known_issue) | 0 |
| Blank scored, no d_est match | 0 |
| Blank / non-scored (no answer) | 3 |

## Filled items

| item_uid | d_est | p_pred_child | flag | transcript |
|----------|-------|--------------|------|------------|
| vocab__bamboo | -2.301 | 0.856 | CEILING | the bamboo |
| vocab__blender | -2.209 | 0.856 | CEILING | the blender |
| vocab__buffet | -2.255 | 0.856 | CEILING | the buffet |
| vocab__cake | -2.668 | 0.856 | CEILING | the cake |
| vocab__footbath | -1.257 | 0.800 | CEILING | the footbath |
| vocab__hedgehog | -2.134 | 0.856 | CEILING | the hedgehog |
| vocab__marshmallow | -2.092 | 0.856 | CEILING | the marshmallow |
| vocab__net | -2.764 | 0.856 | CEILING | the net |
| vocab__oil | -2.906 | 0.856 | CEILING | the oil |
| vocab__pie | -2.526 | 0.856 | CEILING | the pie |
| vocab__potato | -2.493 | 0.856 | CEILING | the potato |
| vocab__rice | -2.676 | 0.856 | CEILING | the rice |
| vocab__ship | -2.835 | 0.856 | CEILING | the ship |
| vocab__sink | -2.534 | 0.856 | CEILING | the sink |
| vocab__squash | -0.347 | 0.662 | OK | the squash |
| vocab__squirrel | -2.317 | 0.856 | CEILING | the squirrel |
| vocab__rubberband | -2.509 | 0.856 | CEILING | the rubber band |
| vocab__teabag | -1.724 | 0.808 | CEILING | the teabag |
| vocab__trumpet | -2.272 | 0.856 | CEILING | the trumpet |
| vocab__turtle | -2.409 | 0.856 | CEILING | the turtle |
| vocab__typewriter | -0.193 | 0.662 | OK | the typewriter |
| vocab__watermelon | -2.176 | 0.856 | CEILING | the watermelon |
| vocab__waterwheel | 0.001 | 0.631 | OK | the waterwheel |
| vocab__ant | -2.201 | 0.856 | CEILING | the ant |
| vocab__duck | -2.201 | 0.856 | CEILING | the duck |
| vocab__fork | -2.201 | 0.856 | CEILING | the fork |
| vocab__kitten | -2.201 | 0.856 | CEILING | the kitten |
| vocab__knee | -2.201 | 0.856 | CEILING | the knee |
| vocab__milkshake | -2.201 | 0.856 | CEILING | the milkshake |
| vocab__skin | -2.201 | 0.856 | CEILING | the skin |
| vocab__wall | -2.201 | 0.856 | CEILING | the wall |
| vocab__wheel | -2.201 | 0.856 | CEILING | the wheel |
| vocab__farm | -2.760 | 0.856 | CEILING | the farm |
| vocab__juggling | -2.125 | 0.856 | CEILING | juggling |
| vocab__ruler | -2.380 | 0.856 | CEILING | the ruler |
| vocab__tunnel | -2.547 | 0.856 | CEILING | the tunnel |
| vocab__knight | -2.564 | 0.856 | CEILING | the knight |
| vocab__applaud | -2.221 | 0.856 | CEILING | applaud |
| vocab__confectionery | -0.140 | 0.595 | HARD | the confectionery |
| vocab__divan | 0.398 | 0.553 | HARD | the divan |
| vocab__aesthete | 0.825 | 0.532 | HARD | the aesthete |
| vocab__colony | -0.233 | 0.624 | OK | the colony |
| vocab__suede | 0.130 | 0.624 | HARD | the suede |
| vocab__turnstile | 0.031 | 0.603 | HARD | the turnstile |

## Outputs

- Draft bank: `/home/david/levante/levante-qa/tools/vlm-panel/out/item_bank_vocab_en_d_est_prior.csv`
- This report: `/home/david/levante/levante-qa/tools/vlm-panel/out/d_est_prior_report_vocab_en.md`
