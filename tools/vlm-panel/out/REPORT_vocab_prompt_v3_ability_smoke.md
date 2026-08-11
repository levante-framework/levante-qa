# Vocab prompt v3 ability-spread smoke — results

**Date:** 2026-08-10 (updated after failed-cell retry + claw known-issue)  
**Change:** Prompt/agent **v3** — reply `DIGIT YES|NO`; if **NO**, agent picks uniform random 1–4. Temperature ladder `0.5` / `1.2` on **current** models only.  
**Grid:** [`panel_grid_vocab_ability_v3.json`](../panel_grid_vocab_ability_v3.json) — 12 cells (`--force --live`).  
**Artifacts:** `screen_vocab_en_prompt_v3_ability_smoke.csv`, log `out/logs/vocab_prompt_v3_ability_smoke.log`.

## Headline verdict: **GO vs v1/v2; competitive with baseline on current models**

| | Baseline (~26 resp, 2.5 mix) | v1 | v2 | **v3 (12/12 cells)** |
|--|----------------------------:|---:|---:|---------------------:|
| Respondents / item | ~26 | 12 | 12 | **12** |
| BROKEN | 1 | 1 | 2 | **2** (claw known + gesticulate) |
| HARD | 27 | 30 | 25 | **29** |
| CEILING | 101 | 132 | 125 | **107** |
| OK | 41 | 7 | 18 | **32** |
| Analyze ρ(p_vlm, difficulty) | ~0.60 | 0.43 | 0.54 | **0.64** |
| Mean `p_vlm` | 0.938 | 0.940 | 0.918 | ~0.84 |

## Claw

`vocab_word_claw` / `vocab__claw` added to [`known_issues.json`](../known_issues.json) — totally bad item; suppressed from `review_vocab_*.csv` triage and skipped for `d_est` prior fill. Still appears on `screen_*.csv` with `KNOWN:` reason.

## Failed cell retry

`panel_vocab_en_36flash_a11_t05_r1` initially failed mid-run. Retried successfully (~14 min). First retry wrote the wrong runId (dropped `_t05_` when `temperatures` length was 1); fixed in `run_panel.mjs` (always stamp temp when `temperatures[]` is set) and logs moved to the correct directory. Full **12/12** respondents in analyze.

## BROKEN after full panel + claw ignore

| Item | `p_vlm` | `p_human` | Action |
|------|--------:|----------:|--------|
| claw | 0.00 | 0.09 | **Ignore** (known_issues) |
| gesticulate | 0.08 | 0.56 | Still flagged — likely NO→random overshoot |

## Research note

Adopted as the default **research** panel path for vocab on current models (`panel_grid_vocab.json` + refreshed `d_est`). Not gated on GCS/Crowdin promote—usefulness is whether AI rankings/priors help human researchers (see `REPORT_vocab_d_est.md`). Watch **gesticulate**-style false BROKENs when interpreting screens.
