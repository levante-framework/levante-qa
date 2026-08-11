# Vocab: can AI difficulty match what kids already showed us?

**Date:** 9 August 2026  
**Audience:** anyone who wants the story without the jargon first  
**Companion data:** [`blank_d_human_vs_d_est_vocab_en.csv`](blank_d_human_vs_d_est_vocab_en.csv)  
**Related ops report:** [`REPORT_vocab_d_est.md`](REPORT_vocab_d_est.md)

---

## Start here (one paragraph)

We asked: for English **vocab** words that have **no difficulty number in the CAT item bank**, does our AI panel estimate agree with a difficulty we can build from **kids who already took those words**?

Short answer: **sometimes, moderately** — and only for words that already have a human statistical fit. For those 19 words, ranking agreement is about **0.53** (Spearman ρ). That is weaker than what we saw for TROG blanks (~0.71). For the other **25** blank words, kids were never fit into an IRT row, so AI is the only prior we have.

---

## Plain-language glossary

| Term | What it means in this report |
|------|------------------------------|
| **Bank `d`** | The official difficulty stored in the vocab item bank that the adaptive test uses. Higher = harder. |
| **Blank** | A scored vocab word whose bank `d` is empty / NA. The CAT has no official difficulty yet. |
| **Anchor** | A word that **already has** a bank `d`. We use these to check whether a method recovers the official scale. |
| **VLM / AI panel** | Vision-language models that “take” the same item screens kids see. |
| **`d_est` (AI estimate)** | Our predicted bank-scale difficulty from the panel, after calibrating AI accuracy toward child accuracy. |
| **Human `item_params`** | A difficulty from a statistical IRT model fit on real child trials (Redivis / levante-bench export). |
| **`d_human_bank`** | That human IRT number, flipped and linearly rescaled so it lives on the **same scale** as bank `d`. |
| **Spearman ρ** | Rank correlation from −1 to +1. “Do harder words look harder under both methods?” 1 = perfect same order; 0 = no order agreement. |
| **MAE** | Mean absolute error — average distance between two numbers on the difficulty scale (same units as `d`). |
| **CEILING / OK / HARD** | Panel screen flags: AI finds the item very easy, middling, or hard (or broken — none among these fills). |

---

## What problem we are solving

The adaptive vocab test needs a `d` for every word so it can pick the next item.

Many words already have a solid bank `d` (**126** anchors). Those we **never overwrite**.

**44** scored words still have a blank bank `d`. We filled those with AI `d_est` in a draft bank file. The question for *this* write-up is not “did we fill them?” (yes) — it is:

> When kids have already been measured on some of those blank words, does the AI fill look like the human-based difficulty?

If yes, we trust the AI prior more. If no, we should prefer human numbers when they exist, and treat AI as a stopgap only when humans never published a param.

---

## Two different numbers we compare

### 1. AI estimate (`d_est`) — “blind” for that word

Rough pipeline:

1. AI models answer the vocab item (images + word).
2. We convert AI success rate into a predicted **child** success rate.
3. We map that onto the bank difficulty scale → `d_est`.

**Blind for that word** means: we did **not** use that word’s own child responses or its own IRT row to build its `d_est`.

**Not magic / not child-free overall:** the mapping still learned from **other** words that do have kids + bank `d`. So this is “new-item blind,” not “we never saw a child in our lives.”

### 2. Human-linked difficulty (`d_human_bank`) — kids only, no AI

For words that appear in `vocab_item_params.csv`:

1. Take the published IRT difficulty (that file is **easiness-coded**: larger often means easier).
2. Flip the sign so **higher = harder**, matching the bank.
3. Fit a simple line on the **125 anchors** that have both bank `d` and human params:

   `d_human_bank ≈ −0.972 + 0.945 × (flipped human difficulty)`

That line is excellent on vocab: leave-one-out ρ ≈ **0.93**, MAE ≈ **0.55**.  
Translation: **vocab bank `d` and human IRT are already almost the same story.** If you have human params, putting them on the bank scale is easy and accurate.

---

## How we checked (two referees)

Think of a sports ranking:

| Group | What we ask | Fair referee |
|-------|-------------|--------------|
| **Anchors** (126 words with bank `d`) | Which method recovers the official bank difficulty better? | Bank `d` itself |
| **Blanks with human params** (19) | Do AI and human-linked estimates agree with each other? | Each other (there is no bank `d` yet) |
| **Blanks without human params** (25) | — | No human referee; AI is the only prior |

---

## Result 1 — Anchors: who recovers the official bank `d`?

| Method | Rank agreement with bank `d` (ρ) | Average error (MAE) |
|--------|----------------------------------:|--------------------:|
| AI hybrid `d_est` | **0.62** | 1.41 |
| Simple “harder if AI predicts kids fail more” (−`p_pred`) | **0.65** | — |
| Human IRT → bank link | **0.93** | 0.55 |

**What this means in English**

- If a word already has kids in the IRT file, **use the human number** (rescaled). It nearly reproduces the bank.
- The AI estimate is **okay at ranking** (~0.62) but clearly **worse** than just using human IRT.
- Even a crude pass-rate-style score from the panel (~0.65) slightly beats the fancier hybrid tags. Vocab difficulty is mostly “how often do people get this right?”

