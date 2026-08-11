# Vocab prompt v1 smoke — results

**Date:** 2026-08-09  
**Change:** Age-conditional prompts in [`vocabPrompts.ts`](../../cypress/support/agents/prompts/vocabPrompts.ts) (v1).  
**Run:** `panel_grid_vocab_prompt_eval.json` — 12 live cells (`--force --live`), all exit 0 (~2.5 h).  
**Artifacts:** `screen_vocab_en_prompt_v1_smoke.csv`, `report_vocab_prompt_v1_smoke.md`, log `out/logs/vocab_prompt_v1_smoke.log`.

> Vocab has **no** offline asset replay. Always use `--live`. Default replay would use TROG assets.

## Headline verdict: **NO-GO** for full EN recollect

v1 made the panel **easier / more CEILING-heavy**, not more discriminating. Do not promote this prompt to a full bank recollect.

## Screen flags (EN, 170 items)

| | Baseline (pre-v1) | Prompt v1 smoke (12 cells) |
|--|------------------:|---------------------------:|
| BROKEN | 1 | 1 |
| HARD | 27 | **30** |
| CEILING | **101** | **132** (↑31) |
| OK | **41** | **7** (↓34) |
| Analyze ρ(p_vlm, difficulty) | ~0.60 | **0.43** |
| Mean `p_vlm` | 0.938 | 0.940 |

**47** items changed flag; **33** newly entered CEILING; only **2** left CEILING (`coaster`, `footbath`).

## Focus mismatches (why we cared)

| Word | Baseline | Smoke | Movement |
|------|----------|-------|----------|
| turnstile | OK, p_vlm 0.92 | **CEILING 1.00** | Worse (AI even easier) |
| colony | HARD 0.80 | **CEILING 1.00** | Worse |
| confectionery | OK 0.92 | OK 0.92 | Flat |
| typewriter | OK 0.88 | **CEILING 1.00** | Worse |
| waterwheel | OK 0.92 | **CEILING 1.00** | Worse |
| footbath | CEILING 1.00 | OK 0.92 | Slightly better |
| aesthete | HARD 0.64 | HARD 0.50 | Slightly harder (good direction) |
| farm / buffet / cake | CEILING | CEILING | Unchanged easy |

## Interpretation

Anti-stretch / “ordinary child meaning” wording did **not** reduce CEILING pile-up under this grid. With only 12 cells (vs fuller historical panel), variance is higher, but the direction is clear: **more** perfect scores, **fewer** OK items, weaker difficulty correlation.

Likely: the young/checklist split and restated word in `vocabUserText` did not add useful uncertainty; models still dominate picture–word matching.

## Next (if iterating)

- **v2 ideas:** stronger “if the word is uncommon, you may not know it — do not force a match”; or age-6 only on a tiny grid; or drop `vocabUserText` word echo and re-smoke.
- Keep baseline `screen_vocab_en.csv` (restored) for ops/`d_est` until a GO prompt.
- Optional later: prefer-human-params fill for blanks (separate from prompts).

## Commands used

```bash
node tools/vlm-panel/run_panel.mjs \
  --grid tools/vlm-panel/panel_grid_vocab_prompt_eval.json --force --live

node tools/vlm-panel/analyze.mjs --task vocab --human-source=bench \
  --run-id-re 'panel_vocab_en_(35flashlite|36flash)_a(6|8|11)_r[12]$'
# then copied smoke screen → screen_vocab_en_prompt_v1_smoke.csv
# and restored screen_vocab_en.csv from pre-v1 baseline
```
