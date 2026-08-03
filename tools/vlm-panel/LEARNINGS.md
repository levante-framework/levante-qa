# What we learned about using AI agents for testing

Plain-language summary from the EN VLM panel work (2026-08-01). Numbers live in [`RESULTS.md`](RESULTS.md).

## What we are trying to do

Before children take a new item or translation, we want a cheap answer to:
“About what fraction of kids will get this item right?”

We run vision-language models through the **real task in the browser** (same UI kids see), treat each model run as a synthetic respondent, then map their pass rates onto child pass rates with a calibrator.

## The big picture

| Approach | Good for | Not good for |
|----------|----------|--------------|
| **Ungated VLM panel + calibrator** | Predicting difficulty of **new / unscored** items | Replacing human psychometrics |
| **IRT / “sim_child” gate** | Mimicking known items with difficulty params | New items (no difficulty param → same guess for all) |
| **Daily translation screen (MQM + vision)** | Catching bad translations early | Estimating child % correct |

**Use the panel for prediction. Use cross-language panel drops for translation
breakage. Use the daily MQM/vision screen for copy quality. Don’t confuse them.**

## Cross-language TROG (highest-value screen)

Same item in English vs German (etc.): if agents ace EN but collapse in DE, the
translation or answer key is the prime suspect. That signal is stronger than
single-language “HARD” flags because model blind spots often cancel.

```bash
# Refresh locales onto current prompts (de/es need --force; en/nl resume):
node tools/vlm-panel/run_langs_trog.mjs
# Log: out/recollect_xlang.log

node tools/vlm-panel/analyze.mjs --task trog --human-source=bench
# Triage: out/review_xlang_de.csv (etc). strong_delta=yes means |delta|≥0.25
```

**Stale-panel warning:** June 2026 de/es panels used old prompts; Aug 2026 EN
used new ones. Do not trust cross-lang deltas until de/es are force-refreshed
(via `run_langs_trog.mjs` defaults).

## What worked

1. **Calibrate.** Raw model accuracy is not child accuracy. A simple curve (`p_vlm` → `p_pred_child`) cuts average error a lot (TROG ~19 pp → ~7 pp once calibrated).
2. **Use real trial data as the target.** Aggregate `correct` from levante-bench trials. Don’t trust vocab “proportions” option columns.
3. **Fix the prompts where the model systematically differs from kids.**
   - TROG: models miss grammar kids get (negation, who-did-what, spatial words). Checklist-style hints helped.
   - Vocab: models know rare adult words kids don’t. Prompt tweaks barely moved this — it’s a knowledge ceiling, not a wording bug.
4. **Collect enough successful runs.** Early TROG results with only 1/3 of cells done looked weaker; after filling the panel, gains were clearer and more trustworthy.
5. **Resume by default.** Re-running everything is expensive. The runner now skips finished cells and retries failures automatically. Use `--force` only when you intentionally want to redo successes (e.g. prompt change on cells that already passed).

## What didn’t work (or wasn’t worth it)

- Soft “act like a 6-year-old” personas for age curves — already failed; don’t revive without new evidence.
- Relying on Pro for panel fill — much slower/costlier, flakier; **off by default** in grids.
- Staying on Gemini 2.5 past ~2026-10-16 EOL — defaults moved to `gemini-3.5-flash-lite` + `gemini-3.6-flash`.
- Treating every Cypress failure as an API / token problem — many crashes never called the model at all (startup timeouts).

## Practical rules of thumb

- **Agents are a screen, not ground truth.** They surface “look at this item” candidates.
- **Cross-check languages when you can.** A model that aces English but bombs the same item in German is a strong translation/keying signal.
- **Bias depends on the task.** Vocab agents tend to be *too good*; TROG agents tend to be *too hard* on structure.
- **Bill the right meter.** Panel cells use Google Gemini keys. Cursor chat tokens are a separate cost.
- **Don’t `--force` out of habit.** Resume is the default path.
- **Default panel models:** `gemini-3.5-flash-lite` + `gemini-3.6-flash` (no Pro). Gemini 2.5 shuts down ~2026-10-16.

## Where we landed (EN, after recollect)

- **TROG:** Prompt + calibration improvements are real (better absolute error and ranking vs kids).
- **Vocab:** Calibration helps; rare-word residual is adult lexical knowledge. Analyze applies a mild wordfreq Zipf shrink into `p_pred_child` for zipf<3 (`vocab_lexicon.json`, β≈0.1) — not more prompting. Heavier blends hurt MAE (Zipf ≠ child AoA).

## Operator extras (7–10)

```bash
# Rebuild Zipf lexicon (needs wordfreq once): python3 tools/vlm-panel/build_vocab_lexicon.py
# Spatial/negation smoke vs out/screen_en.csv:
node tools/vlm-panel/check_trog_smoke.mjs
# Matched 3.x xlang force-all (long):
bash tools/vlm-panel/run_xlang_pipeline_3x.sh
# Limited 3.x check (EN+DE, 2 repeats) + compare to frozen 2.5 triage:
bash tools/vlm-panel/run_xlang_limited_3x.sh
# Gemini usage jsonl → summary (after panel cells with QA_RUN_ID):
node tools/vlm-panel/aggregate_usage.mjs
```

## Commands (operator)

```bash
# Resume: only pending / failed cells
node tools/vlm-panel/run_panel.mjs --grid tools/vlm-panel/panel_grid.json --lang en-US

# After collection
node tools/vlm-panel/analyze.mjs --task trog --human-source=bench
node tools/vlm-panel/analyze.mjs --task vocab --human-source=bench
node tools/vlm-panel/fit_bench_calibrator.mjs
node tools/vlm-panel/audit_residuals.mjs
```
