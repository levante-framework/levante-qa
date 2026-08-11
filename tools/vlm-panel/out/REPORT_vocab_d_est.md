# Vocab EN: filling blank difficulties with AI (v3 panel)

**Date:** 10 August 2026  
**Read this first for the blank-vs-kids story:** [`blank_d_human_vs_d_est_vocab_en.md`](blank_d_human_vs_d_est_vocab_en.md)  
**Panel path:** [`REPORT_vocab_prompt_v3_ability_smoke.md`](REPORT_vocab_prompt_v3_ability_smoke.md)

---

## What we wanted

1. Keep every vocab word that already has an official bank difficulty (`d`) unchanged.
2. For words with a **blank** bank `d`, write a temporary AI estimate (`d_est`) so the adaptive test has something to start from.
3. Do this on **current** Gemini models (3.5-lite / 3.6-flash), without EOL 2.5.

---

## What we adopted (ops)

1. **Prompt/agent v3:** `DIGIT YES|NO`; if NO → agent randomizes choice (`vocabPrompts.ts` / `vocabVlmAgent.ts`).
2. **Default grid** [`panel_grid_vocab.json`](../panel_grid_vocab.json): temps `[0.5, 1.2]`, ages `[6,8,11]`, repeats `2`, current models only; **must `--live`**.
3. Promoted v3 smoke screen → `screen_vocab_en.csv` (12 respondents).
4. `estimate_difficulty` + gated `apply_d_est_prior` (skip BROKEN / `known_issues`; **claw** listed).

**Draft bank:** `item_bank_vocab_en_d_est_prior.csv`  
**Apply counts:** preserved **126**, filled **44**, skipped_blocked **0** (claw already has established bank `d`).

---

## How good is the AI estimate (v3 screen)

On the **126** anchors with bank `d`:

| Check | Number | Meaning |
|-------|-------:|---------|
| AI hybrid vs bank `d` (Spearman ρ) | **0.653** | Up from ~0.62 on pre-v3 panel |
| −`p_pred` ranking ceiling | **0.746** | Up from ~0.65 |
| MAE multivar | **1.30** | Slightly better than ~1.41 |

Screen (v3): BROKEN 2 (claw known + gesticulate) / HARD 29 / CEILING 107 / OK 32; ρ(p_vlm, human) ≈ **0.64**.

---

## Research framing (not production promote)

Goal is to study whether **AI-generated difficulties / rankings** help **human researchers** (triage, drafting priors, spotting odd items)—not to ship bank CSVs to GCS/Crowdin.

1. Bank `d` present → treat as ground truth for recovery checks; do not overwrite in drafts.  
2. Blank bank rows → hybrid `d_est` is a **research prior / hypothesis**, especially when human IRT is missing.  
3. When human `item_params` exist, prefer them over AI for that item (see blank-vs-human write-up).  
4. Future panel runs: `panel_grid_vocab.json` + `--live` (v3 agent on current models).
