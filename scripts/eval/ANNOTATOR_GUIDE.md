# Translation review — annotator guide (v2 two-axis)

You are rating Levante translations used in a **research study with children**. For
each row you see the English **source** and the **translation** in your language.
Rate **two separate things** and, when something is wrong, tag the error.

> Rate what is on the screen. Do **not** look up other tools, scores, or the
> "right" answer. There is no automatic score in your file — that is intentional.

## The two axes (both required)

### 1. `adequacy` — does it mean the same thing? (0–3)
Ignore style; ask only whether the meaning is preserved.

| Score | Meaning |
|---|---|
| 3 | Faithful — same meaning, nothing added or lost |
| 2 | Minor loss — slight nuance off, but a child would understand it the same |
| 1 | Major loss — important meaning changed, added, or dropped |
| 0 | Wrong — different meaning, untranslated, or nonsense |

### 2. `appropriateness` — is it right *for children* in your locale? (0–3)
Assume `adequacy` is fine and judge register, vocabulary, terminology, and tone.

| Score | Meaning |
|---|---|
| 3 | Natural — what a teacher/parent would naturally say to a child this age |
| 2 | Acceptable — understandable, slightly stiff/formal/odd word choice |
| 1 | Awkward — too advanced, wrong register, or wrong regional term; a child may struggle |
| 0 | Unusable — confusing or inappropriate for the age group |

These are **independent**: a translation can be perfectly accurate (`adequacy` 3)
but too advanced for a 5-year-old (`appropriateness` 1), or natural-sounding
(`appropriateness` 3) but subtly wrong in meaning (`adequacy` 1).

## `mqm_errors` — tag what's wrong (only when adequacy<3 or appropriateness<3)
A JSON list; leave `[]` (or blank) if both axes are 3. Each error:

```json
[{"category": "accuracy", "severity": "major"},
 {"category": "terminology", "severity": "minor"}]
```

- **category**: `accuracy` (meaning), `fluency` (grammar/spelling), `terminology`
  (wrong domain/regional word), `style` (register/tone), `locale` (date/number/format).
- **severity**: `minor` (noticeable, not blocking), `major` (changes meaning or
  blocks a child), `critical` (offensive, harmful, or completely wrong).

## `overall_verdict`, `rater_id`, `notes`
- `overall_verdict`: `Poor` if **either** axis is ≤1, otherwise `OK`.
- `rater_id`: your assigned ID.
- `notes`: optional — a few words on the problem (helps adjudication).

## How to fill the file
Edit only the empty columns (`adequacy`, `appropriateness`, `mqm_errors`,
`overall_verdict`, `rater_id`, `notes`) in your `blind/<locale>.csv`. Do not change
`source_en`, `translation`, `item_id`, or reorder rows.

## Calibration & quality control
1. **Calibration first:** everyone rates the same 20 practice rows; we compare and
   discuss disagreements before the real run.
2. **Double-rating:** ~15–20% of rows are rated by two people; we measure agreement
   and adjudicate conflicts. Aim for substantial agreement on each axis.
3. **When unsure:** pick the lower score and explain in `notes`. Use `appropriateness`
   = blank only if you cannot judge (e.g. you don't know the target dialect).

## Quick examples (es-AR)
| Source | Translation | adequacy | appropriateness | why |
|---|---|---|---|---|
| "Point to the dog." | "Señalá al perro." | 3 | 3 | accurate + natural voseo |
| "Point to the dog." | "Indique el can." | 3 | 1 | accurate but formal/literary, not child speech |
| "the big red ball" | "la pelota roja" | 1 | 3 | natural, but "big" dropped (meaning loss) |
| "Press start." | "Presione comenzar." | 0 | 1 | wrong button term + formal register |