This is different from TROG, where AI hybrid competed with (and on blanks, agreed well with) human-linked difficulties.

---

## Result 2 — Blanks: do AI and human agree when both exist?

Of the **44** blank bank words:

| Slice | Count | Meaning |
|-------|------:|---------|
| Have human IRT params | **19** | We can compare AI vs kids-based `d` |
| No human IRT params | **25** | Kids may have trials, but no published param row — AI-only prior |

On the **19** with both:

| Metric | Value | Plain reading |
|--------|------:|---------------|
| Spearman(`d_est`, `d_human_bank`) | **0.53** | Same ballpark order, not tight |
| MAE | **1.06** | Typical gap ~1 difficulty unit |
| Human vs kids’ pass rate | ρ ≈ 0.80 | Human-linked `d` tracks pass rates well |
| AI vs kids’ pass rate | ρ ≈ 0.36 | AI order tracks pass rates poorly on this small set |

### Biggest mismatches (ranked on the same 19)

`delta = AI d_est − human-linked d`.  
**Positive** → AI thinks the word is **harder** than the kids-based number.  
**Negative** → AI thinks it is **easier**.

| Rank | Word | \|delta\| | AI | Human | Kids pass rate | Flag | Pattern |
|-----:|------|----------:|---:|------:|---------------:|------|---------|
| 1 | **turnstile** | 2.62 | −0.32 | **+2.30** | 0.56 | OK | AI much **easier** than kids/IRT |
| 2 | **footbath** | 2.42 | −0.59 | **−3.01** | 0.98 | CEILING | AI **understates** how easy kids found it |
| 3 | **colony** | 2.07 | −0.71 | **+1.35** | 0.50 | HARD | AI easier; kids ~chance |
| 4 | **confectionery** | 2.04 | −0.36 | **+1.68** | 0.76 | OK | AI easier than human IRT |
| 5 | **typewriter** | 1.95 | −0.30 | **−2.25** | 0.81 | OK | AI harder than kids (kids did well) |
| 6 | waterwheel | 1.29 | +0.02 | −1.28 | 0.82 | OK | AI harder |
| 7 | marshmallow | 1.03 | −1.94 | −2.97 | 0.97 | CEILING | mild; both easy |
| 8–19 | (rest) | &lt;1.0 | — | — | — | mostly CEILING | closer agreement |

**Closest matches:** `buffet` (|Δ|≈0.02), `farm` (0.06), `applaud` (0.22).

**How to read the worst ones**

1. **turnstile / colony / confectionery** — Human IRT says relatively **hard**; AI says middling/easy. Prefer kids/IRT if you need a bank number.
2. **footbath / typewriter / waterwheel** — Kids pass rates are high; AI still places them less easy than human-linked `d` (mapped `d_est` doesn’t go as negative as the human scale).
3. Most other CEILING words (cake, bamboo, farm…) agree the item is **easy**; they only disagree on *how* easy.

Full 19-row table (sortable): [`blank_d_human_vs_d_est_vocab_en.csv`](blank_d_human_vs_d_est_vocab_en.csv).

### The 25 with no human IRT row

Examples: ant, duck, fork, hedgehog, potato, rubberband, watermelon, …  

For these, there is **nothing to compare against** in `item_params`. The draft bank fill is pure AI prior. Most look **easy** on the panel (CEILING). Treat them as “start easy until kids overwrite,” not as precise difficulties.

---

## How this compares to TROG (so the numbers make sense)

| | TROG blanks | Vocab blanks |
|--|-------------|--------------|
| AI vs human-linked agreement | ρ ≈ **0.71** (n=13) | ρ ≈ **0.53** (n=19) |
| Human→bank on anchors | ρ ≈ 0.50 (weaker) | ρ ≈ **0.93** (very strong) |
| Practical takeaway | AI prior often as good as rescaling human IRT | If human IRT exists, **prefer it**; AI is backup |

Vocab’s human stats are already excellent on the bank scale. That raises the bar: AI has less room to look “as good as humans.”

---

## What you should do with this

1. **Words with human `item_params` and blank bank `d`**  
   Prefer filling from the human→bank link (or wait for a proper bank update from psychometrics), not from AI — unless you explicitly want an AI-only experiment.

2. **Words with no human params (25)**  
   AI `d_est` is a reasonable **temporary starting difficulty** so CAT isn’t blank. Review CEILING rows before uploading to production.

3. **Never overwrite** the 126 established bank difficulties.

4. **Later:** when enough kids take a blank word, field IRT should replace the prior.

---

## Files

| File | Contents |
|------|----------|
| `blank_d_human_vs_d_est_vocab_en.csv` | All 44 blanks: AI `d_est`, human-linked `d` (if any), pass rate, flag |
| `blank_d_human_vs_d_est_vocab_en.md` | This explanation |
| `d_est_vocab_en.csv` / `_metrics.json` | Full AI estimates + fit metrics |
| `item_bank_vocab_en_d_est_prior.csv` | Draft bank with blanks filled |
| `REPORT_vocab_d_est.md` | Shorter ops summary of the prior fill |
