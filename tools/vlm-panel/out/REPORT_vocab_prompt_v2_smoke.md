# Vocab prompt v2 smoke — results

**Date:** 2026-08-09  
**Change:** Prompt **v2** in [`vocabPrompts.ts`](../../cypress/support/agents/prompts/vocabPrompts.ts) — age vocabulary limit (“typical *N*-year-old”) + stronger uncommon-word rule (“you may not know it — do not force a match”).  
**Run:** Same 12-cell live grid as v1 (`panel_grid_vocab_prompt_eval.json`, `--force --live`), all exit 0 (~2.3 h).  
**Artifacts:** `screen_vocab_en_prompt_v2_smoke.csv`, `report_vocab_prompt_v2_smoke.md`, log `out/logs/vocab_prompt_v2_smoke.log`.

## Headline verdict

| Compare to | Verdict |
|------------|---------|
| **vs v1** | **Better** — less CEILING, more OK, higher ρ, slightly lower mean `p_vlm` |
| **vs pre-v1 baseline** | **Still NO-GO** for full EN recollect — CEILING still elevated, OK still thin |

Keep ops `screen_vocab_en.csv` on the **pre-v1 baseline** until a prompt beats it.

## Screen flags (EN, 170 items)

| | Baseline | v1 smoke | **v2 smoke** |
|--|--------:|--------:|------------:|
| BROKEN | 1 | 1 | **2** |
| HARD | 27 | 30 | **25** |
| CEILING | **101** | 132 | **125** |
| OK | **41** | 7 | **18** |
| Analyze ρ(p_vlm, difficulty) | ~0.60 | 0.43 | **0.54** |
| Mean `p_vlm` | 0.938 | 0.940 | **0.918** |

v2 pulled ~7 items back from the v1 CEILING collapse and improved ranking vs kids, but still **+24 CEILING** and **−23 OK** vs baseline.

## Focus mismatches

| Word | Baseline | v1 | v2 | Kids `p_human` | Note |
|------|----------|----|----|----------------|------|
| turnstile | OK 0.92 | CEILING 1.00 | **OK 0.83** | 0.56 | Recovered; closer to kids |
| colony | HARD 0.80 | CEILING 1.00 | CEILING 1.00 | 0.51 | Still too easy |
| confectionery | OK 0.92 | OK 0.92 | OK 0.83 | 0.76 | Mild help |
| typewriter | OK 0.88 | CEILING 1.00 | **OK 0.92** | 0.81 | Recovered |
| waterwheel | OK 0.92 | CEILING 1.00 | CEILING 1.00 | 0.83 | Still CEILING |
| aesthete | HARD 0.64 | HARD 0.50 | **BROKEN 0.17** | 0.40 | Overshot (too hard) |
| farm | CEILING | CEILING | CEILING | 0.85 | Unchanged |

## Interpretation

Age-vocab + “don’t force a match” **moved the needle vs v1** (models slightly less certain overall), but not enough to restore baseline spread. Forced 4-AFC still produces many near-perfect items; vocabulary limits alone don’t create child-like error patterns at scale.

## Next

- Prefer **non-prompt levers** or a sharper v3 (e.g. age-6-only smoke, drop word-echo in `vocabUserText`, or explicit “unfamiliar → random among 4”) before another full 12-cell burn.
- Or stop prompt iteration for vocab and use baseline panel + human-params prefer for blank fills.
