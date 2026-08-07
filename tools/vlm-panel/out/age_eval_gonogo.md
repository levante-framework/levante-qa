# Age-conditional TROG eval — go / no-go

Generated: 2026-08-07T01:39:28.791Z

## Changes
- Age ≤8: light TROG system prompt (no grammar checklist) + no structure user hints
- Age ≥10: keep checklist + hints
- TROG persona mastery cues by age band in `childPersona.ts`

## Age gradient (respondent median accuracy, 35flashlite|36flash × a6|a13 × r1|r2)

| | before | after |
|--|--------|-------|
| med_p age 6 | 0.894 | 0.818 |
| med_p age 13 | 0.924 | 0.889 |
| **Δ med_p(13−6)** | 0.030 | **0.071** |
| item mean spread | 0.086 | 0.152 |
| item median spread | 0.000 | 0.000 |

Note: one cell failed (`35flashlite_a6_r1`); age-6 n_resp=3 after.

## Guardrails

- Age Δ improved by >0.02: PASS (0.030 → 0.071)
- Full-panel MAE p_pred after mix: **0.059** (limit ≤0.09) → PASS
- Age-eval-only raw MAE p_vlm vs human: 0.118 (n=99, runs=7; uncalibrated, informative only)

## Verdict: **GO** toward fuller EN recollect

Age Δ improved and full-panel calibrated MAE stayed ≤0.09. Consider expanding age-conditional prompts to a fuller EN force recollect.
