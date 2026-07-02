# The Calibrated Child Simulator — design notes & development log

This documents the thought process behind the `sim` agent mode (see the
"Simulated child" section of the main [README](README.md) for usage), as worked
through in the chat session that built it (July 2026).

## Why build this

The repo already had three agents that bracket task behavior:

| agent  | drives clicks from            | asserts        |
|--------|-------------------------------|----------------|
| oracle | the app's own answer key      | 100% accuracy  |
| wrong  | anything *but* the key        | 0% accuracy    |
| vlm    | a vision-language model       | (benchmarking) |

The `child` variant of the VLM agent prompts the model to *act like* a child of
a target age, but nothing guaranteed its error rate actually matched real
children — LLM role-play is not a calibrated behavioral model. What was missing
was a **mid-ability agent whose accuracy provably tracks real age norms**:
useful for sanity-checking task/item design against expectations ("does the
scoring pipeline produce a plausible theta for a typical 6-year-old?"), and as
a reproducible fixture between the oracle ceiling and the wrong floor.

We had all the ingredients already in the repo:

- `cypress/support/persona/age_task_ability.json` — mean child IRT ability θ
  per age per task, from real LEVANTE trial data.
- `cypress/support/persona/age_task_accuracy.json` — *empirical* mean accuracy
  per age per task, same source.
- The deployed item banks on GCS carry a per-item IRT difficulty `d`.
- The wrong-agent plumbing: a one-line entry spec sets `QA_AGENT_MODE`, and the
  shared `oracle.cy.ts` branches on it — so a new mode needs no new task logic.

## Design decisions (and why)

### 1. IRT response model with a guessing floor

Per scored item the sim answers correctly with probability

```
P(correct) = c + (1 − c) · sigmoid(θ + b − d)
```

- `θ` — age ability from `age_task_ability.json` (nearest age row).
- `d` — item difficulty, joined from the item bank. The join key is the app's
  keyed answer value: we verified all 99 TROG log `keyedValue`s match the
  bank's `answer` column exactly, and vocab likewise (`acorn`, `aloe`, …).
- `c = 1/choices` — a 4-AFC child who doesn't know the answer still gets ~25%.
- `b` — a calibration offset, see next point.

Items with no `d` in the bank (practice items, uncalibrated nouns; blank `d`
must not coerce to 0 via `Number('')` — that was an early bug) fall back to the
empirical age accuracy directly.

### 2. The calibration offset `b`

Before implementing anything we checked whether the raw model was already
right: plugging the shipped thetas and bank `d`s into plain Rasch + guessing
**underpredicts** the empirical accuracy table by 5–12 points (e.g. TROG age 6:
0.65 predicted vs 0.77 observed). Likely causes: the table includes items the
θ/d scaling doesn't cover, and the original scoring model wasn't exactly
1PL+guess. Rather than pick one source of truth, we blend them: at run start,
bisection solves for the `b` that makes the mean predicted accuracy over the
bank's calibrated items equal the empirical table value. This keeps
**item-difficulty ordering** from IRT (hard items missed more) while matching
**absolute accuracy** to observed age norms. Verified: calibration lands within
0.02 of target for TROG and Vocab at ages 6/8/10/12.

### 3. Determinism via hashing, not an RNG stream

Each decision hashes `(seed, task, itemKey)` → uniform [0,1) (FNV-1a with an
avalanche step). No sequential RNG state means the outcome for an item does not
depend on presentation order, retries, or how many items ran before it — a
gated practice item that re-presents replays the identical decision (decisions
are also memoized per itemKey so the predicted-accuracy tally never
double-counts).

### 4. The bug the live run caught: position vs value

The first implementation hashed the *wrong-choice pick* over choice
**positions**. Offline tests were perfectly deterministic — but two live TROG
runs disagreed on which picture was clicked, because **the app shuffles choice
positions between runs**. The correctness pattern was identical (the roll and P
don't depend on position), only the clicked wrong picture moved. Fix: hash over
the **sorted choice values** and map back to the current position. After that,
two back-to-back live runs produced identical (chosen picture, correct) on all
99 items. Lesson: offline determinism tests can't see nondeterminism the app
itself introduces.

### 5. Assertion: a band, not a point

Oracle asserts exactly 1.0 and wrong exactly 0.0; a stochastic-by-design agent
can't assert a point value. Finalize asserts realized accuracy within a
3-sigma binomial band around the model's predicted mean over the items actually
seen (with a 0.08 floor). For ~100 items at p≈0.8 that's roughly ±0.10–0.14 —
tight enough to catch a broken pipeline, loose enough to never flake on an
unlucky seed.

### 6. Extending to more tasks (second session)

Asked "can we extend this to other tasks?", we audited every task against the
three requirements — an AFC keyed-answer decision point, an ability/accuracy
table, and a bank↔runtime key join — and wired the two that verified cleanly:

- **Matrix Reasoning** — 22/22 keyedValues join the bank; the IRT column is
  named `difficulty` there (not `d`), so the loader now accepts either.
- **Stories (ToM)** — 31/31 join, but answer values repeat across questions
  ("no" ×9, "happy", …), which would collide the hash memo. Fix: the sim hash
  key is a composite (prompt + sorted choices + answer) with a separate `dKey`
  for the difficulty lookup. The ToM bank's `difficulty` column is entirely
  empty, so every item uses the empirical-accuracy fallback — calibrated in
  the mean, not item-differentiated, until the bank ships difficulties.

Two live failures taught us about **gated screens**:

1. TROG/Matrix practice items re-present until the *correct* answer. An agent
   that deterministically replays its wrong pick loops forever (the first
   Matrix run climbed to a Cypress stack overflow after 24 minutes). Fix: on a
   gated re-presentation the sim escalates to the keyed answer — its recorded
   first answer stands, and a real child is corrected during practice anyway.
2. Matrix's **intro demo screens** (orange-square/blue-circle example) render
   like items but ship **no answer key by design**, and also gate until
   correct. With no key to escalate to, the runner now rotates through the
   choices until the gate opens, and retroactively excludes screens identified
   as gated-no-key from the "items with no answer key" content assertion
   (ungated no-key items remain a real bug signal).

Audited but not wired:

- **Mental Rotation** — join FAILS: runtime alts are `rn000Silh`-style while
  bank answers are `ap2-000` / `P2p-000-silh`-style. Needs a key mapping.
- **Same-Different single-select** — joins cleanly (29/29, with difficulty);
  straightforward next candidate, only the single trials would be simulated
  (match trials expose no key).
- **EGMA / H&F / Memory** — non-AFC response models (typed numbers,
  LEFT/RIGHT actions, sequences); each needs its own error model, and their
  banks 404 on GCS anyway.

### 7. What we deliberately did not build (YAGNI)

- **Dashboard wiring** — needs catalog + UI changes; CLI env vars suffice for
  now.
- **A response-time model** — decisions are instant; RT realism is a separate
  roadmap item.
- **Per-item discrimination (2PL a-parameter)** — the banks only ship
  difficulty.

## Verification results

Offline (`tsx` harness over the full banks):

| task  | age | θ     | offset b | target (empirical) | predicted | deterministic |
|-------|-----|-------|----------|--------------------|-----------|---------------|
| trog  | 6   | −2.01 | 0.87     | 0.770              | 0.770     | yes           |
| trog  | 8   | −0.91 | 0.64     | 0.862              | 0.862     | yes           |
| trog  | 12  | −0.22 | 0.55     | 0.905              | 0.905     | yes           |
| vocab | 6   | −1.76 | 1.27     | 0.711              | 0.711     | yes           |
| vocab | 10  | +0.49 | 0.05     | 0.807              | 0.807     | yes           |

Live end-to-end (real task in Cypress, real narration/audio pipeline):

- **TROG, age 6, seed 1** — 99 items, realized 0.737 vs predicted 0.770
  (inside band). Misses concentrate on hard items (hardest miss:
  `84-keys-under-couch-pillows`, d = 7.66) with a plausible tail of lapses on
  easy ones (3 items with d < −2).
- **Vocab, age 8, seed 1** — 170 items, realized 0.776 vs predicted 0.773;
  44 items used the no-`d` fallback.
- **Matrix Reasoning, age 7, seed 1** — 80 items, realized 0.350 vs predicted
  0.383 (matrix reasoning genuinely is that hard for 7-year-olds — the
  empirical table says 38%); 75/80 items item-differentiated from bank
  difficulty.
- **Stories (ToM), age 7, seed 1** — 30 questions, realized 0.600 vs predicted
  0.626 (all fallback; the ToM bank ships no difficulties).
- **Reproducibility** — two consecutive live TROG runs: identical
  (chosen picture, correct) on all 99 items despite the app shuffling choice
  positions.

## Where things live

| file | role |
|------|------|
| `cypress/plugins/simChildConfig.ts` | node-side: fetch/cache item bank, θ lookup, offset calibration (`getSimConfig` task) |
| `cypress/support/agentMode.ts` | browser-side: mode detection, `simDecideIndex`, predicted-accuracy band, decisions log |
| `cypress/support/simChildEntry.ts` | sets `QA_AGENT_MODE=sim` before `oracle.cy` loads |
| `cypress/e2e/{trog,vocab,matrix_reasoning,stories}/sim_child.cy.ts` | two-line entry specs |
| `cypress/e2e/{trog,vocab,matrix_reasoning,stories}/oracle.cy.ts` | sim branch in the act-index decision + band assertion at finalize |
| `cypress/logs/sim_<task>_<ts>_decisions.jsonl` | per-item `d`, P(correct), roll, chosen index — plus the run's config header |

Env: `QA_SIM_AGE_YEARS` (required), `QA_SIM_AGE_MONTHS`, `QA_SIM_SEED`
(default `1`), `QA_SIM_REFRESH=1`, `QA_SIM_BANK_BUCKET`. Scripts:
`pnpm cy:run:trog:sim`, `pnpm cy:run:vocab:sim`, `pnpm cy:run:sim`.

## Context: the wider session

This simulator was step 1 of a roadmap sketched while reviewing the repo for
"QA agents that emulate children": (1) calibrated simulator → (2) age-norm
assertions on task output scores → (3) strategy agents (position bias,
perseveration, fast-guessing) → (4) an RT model → (5) closing the loop between
the translation-eval flags (`scripts/eval/`) and agent runs → (6) coverage for
the remaining tasks. The per-item decisions log was designed with step 2 in
mind: it contains exactly the (item, difficulty, expected/actual correctness)
triples an age-norm assertion layer would consume.

The same session earlier produced the task-specific translation checks in
`scripts/eval/` (vocab/TROG/ToM/same-different vision checks, survey Likert
scales, hostile-attribution constructs) and the comparison of those vision
flags against the dashboard's back-translation flags — see
`scripts/eval/README.md`.
