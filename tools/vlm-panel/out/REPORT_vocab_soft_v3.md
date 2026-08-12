# Vocab soft-score smoke (YES|NO / pre-randomize digit)

**Date:** 2026-08-11
**Idea:** Use age-knows YES|NO (and pre-randomize digit) as continuous easiness to fight CEILING on hard 4-AFC accuracy.
**Runs:** `panel_vocab_en_(35flashlite|36flash)_a(6|8|11)_t(05|12)_r\d+$` (12 dirs; 2040 item×resp; 2040 with parseable YES|NO)
**Join:** transcript → `d_est_vocab_en.csv` / screen UIDs

## Signals

| Signal | Definition |
|--------|------------|
| `p_vlm` | P(correct) after v3 randomize-on-NO |
| `p_knows` | P(YES) — model says child would know the word |
| `p_soft` | YES→1, NO→0.25 (chance) |
| `p_model` | P(model digit correct) *before* randomize |
| `p_pred_child` | Existing calibrated child pass-rate from hard `p_vlm` |

## Ranking vs bank `d` (−p Spearman)

| Signal | n | ρ |
|--------|---|---|
| −p_vlm | 170 | **0.577** |
| −p_knows | 170 | **0.568** |
| −p_soft | 170 | **0.568** |
| −p_model | 170 | **0.313** |
| −p_pred_child (ref) | 170 | **0.533** |

## vs human pass-rate (Spearman, both easiness)

| Signal | n | ρ |
|--------|---|---|
| p_vlm vs p_human | 170 | **0.525** |
| p_knows vs p_human | 170 | **0.512** |

## Ceiling mass (p ≥ 0.90)

| Signal | CEILING / n | frac |
|--------|-------------|------|
| p_vlm | 116 / 170 | **0.68** |
| p_knows | 112 / 170 | **0.66** |
| p_model | 154 / 170 | **0.91** |
| p_soft | 112 / 170 | **0.66** |

## Verdict

**NO-GO** — soft YES/NO does not beat hard accuracy ranking on this panel

## Artifacts

- `out/screen_vocab_en_soft_v3.csv`
- This report
