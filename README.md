# levante-qa

QA / regression and VLM-agent benchmarking for [LEVANTE](https://github.com/levante-framework) core tasks, built on [Cypress](https://www.cypress.io/) + TypeScript.

This repo serves two purposes:

1. **QA / regression** — a deterministic, DOM-driven **oracle** agent plays a task end-to-end and asserts it can be completed at 100% accuracy with no timeouts. This catches regressions in the task itself (selectors, stimulus rendering, scoring, block sequencing). Where the task exposes its own answer key, the oracle is a true [differential test](#how-correctness-is-validated): it cross-checks its independently-computed answer against the app's key on every item.
2. **VLM-agent benchmarking** — the *same* task is driven by a vision-language model in the loop (screenshot → model → click), letting us benchmark how well different models perform the cognitive task.

Nine tasks are implemented today — **Hearts & Flowers**, **EGMA math**, **Vocab**, **Stories (Theory of Mind)**, **Same-Different Selection**, **Mental Rotation**, **Matrix Reasoning**, **TROG**, and **Memory Game** — and others follow the same structure (see [Adding a new task](#adding-a-new-task)).

## Quickstart

```bash
pnpm i

# Interactive runner
pnpm cy:open

# Deterministic oracle regression (no API keys needed)
pnpm cy:run:oracle

# VLM agent (requires an API key for the chosen provider)
cp .env.example .env   # fill in OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY
pnpm cy:run:vlm -- --env provider=openai

# Score logs into results/summary.csv, then aggregate across runs
pnpm score          # Hearts & Flowers
pnpm score:egma     # EGMA math
pnpm summarize
```

Per-task runners are also available, e.g. `pnpm cy:run:egma:oracle`,
`pnpm cy:run:egma:vlm -- --env provider=gemini`, `pnpm cy:run:vocab:oracle`,
`pnpm cy:run:vocab:vlm -- --env provider=gemini`, `pnpm cy:run:stories:oracle`,
`pnpm cy:run:stories:vlm -- --env provider=gemini`, `pnpm cy:run:sds:oracle`,
`pnpm cy:run:sds:vlm -- --env provider=gemini`, `pnpm cy:run:mr:oracle`,
`pnpm cy:run:mr:vlm -- --env provider=gemini`, `pnpm cy:run:matrix:oracle`,
`pnpm cy:run:matrix:vlm -- --env provider=gemini`, `pnpm cy:run:trog:oracle`,
`pnpm cy:run:trog:vlm -- --env provider=gemini`, and `pnpm cy:run:memory:oracle`
(Memory Game is oracle-only) (score with `pnpm score:vocab` / `pnpm score:stories`
/ `pnpm score:sds` / `pnpm score:mr` / `pnpm score:matrix` / `pnpm score:trog` /
`pnpm score:memory`).

The VLM provider is selected by the `VLM_PROVIDER` env var (`openai` | `anthropic` | `gemini`); `--env provider=<p>` labels the run and is surfaced to the spec. Set the matching `*_API_KEY` in `.env`.

## Target URL

The current target is the hosted demo:

```
https://levante-tasks-demo.web.app/?task=hearts-and-flowers&maxTime=8&maxIncorrect=6
```

To point the specs at a local `core-tasks` dev server instead, set `BASE_URL` (it overrides the host portion of the task URL):

```bash
BASE_URL=http://localhost:8080 pnpm cy:run:oracle
```

`URL_BASE` and `DEFAULT_PARAMS` live in `cypress/support/tasks/heartsAndFlowers.ts`.

## Launching from the dashboard (`-dev`)

By default specs hit the standalone demo. Set `LAUNCH=dashboard` to instead log
in to the `-dev` dashboard as a real participant and start the task from the
assignment home — exercising the same launch path real users take (Firebase
auth, assignment sync, the core-tasks launcher). The switch is centralized in
`cypress/support/launch.ts` (`launchTask`), so every spec uses it transparently.

```bash
LAUNCH=dashboard PARTICIPANT_USER=qa-participant@levante.test PARTICIPANT_PASS=... \
  pnpm cy:run:egma:oracle
```

Relevant `.env` keys (passed through by `cypress.config.ts`):

```
LAUNCH=dashboard                                  # opt in; anything else uses the demo
DASHBOARD_URL=https://hs-levante-admin-dev.web.app
PARTICIPANT_USER=qa-participant@levante.test
PARTICIPANT_PASS=...
```

### Provisioning the QA participant + assignment

The dashboard only shows tasks a participant is actually assigned. A bootstrap
script provisions a dedicated, self-contained test setup on `hs-levante-admin-dev`
(idempotent — safe to re-run): it creates the **`qa-tests`** site, a participant
with a known username/password, and a **"QA All Tasks"** assignment containing
all core tasks (English variants, opens today, closes in 90 days), then
materializes the participant's `assignments` doc the home reads.

It lives alongside the sibling site-bootstrap scripts in `levante-support`
(which already has `firebase-admin` and the `-dev` service-account credential):

```bash
cd ../levante-support
node scripts/e2e-init/setup-qa-site.mjs        # uses VITE_FIREBASE_PROJECT=DEV + .env credential
# prints PARTICIPANT_USER / PARTICIPANT_PASS to copy into levante-qa/.env
```

`cypress/e2e/dashboard_launch.cy.ts` is a smoke test for this path (self-skips
unless `LAUNCH=dashboard` and `PARTICIPANT_USER` are set).

## Local QA dashboard (web UI)

A local, Pitwall-styled web UI launches oracle/VLM runs **in parallel** for a
participant **created at a chosen age** (years + months), flags serious errors
live, and accumulates run history on a second tab.

```bash
pnpm dashboard          # → http://localhost:4180
```

How it works (per launch):

1. **Provision** — the backend runs
   `levante-support/scripts/e2e-init/provision-participant.mjs`, which creates a
   unique, test-flagged participant on `hs-levante-admin-dev` whose
   `birthMonth`/`birthYear` are derived from the requested age, and assigns just
   the selected task. (Age drives age-appropriate item selection via
   `core-tasks` `getAge → userMetadata.age`.) It prints a
   `PROVISION_RESULT={...}` line with launchable credentials.
2. **Run** — the backend spawns `cypress run` in `LAUNCH=dashboard` mode as that
   participant, with logs scoped to `cypress/logs/runs/<runId>/` and screenshots
   to `cypress/screenshots/runs/<runId>/` so parallel runs never collide (the
   scoping is handled in `cypress.config.ts` via the `QA_RUN_ID` env var).
3. **Monitor** — the UI polls per-run status; a run is flagged **failed** on a
   non-zero Cypress exit code or any non-empty diagnostic log
   (`*_no_key` / `*_key_mismatch` / `*_unsolved`).
4. **Accumulate** — on completion the backend appends a record (task, agent,
   provider, age, status, accuracy, trials, errors, timings) to
   `results/runs.json`, shown on the **Results** tab.

Run cards on the **Launch** tab show the launch time and an **X** to remove a
card; removing a still-running card cancels it (the backend kills the whole
process tree). Live cards are session-scoped, so they clear on restart — the
durable history lives on the **Results** tab (see below).

### Durable run storage (GCS)

So history survives restarts and is shared across machines, the dashboard
mirrors the run index and each run's small JSONL artifacts to a Cloud Storage
bucket — by default **`gs://levante-tools/levante-qa/`** (the same "tools"
bucket that hosts `pitwall/` and `test-results/`):

- `levante-qa/runs.json` — the canonical run index.
- `levante-qa/runs/<runId>/*.jsonl` — per-run trial archive + diagnostic +
  persona logs (screenshots are **not** uploaded).

On startup the server folds the remote index into the local one, and
`/api/runs` returns the union of local + remote, so the Results tab shows runs
recorded on any machine. Auth uses **Application Default Credentials**
(`gcloud auth application-default login`) unless `GCP_SERVICE_ACCOUNT_JSON` /
`GOOGLE_APPLICATION_CREDENTIALS` is set. Everything degrades gracefully: if the
bucket is unreachable or `QA_GCS_DISABLE=1`, the dashboard keeps working with
local-only history. Override via `QA_GCS_BUCKET`, `QA_GCS_PREFIX`,
`QA_GCS_PROJECT`.

Requirements: the provisioner needs the `-dev` service-account credential —
runs against the same `levante-support` `.env`
(`LEVANTE_ADMIN_FIREBASE_CREDENTIALS`) used by `setup-qa-site.mjs`. Point the
backend at a non-default support checkout with `LEVANTE_SUPPORT_DIR`, change the
port with `QA_DASHBOARD_PORT`. Dev-only by design (the provisioner refuses to
run outside `hs-levante-admin-dev`).

The provisioner is a self-contained Admin-SDK script, kept swappable for the
admin-callable path (`createUsers` + `upsertAdministration`) without touching
the dashboard.

## Child-age VLM persona (optional)

VLM runs can optionally ask the model to answer **as a typical child of a target
age would** — calibrated to real LEVANTE accuracy-by-age data — so the benchmark
measures developmental plausibility rather than raw model capability. Off by
default; the oracle is never affected.

```bash
QA_PERSONA=child QA_PERSONA_AGE_YEARS=6 QA_PERSONA_AGE_MONTHS=0 \
  pnpm cy:run:trog:vlm -- --env provider=gemini

# Optional: also inject mean child IRT θ for that age/task (6 tasks with IRT models)
QA_PERSONA=child QA_PERSONA_ABILITY=irt QA_PERSONA_AGE_YEARS=8 QA_PERSONA_AGE_MONTHS=0 \
  pnpm cy:run:trog:vlm -- --env provider=gemini
```

When enabled, the `askVLM` node task (`cypress.config.ts`) prepends a persona
preamble to the task's existing system prompt — so every provider and task gets
it with no per-agent code. The preamble is built by
`cypress/support/persona/childPersona.ts` from two **shared artifacts**:

- `cypress/support/persona/age_task_accuracy.json` — per-task mean accuracy by
  age (always included in the child persona).
- `cypress/support/persona/age_task_ability.json` — per-task mean IRT ability θ
  by age (optional; see below).
- `cypress/support/persona/persona_template.txt` — the prompt wording.

These are the **single source of truth shared with `levante-bench`** (canonical
copies in `levante-bench/shared/persona/`, generated from
`data/responses/v1/trials.csv` by `scripts/build_age_accuracy_profile.py`). Pull
the latest into this repo with:

```bash
pnpm persona:sync          # copies from ../levante-bench (override LEVANTE_BENCH_DIR)
```

The applied persona (age + preamble) is logged once per run to
`cypress/logs/_<task>_persona.jsonl`. In the dashboard, **Child** runs always use
the accuracy-based persona; check **Include mean child ability (θ) from IRT** to
also append the IRT θ hint (`QA_PERSONA_ABILITY=irt`). Scoring and pass/fail
logic are unchanged — only the VLM system prompt differs.

## Wrong agent (floor check)

A fourth deterministic agent, **Wrong**, runs the same end-to-end flow as the oracle but
deliberately selects the incorrect answer on every scored item (invert LEFT/RIGHT, pick the
next AFC index, wrong PA image, perturbed Corsi sequence, etc.). Each task has
`cypress/e2e/<task>/wrong_agent.cy.ts` (a one-line import of `oracle.cy.ts`); mode is
detected via `QA_AGENT_MODE=wrong` (set by `wrongAgentEntry.ts` before the shared
`oracle.cy` loads — `Cypress.spec.relative` alone is unreliable when oracle is imported).
Logs use the `wrong_<task>_*.jsonl` prefix; finalize
asserts **0%** accuracy while still requiring task completion. Dashboard: **Wrong** on the
Launch tab. CLI: `pnpm cy:run:wrong`.

## Architecture

Oracle and VLM agent paths share the same task model (selectors, stimulus parser, response rule, scoring) and the same trial-logging pipeline:

```
                         ┌─────────────────────────────────────────────┐
                         │  cypress/support/tasks/heartsAndFlowers.ts    │
                         │  selectors · readStimulus · correctAction ·   │
                         │  congruency · scoreTrials                     │
                         └───────────────▲─────────────────▲────────────┘
                                         │                 │
              ┌──────────────────────────┘                 └───────────────────────────┐
              │ ORACLE PATH (QA)                                VLM PATH (benchmark)     │
              │                                                                          │
  oracle.cy.ts                                              vlm_agent.cy.ts
      │                                                          │
      │ cy.window()                                              │ cy.screenshot()
      ▼                                                          ▼
  oracleAgent.decide(win)                                   cy.readFile(png, 'base64')
   (readStimulus + correctAction;                                │
    'CONTINUE' on instructions)                                  ▼
      │                                                     vlmAgent.decide(b64)
      │                                                          │  cy.task('askVLM', { pngBase64, systemPrompt })
      │                                                          ▼
      │                                              ┌──────────────────────────────┐
      │                                              │ cypress.config.ts setupNode-  │
      │                                              │ Events → askVLM task          │
      │                                              │ dispatch by VLM_PROVIDER,     │
      │                                              │ measure latencyMs             │
      │                                              └───────────────▲──────────────┘
      │                                                              │
      │                                              plugins/vlmClients/{openai,anthropic,gemini}.ts
      │                                                              │
      ▼                                                              ▼  (cross-check vs oracle, log only)
  click LEFT/RIGHT/CONTINUE                                  click LEFT/RIGHT/CONTINUE
      │                                                              │
      └───────────────────────► cy.task('writeJsonl') ◄─────────────┘
                                       │
                                cypress/logs/*.jsonl
                                       │
                          scripts/score.ts → results/summary.csv
                          scripts/summarize_runs.ts → results/aggregate.csv
```

- The **oracle** never calls a model; it reads stimulus state (preferring `window.jsPsych`, falling back to DOM heuristics) and applies the task rule. It asserts perfect play.
- The **VLM agent** only sees a screenshot. The oracle's decision is computed alongside for logging/cross-check but **does not gate** the VLM test.

## How correctness is validated

A "100% accuracy" assertion is only meaningful if "correct" is grounded in
something other than the agent's own logic. We use the strongest ground truth
each task exposes.

**The app's own answer key (preferred).** When core-tasks runs under Cypress it
marks the correct response in the DOM — `aria-label="correct"` / a `.correct`
class on the right button (see core-tasks `afcStimulus.ts`). This is the task's
own answer key, and we read it via `appKeyedCorrectIndex()` in
`cypress/support/tasks/egmaMath.ts`.

- **EGMA oracle** is therefore a genuine **differential test**: it computes its
  answer independently (MathML fraction parsing, arithmetic, sequence inference,
  …) *and* reads the app's keyed index, then asserts the two agree on every
  multiple-choice item. Disagreements are written to
  `cypress/logs/_egma_key_mismatch.jsonl` (with the item's DOM) and **fail the
  run**. "100% accuracy" now means "our answer matched the task's key on every
  item", not merely "we produced an answer". The oracle still *acts* on its own
  computed choice, never the key, so the independence is real.
  > This already caught a content bug: the item `37 − 24` keys `12` as correct
  > (the answer is `13`). The mismatch log flags it automatically.
- **EGMA VLM** is scored against the same app key (not against our solver), so
  the benchmark doesn't silently inherit a solver bug. Each record carries the
  model's choice, the app's `keyedIndex`/`keyedValue`, and `correct`.
- **Vocab oracle/VLM** use the identical mechanism. The vocab marker is a
  `.correct` class on the correct choice's `<img>` (non-math path), so
  `appKeyedCorrectIndex()` in `vocab.ts` reads it the same way. The vocab oracle
  computes its answer *independently* by matching the spoken word (narration
  transcript) to the image whose `alt` names it, then asserts that matches the
  key on every item; the vocab VLM picks an image by position and is scored
  against the key.
- **Stories (Theory of Mind)** scores the VLM against the same `.correct` key
  (on the choice `<img>`), but its **oracle is NOT a differential test** — and
  deliberately so. The answer to a false-belief / emotion-reasoning question
  *cannot* be recomputed from a rule; it requires following the story, so there
  is nothing to cross-check the key against. The Stories oracle therefore just
  clicks the keyed answer (exactly what core-tasks' own e2e test does) and
  instead asserts the things that *are* checkable: the task completes, audio
  narration is captured, and **every scored item ships an answer key** (a
  missing `.correct` marker is a real content/regression bug, logged to
  `cypress/logs/_stories_no_key.jsonl` and failing the run). The interesting
  artifact for Stories is the VLM benchmark, not the oracle.
- **Same-Different Selection** is *two* tasks in one. Its **single-select** items
  ("Choose the card with a circle", "Which of these is the same?") mark `.correct`
  on the chosen BUTTON (not the `<img>`, and via a custom trial — SDS does not use
  `afcStimulus`); the oracle clicks the key and asserts every single item is keyed,
  and the VLM is scored against it. Its **multi-select match rounds** ("touch two
  cards that are the same") expose **no key at all** — many pairs are valid and the
  app scores a pair *relationally* (it must share a dimension not already used in
  this card set). There is nothing to recompute against, so we port core-tasks'
  own proven e2e solver (a dimension-overlap heuristic with per-card-set state) to
  drive the rounds, and treat **reaching the completion screen** as the regression
  signal (the app accepted every pair at runtime). The VLM is benchmarked on the
  single-select items only; match rounds are auto-driven.
- **Mental Rotation** *is* a differential test, but the independent answer comes
  from **pixels, not a rule**. The DOM `alt`s are opaque asset keys (`rp000Silh`),
  so instead the oracle runs a **code-based geometric solver** on the actual
  silhouette images (`cypress/plugins/mentalRotationSolver.ts`): of the two
  choices, one is the target shape *rotated* and the other is its *mirror*, so for
  each choice it measures the best image overlap (IoU) of the target under **pure
  rotation** vs. under **reflection + rotation**, and picks the choice best
  explained by rotation alone (`score = max_θ IoU(R_θ(target), choice) − max_θ
  IoU(R_θ(mirror(target)), choice)`). Masks are normalized to be translation- and
  scale-invariant (centroid-centered, radius-of-gyration scaled) with auto-detected
  foreground polarity — the targets are black-on-white but the silhouette choices
  are *inverted* (white-on-black). The oracle **clicks its own pixel answer** and
  cross-checks it against the app's `.correct` key, asserting completion, every
  item keyed, narration captured, and a high **solver/key agreement rate** (it is
  **118/118 = 100%** on the current corpus; disagreements would be logged to
  `cypress/logs/_mr_key_mismatch.jsonl`). The VLM is scored against the same key.
- **Matrix Reasoning** scores the VLM against the `.correct` key (on the choice
  `<img>`, via the shared `afcStimulus`), and like Stories its **oracle is
  key-driven, not differential**: completing the visual analogy requires pattern
  inference, and the matrix/choice `alt`s are opaque asset keys (`tf1_4_M_ss3`,
  `tf1_4_T1_ss3_md`) with no semantic content — there is nothing to recompute
  against (and unlike Mental Rotation, no pixel rule helps). The oracle clicks the
  keyed answer and asserts the task completes, narration is captured, and **every
  scored item ships an answer key** (missing keys → `cypress/logs/_matrix_no_key.jsonl`,
  failing the run). The interesting artifact is the VLM benchmark.
- **TROG** scores the VLM against the `.correct` key (on the choice `<img>`, via
  the shared `afcStimulus`), and its **oracle is key-driven** (like Stories /
  Matrix). The stimulus is a *spoken sentence* and the four choices are pictures;
  the choice `alt`s are opaque image asset keys (`13-boy-running`) and mapping a
  *sentence* to a *picture* needs both language and vision, so there is nothing to
  recompute (unlike Vocab, whose `alt`s are the target word). The oracle clicks the
  keyed answer and asserts the task completes, **every scored item ships an answer
  key** (missing keys → `cypress/logs/_trog_no_key.jsonl`, failing the run), and
  the sentence narration is captured. The VLM is the real benchmark — it receives
  the sentence as a transcript plus the picture choices.

**Source-equivalence (when there is no DOM key).** Hearts & Flowers emits **no**
`aria-label="correct"` marker, and `window.jsPsych` is unreadable on the v7
build, so there is nothing to read at runtime. Instead, H&F correctness rests on
our `correctAction()` faithfully reimplementing the task's own rule,
core-tasks `getCorrectInputSide()` (heart → same side, flower → opposite). That
equivalence is pinned by a pure-logic spec,
`cypress/e2e/hearts_and_flowers/rule_equivalence.cy.ts`, which asserts the two
agree for every shape × side × block combination and fails instantly if
core-tasks ever changes the rule (no browser/network needed). The H&F VLM is
then scored against the oracle's decision, inheriting that guarantee.

## Audio channel (narration transcripts)

LEVANTE narration is pre-recorded and the canonical script is embedded in each `.mp3`'s **ID3 tags**, so we read it directly instead of running speech-to-text. This gives a deterministic, offline, zero-cost "audio channel" that is by construction what a child hears.

- **Where the text lives:** the spoken script is in an ID3v2 **`TXXX` (user-defined text) frame**, not `USLT`/`TIT2` (`TIT2` is just the asset id; `COMM` is voice metadata). Precedence, highest first: `original_translation_text` (clean source) → `text` → `audio_enhanced_text`. Emotion/TTS markup like `[happy]` is stripped. See `cypress/support/tasks/types.ts` (`AudioSource`).
- **Which clip is playing:** the task preloads all audio and plays it via the Web Audio API, so a network intercept can't tell what's playing *now*. `cypress/support/audio/audioCapture.ts` installs a small `onBeforeLoad` monkeypatch that links each fetched mp3 → decoded buffer → `AudioBufferSourceNode.start()`, exposing `window.__currentAudioUrl` and an ordered `__audioPlayLog`.
- **Reading the tags:** `cypress/plugins/id3Reader.ts` fetches + parses tags node-side (via `node-id3`, cached by URL) and is exposed as the `readMp3Tags` cy.task. `cypress/support/audio/audioOracle.ts` attributes the current screen's narration to each trial.
- **Locale** is encoded in the URL path (`audio/<locale>/<file>.mp3`); we read the exact URL the page requested, so no locale parameter is needed.
- Each `TrialRecord` gains `audioTranscript` and `audioSource`. The VLM prompt receives the transcript as an extra text line alongside the screenshot.

**Content QA (free side-effect):** `audio_assets.cy.ts` reads the task's full asset manifest (`window.__mediaAssets`) and asserts every *narration* asset has a non-empty transcript (non-speech cues like `coin`/`select`/`nullAudio` are exempt). Known upstream gaps are quarantined in that spec so it fails loud only on **new** untagged narration.

**Backfilling missing tags:** `scripts/backfill_audio_transcripts.ts` repairs assets in the bucket that are missing transcript frames. It scans every item-bank audio file, looks up the canonical text from the audio-generation source of truth (`levante_translations/.../item_bank_translations.csv`, keyed by `item_id` + locale), writes the TXXX frames, and re-uploads via `gsutil`. Dry run by default; pass `--apply` to write (and `--locale=`/`--task=`/`--limit=` to scope).

## EGMA math

EGMA (Early Grade Math Assessment) is the second task. Its model lives in
`cypress/support/tasks/egmaMath.ts` and it leans heavily on the [audio
channel](#audio-channel-narration-transcripts): unlike H&F, several item types
carry the question **only in the narration**, so the audio pipeline is a hard
prerequisite, not a nicety.

Seven item types are detected and handled, classified **screen-first then
audio** (`classifyItem`) and solved deterministically (`solveItem` /
`solveNumberLine`):

| Item type            | Question source        | Oracle strategy                              |
| -------------------- | ---------------------- | -------------------------------------------- |
| number-identification| narration "Choose the N"| tap the choice equal to N                   |
| number-comparison    | narration / silent     | tap the larger value (smaller if asked)      |
| missing-number       | on-screen sequence     | infer the blank from the common step         |
| arithmetic (+ − ×)   | on-screen expression   | evaluate the expression                      |
| fraction             | on-screen MathML       | parse `<mfrac>` operands, compute the value  |
| number-line          | on-screen slider       | read target + range, place the slider        |

The first four are multiple-choice and asserted at **exact 100%**, cross-checked
against the task's own answer key (see [How correctness is
validated](#how-correctness-is-validated)) — so the assertion means "our
computed answer matched the task's key on every item", and any disagreement
fails the run with a logged artifact. The number-line is a slider, so it is
**proximity-scored**: the oracle reads the target and the input's range and
places the slider, and the run asserts the mean fractional placement error stays
under tolerance (it is excluded from the exact accuracy metric).
Instruction/section screens are advanced via their `OK` button.

The oracle drives ~250 items in one spec; `experimentalMemoryManagement` +
`numTestsKeptInMemory: 0` (in `cypress.config.ts`) and `{ log: false }` on the
hot-path commands keep the runner's memory flat over the long command chain. The
oracle only polls audio for number-identification (the one audio-only type) and
solves every visual item straight from the screen, which keeps the run brisk.

The VLM spec (`egma_math/vlm_agent.cy.ts`) hands each multiple-choice item's
screenshot + transcript to the model, which replies with a single number (or an
`a/b` fraction); that is mapped to a choice and scored against the task's own
answer key (falling back to the deterministic solver only for untagged types).
Because EGMA **gates** practice items (a wrong answer re-presents the same item),
the spec force-advances with the deterministic answer if an item persists, so a
weak model still completes the run while its original answer is the one scored.
The number-line is **VLM-driven**: the model is shown the line with its labeled
endpoints and decides where to place the marker; the placement is proximity-
scored by normalized error (same tolerance as the oracle), not auto-advanced.

## Vocab

Vocab (picture vocabulary) is the third task; its model lives in
`cypress/support/tasks/vocab.ts`. It is a **4-alternative forced-choice picture
task**: a word is spoken (narration only — no on-screen text) and four images
are shown in a 2×2 grid; the participant taps the image the word names. Like
EGMA's number-identification, the prompt exists **only in the audio**, so the
[audio channel](#audio-channel-narration-transcripts) is a prerequisite. The
choices carry their concept word in the image `alt` (the button text is empty),
and core-tasks marks the correct choice with a `.correct` class on its `<img>`
under Cypress.

- **Oracle**: reads the four choices' `alt` words, resolves the spoken word from
  the narration transcript (article-stripped, e.g. "the acorn" → `acorn`), and
  matches it to a choice — *independently* of the `.correct` marker. It then
  cross-checks against the app key and asserts agreement on every item (a real
  [differential test](#how-correctness-is-validated)); unmatched items are
  dumped to `_vocab_unsolved.jsonl` and mismatches to `_vocab_key_mismatch.jsonl`.
- **VLM**: sees the screenshot + the spoken word and replies with the grid
  position (1–4) of the matching image; the choice is scored against the app
  key. The number of grid choices and the `.correct` marker make this a clean
  image-recognition benchmark.

The corpus is ~171 items, so a full run is long; `maxIncorrect` is raised in
`DEFAULT_PARAMS` so a solver/model error never triggers the task's early-abort
and truncates the run (we want every item attempted for the cross-check). Vocab
is **not** gated (no practice re-presentations in the shipped corpus), so the
specs are simpler than EGMA's.

## Stories (Theory of Mind)

Stories (task id `theory-of-mind`) is the fourth task; its model lives in
`cypress/support/tasks/stories.ts`. Each of the **6 stories** is told as a
sequence of narrated, illustrated **story beats** (instruction screens), then
asks **2–4-choice picture questions** — false-belief ("where will she look
first?"), reality checks ("where is it really?"), and emotion reasoning ("how
does she feel?"). A full run is **30 story beats + 31 questions**. The narration
is the story, so the [audio channel](#audio-channel-narration-transcripts) is a
prerequisite; the question and story text also render on-screen (read from
`.instruction-small`).

Two things set it apart from the other tasks:

- **The answer can't be computed by a rule.** Following a false-belief story and
  reasoning about a character's mistaken belief is exactly the cognitive skill
  under test, so there is no independent solver to build. The **oracle** simply
  clicks the app's `.correct` key (like core-tasks' own e2e) and asserts what
  *is* checkable — completion, captured narration, and that **every item ships
  an answer key**. See [How correctness is validated](#how-correctness-is-validated).
  The real artifact here is the **VLM benchmark**.
- **Choices are staggered.** Each picture choice renders disabled
  (`.lev-staggered-disabled`) and is revealed one at a time with its own audio
  label; only after the last is revealed do all become clickable. The model
  reads "all choices revealed" as *no button still carries the stagger class*
  (`isItemReady`), and captures the question narration during the stagger
  (before the choice-label clips play).

The **VLM** is given the **accumulated story narration** as context (reset at
each story boundary — "Nice work! Here is a new story.") plus the current
question and a screenshot of the numbered picture choices, and replies with the
position (1–n) of its answer; the choice is scored against the app key. This
makes it a genuine multimodal theory-of-mind benchmark: the model must combine
the story (audio), the question, and the choice images. `maxIncorrect` is raised
in `DEFAULT_PARAMS` so a model error never early-aborts the run.

## Same-Different Selection

Same-Different Selection (task id `same-different-selection`) is the fifth task;
its model lives in `cypress/support/tasks/sameDifferent.ts`. It is unusual: a run
(~132 screens) mixes **two very different kinds of item**, and SDS uses *custom*
trials rather than the shared `afcStimulus`. Cards encode their features in the
image `alt`: `{size}-{color}-{shape}[-{number}][-{bg}]`, e.g. `med-blue-circle`.

- **Single-select (~31 items)** — "Choose the card with a circle", "Which of
  these is the same as this one?". Rendered in `#jspsych-html-multi-response-btngroup`;
  under Cypress core-tasks marks the correct **button** (note: the button, not the
  inner `<img>`) with `.correct`. Auto-advances on click, no OK. These are cleanly
  scoreable: the **oracle** clicks the key and asserts every single item is keyed;
  the **VLM** sees the cards + the spoken instruction and picks a position (1–n),
  scored against the key.
- **Multi-select match (~90 rounds)** — "Touch two cards that are the same in some
  way", with 3/4/5 cards. Rendered in `#jspsych-audio-multi-response-btngroup`, with
  **no answer key**: many pairs are valid, and a pair is scored *relationally* (it
  must share a dimension not already matched in this card set). Since there is
  nothing to recompute against, both agents drive these rounds with a **port of
  core-tasks' own passing e2e solver** (`nextMatchPair` — a dimension-overlap
  heuristic with per-set state in `sameDifferent.ts`), and **completing the run is
  the regression signal** (the app accepted every pair). See
  [How correctness is validated](#how-correctness-is-validated).

A live-DOM mapping run grounded every selector before the model was written
(SDS's custom trials differ from vocab/ToM). `cat=false` pins the fixed-order
timeline and `maxIncorrect` is raised so a stray miss never early-aborts.

## Mental Rotation

Mental Rotation (task id `mental-rotation`) is the sixth task; its model lives in
`cypress/support/tasks/mentalRotation.ts`. It is a clean **2-alternative
forced-choice image task** rendered through the shared `afcStimulus` (like Vocab
and Stories): a **target** shape is shown in `.lev-stim-content`, and two image
choices below (`#jspsych-html-multi-response-btngroup button.image-large`) are a
rotated copy of it vs. its mirror — the participant taps the rotation, not the
mirror. Items span 2D silhouettes and 3D block figures at varying angles
(~118 scored trials including duplicates + 2 practice). Choices appear all at
once (no staggered reveal), and every response trial is narrated.

- Under Cypress, core-tasks marks the correct choice's **`<img>`** with `.correct`
  (the non-math `afcStimulus` path). Rather than just trusting that key, the
  **oracle solves each item itself from the images** with a pixel-based
  rotation/mirror solver (`cypress/plugins/mentalRotationSolver.ts`, run node-side
  via the `solveMentalRotation` cy.task) — it fetches the target + choice webps,
  normalizes them (centroid-centered, radius-of-gyration scaled, auto-detected
  foreground polarity since the silhouette choices are inverted white-on-black),
  and picks the choice that overlaps the target under **rotation alone** rather
  than **reflection** (see [How correctness is
  validated](#how-correctness-is-validated)). It clicks its own answer and
  cross-checks it against `.correct` (agreement is currently **100%**;
  disagreements → `cypress/logs/_mr_key_mismatch.jsonl`). It also asserts the task
  completes, every item is keyed (missing keys → `cypress/logs/_mr_no_key.jsonl`),
  and narration is captured. The **VLM** sees the target + choices screenshot and
  the narration, and picks a position (1–2), scored against the same key.

Because some corpus rows repeat, the specs synchronize on a **screen-signature
transition wait** (rather than content dedup) so duplicate consecutive items are
handled separately; both specs add a gate-escape (click the key) for the gated
practice items, where a wrong pick does not advance. `cat=false` pins the fixed
timeline and `maxIncorrect` is raised so a stray miss never early-aborts.

The geometric solver was validated offline against all 113 unique corpus items
(target/choice webps fetched from `levante-assets-dev`) at **113/113** before
wiring into the oracle, then re-confirmed at **118/118** through the live DOM.

## Matrix Reasoning

Matrix Reasoning (task id `matrix-reasoning`) is the seventh task; its model
lives in `cypress/support/tasks/matrixReasoning.ts`. It is a **4-alternative
forced-choice image task** rendered through the shared `afcStimulus` (like Vocab,
Stories, and Mental Rotation): a composite **matrix-with-a-missing-cell** image is
shown in `.lev-stim-content-x-3`, and four tile choices
(`#jspsych-html-multi-response-btngroup button.image-matrix`) complete the visual
pattern. There are 2 practice + ~78 test items; choices appear all at once (no
stagger) and every response trial is narrated.

- Under Cypress, core-tasks marks the correct choice's **`<img>`** with `.correct`.
  That key is the **only** ground truth: the analogy needs visual pattern
  inference and the `alt`s are opaque asset keys, so — like Stories — the **oracle
  is key-driven**, clicking the keyed answer and asserting the task completes,
  narration is captured, and **every scored item is keyed** (missing keys →
  `cypress/logs/_matrix_no_key.jsonl`, failing the run). The **VLM** sees the
  matrix + choices screenshot and the narration, and picks a position (1–4),
  scored against the same key. See
  [How correctness is validated](#how-correctness-is-validated).

This task preloads a large image bank, so the specs allow extra time for the
loading screen before the fullscreen "OK". `cat=false` pins the fixed timeline and
`maxIncorrect` is raised so a stray miss never early-aborts.

## TROG

TROG (Test for Reception of Grammar; task id `trog`) is the eighth task; its model
lives in `cypress/support/tasks/trog.ts`. It is a **4-alternative forced-choice
grammar-comprehension task** rendered through the shared `afcStimulus`, and it
shares **Vocab's response layout** (`.lev-response-row-inline` + a 2×2 grid of
`button.image-medium`, each wrapping an `<img>`). A **sentence is spoken** (e.g.
*"the boy is running"*) and the participant picks the one of four pictures whose
scene matches it. ~99 test items span grammatical constructions — nouns, verbs,
negatives, reversible passives, prepositions, relative clauses, etc. Choices
appear all at once (no stagger).

- Crucially, there is **no on-screen sentence** on response trials — the sentence
  is delivered **only by narration** (like Vocab). But unlike Vocab — whose choice
  `alt`s *are* the target word — TROG `alt`s are opaque image asset keys
  (`13-boy-running`) and matching a *sentence* to a *picture* needs both language
  and vision. So the **oracle is key-driven** (like Stories / Matrix): under
  Cypress core-tasks marks the correct choice's **`<img>`** with `.correct`, the
  oracle clicks it, and asserts the task completes, **every scored item is keyed**
  (missing keys → `cypress/logs/_trog_no_key.jsonl`, failing the run), and the
  sentence narration is captured. The **VLM** is the real benchmark — it receives
  the sentence as an ID3 audio **transcript** plus the picture choices, and picks a
  position (1–4) scored against the same key. See
  [How correctness is validated](#how-correctness-is-validated).

`cat=false` pins the fixed timeline and `maxIncorrect` is raised so a stray miss
never early-aborts; the specs also allow extra time for the image-bank loading
screen before the fullscreen "OK".

## Memory Game

Memory Game (task id `memory-game`) is the ninth task; its model lives in
`cypress/support/tasks/memoryGame.ts`. It is a **Corsi block-tapping** spatial
memory-span task (built on `@jspsych-contrib/plugin-corsi-blocks`), and it is
mechanically unlike the forced-choice tasks: each item is **two** jsPsych trials
— a **display** trial that flashes a sequence of grid blocks one-at-a-time, then
an **input** trial where the sequence is reproduced by clicking the blocks in the
**same** order (forward block) or **reverse** order (backward block). The span
grows by one after every three correct trials; the run is 16 forward + 21
backward test reps (plus practice), and we pass `age=10` to get the 3×3 grid and
the normal (non-"heavy") instruction path.

There is **no `.correct` marker**, so rather than reading the key this oracle is a
genuine **differential test** (the Mental Rotation philosophy):

- An in-page recorder (installed at `onBeforeLoad`, alongside the audio capture)
  watches the blocks and logs every presentation flash. Flashes are detected by
  **color polarity** (a strongly dark-blue fill) rather than an exact RGB match,
  because the display trial leaves CSS transitions on, so the highlight animates
  into `#275BDD`; this also ignores the lighter click-feedback blue. The buffer is
  cleared after each item, so it only ever holds the current display's flashes.
- At the input trial the oracle reads its **observed** sequence, cross-checks it
  against the app's internal key (`window.cypressData.correctAnswer`, forward
  order, exposed only under Cypress), then **reproduces the observed sequence**
  (reversed on backward trials, detected by the input prompt differing from the
  forward one). Disagreements go to `cypress/logs/_memory_key_mismatch.jsonl` and
  fail the run.
- The run then asserts the app's own per-trial scoring (read from
  `window.initJsPsych` data) **accepted every reproduction**, that both blocks ran,
  and that narration was captured. So we verify both that the animation renders the
  true sequence AND that reproducing it is scored correct.

**VLM: this task is oracle-only.** The stimulus is a temporal animation, so a
single screenshot can't capture the sequence; a meaningful VLM benchmark would
need multi-frame/video capture.

## Layout

```
cypress/
  e2e/hearts_and_flowers/   oracle.cy.ts, vlm_agent.cy.ts, audio_assets.cy.ts, rule_equivalence.cy.ts
  e2e/egma_math/            oracle.cy.ts, vlm_agent.cy.ts
  e2e/vocab/                oracle.cy.ts, vlm_agent.cy.ts
  e2e/stories/              oracle.cy.ts, vlm_agent.cy.ts
  e2e/same_different/       oracle.cy.ts, vlm_agent.cy.ts
  e2e/mental_rotation/      oracle.cy.ts, vlm_agent.cy.ts
  e2e/matrix_reasoning/     oracle.cy.ts, vlm_agent.cy.ts
  e2e/trog/                 oracle.cy.ts, vlm_agent.cy.ts
  e2e/memory_game/          oracle.cy.ts (oracle-only; temporal-animation stimulus)
  e2e/                      dashboard_launch.cy.ts (participant → dashboard launch smoke test)
  support/
    tasks/                  heartsAndFlowers.ts, egmaMath.ts, vocab.ts, stories.ts, sameDifferent.ts, mentalRotation.ts, matrixReasoning.ts, trog.ts, memoryGame.ts (task models), types.ts (zod schemas)
    agents/                 oracleAgent.ts, vlmAgent.ts, egmaVlmAgent.ts, vocabVlmAgent.ts, storiesVlmAgent.ts, sdsVlmAgent.ts, mentalRotationVlmAgent.ts, matrixReasoningVlmAgent.ts, trogVlmAgent.ts
    audio/                  audioCapture.ts (play-log monkeypatch), id3.ts (cy.task wrapper), audioOracle.ts
    launch.ts               launchTask: standalone demo vs -dev dashboard participant flow
    persona/                childPersona.ts (age-persona prompt builder), age_task_accuracy.json + persona_template.txt (shared with levante-bench)
    e2e.ts, commands.ts
  plugins/
    vlmClients/             index.ts (dispatch), openai.ts, anthropic.ts, gemini.ts
    id3Reader.ts            node-side fetch + node-id3 parse + cache
    mentalRotationSolver.ts node-side pixel rotation/mirror solver (authentic MR oracle)
scripts/                    score.ts, score_egma.ts, score_vocab.ts, score_stories.ts, score_sds.ts, score_mr.ts, score_matrix.ts, summarize_runs.ts, sync_persona.mjs
dashboard/                  server.mjs (run orchestration backend), catalog.mjs (task→spec map), storage.mjs (GCS run-history mirror)
  public/                   index.html, app.js, styles.css (Pitwall-styled UI: Launch + Results tabs)
.github/workflows/          qa.yml (oracle + audio on PR), vlm-nightly.yml (scheduled matrix)
```

The dashboard's per-run provisioner lives in the sibling repo at
`levante-support/scripts/e2e-init/provision-participant.mjs`.

Diagnostic logs written during a run (git-ignored):

```
cypress/logs/_egma_oracle_live.jsonl     append-as-you-go oracle trial log (EGMA)
cypress/logs/_egma_vlm_live.jsonl        append-as-you-go VLM trial log (EGMA)
cypress/logs/_egma_key_mismatch.jsonl    items where our answer ≠ the task's answer key
cypress/logs/_egma_unsolved_dom.jsonl    DOM dumps of items the solver could not answer
cypress/logs/_vocab_oracle_live.jsonl    append-as-you-go oracle trial log (Vocab)
cypress/logs/_vocab_vlm_live.jsonl       append-as-you-go VLM trial log (Vocab)
cypress/logs/_vocab_key_mismatch.jsonl   vocab items where our answer ≠ the answer key
cypress/logs/_vocab_unsolved.jsonl       vocab items the audio solver could not match
cypress/logs/_stories_oracle_live.jsonl  append-as-you-go oracle trial log (Stories)
cypress/logs/_stories_vlm_live.jsonl     append-as-you-go VLM trial log (Stories)
cypress/logs/_stories_no_key.jsonl       Stories question items that shipped no answer key
cypress/logs/_sds_oracle_live.jsonl      append-as-you-go oracle trial log (SDS)
cypress/logs/_sds_vlm_live.jsonl         append-as-you-go VLM trial log (SDS)
cypress/logs/_sds_no_key.jsonl           SDS single-select items that shipped no answer key
cypress/logs/_mr_oracle_live.jsonl       append-as-you-go oracle trial log (Mental Rotation)
cypress/logs/_mr_vlm_live.jsonl          append-as-you-go VLM trial log (Mental Rotation)
cypress/logs/_mr_no_key.jsonl            Mental Rotation items that shipped no answer key
cypress/logs/_mr_key_mismatch.jsonl      MR items where the pixel solver disagreed with the app key
cypress/logs/_matrix_oracle_live.jsonl   append-as-you-go oracle trial log (Matrix Reasoning)
cypress/logs/_matrix_vlm_live.jsonl      append-as-you-go VLM trial log (Matrix Reasoning)
cypress/logs/_matrix_no_key.jsonl        Matrix Reasoning items that shipped no answer key
cypress/logs/_trog_oracle_live.jsonl     append-as-you-go oracle trial log (TROG)
cypress/logs/_trog_vlm_live.jsonl        append-as-you-go VLM trial log (TROG)
cypress/logs/_trog_no_key.jsonl          TROG items that shipped no answer key
cypress/logs/_memory_oracle_live.jsonl   append-as-you-go oracle trial log (Memory Game)
cypress/logs/_memory_key_mismatch.jsonl  Memory Game items where the observed flashes ≠ the internal key
```

## Conventions

- **TypeScript strict**, no `any`, no hard-coded API keys.
- **All trial records validated** through the zod schema in `cypress/support/tasks/types.ts`.
- **Selectors are defined only** in the per-task support file (`tasks/<task>.ts`), never inline in specs. Unverified selectors carry a `TODO(selectors)` comment — confirm them against the live DOM before relying on a green oracle run.
- **Provider clients live behind a small interface** (`VLMClient` in `plugins/vlmClients/index.ts`); adding a VLM is one new file plus one dispatch-table entry.

## ROAR literacy tasks (PA, SRE, SWR) — in progress

These three tasks live in the dashboard as **ROAR packages** (`@bdelab/roar-pa`, etc.), not on
`levante-tasks-demo`. They use route `/game/pa` (not `/game/core-tasks/…`) and require
`LAUNCH=dashboard` plus a provisioned assignment (`provision-participant.mjs --task pa`).

**PA (phonological awareness)** — first task under investigation:

- **Launch:** `cypress/support/launch.ts` → `launchRoarTask()` (home tab → “Click to start” → `/game/pa`).
- **Explore spec:** `cypress/e2e/pa/_explore.cy.ts` logs DOM snapshots to `cypress/logs/_pa_explore.jsonl`.
- **Flow discovered:** custom intro (“click the button on the screen”) → fullscreen **Continue** →
  audio-calibration screens → then `jspsych-audio-button-response-button` trials (phoneme audio +
  four image choices). Not the core-tasks text **OK** button.
- **Bench data:** `levante-bench` has ~10k `pa` trials in `trials.csv`; no `pa` IRT ability file yet.
- **Answer key:** `sessionStorage.currentStimulus` → JSON `.goal` (image stem); oracle clicks
  `img[src*="<goal>.webp"]` (same as `roar-dashboard` `paHelpers.js`). No `.correct` DOM class.
- **Support:** `cypress/support/tasks/pa.ts` (`advancePaIntro`, `readGoalFromWindow`).
- **Oracle:** `cypress/e2e/pa/oracle.cy.ts` — full English playthrough (`pnpm cy:run:pa:oracle`).
- **Score:** `pnpm score:pa` → `results/pa_summary.csv`.
- **Next:** VLM spec; SRE/SWR one at a time.

SRE and SWR follow the same ROAR shell — we will tackle them one at a time after PA.

## Adding a new task

1. Create `cypress/support/tasks/<task>.ts` exporting: `URL_BASE`, `DEFAULT_PARAMS`, selectors (with `TODO(selectors)`), `readStimulus`, `correctAction`, any task-specific congruency/condition helpers, and `scoreTrials`.
2. Reuse `cypress/support/tasks/types.ts` (extend the schemas if the task needs extra fields).
3. Add sibling specs `cypress/e2e/<task>/oracle.cy.ts` and `cypress/e2e/<task>/vlm_agent.cy.ts` modeled on the Hearts & Flowers pair.
4. Ground "correct" in real truth (see [How correctness is validated](#how-correctness-is-validated)): if the task marks its answer in the DOM under Cypress, have the oracle assert its computed answer matches that key and score the VLM against it; if not, pin the rule to core-tasks with a pure-logic equivalence spec like `rule_equivalence.cy.ts`.
5. The `cy:run:oracle` / `cy:run:vlm` globs and both workflows pick up the new specs automatically.

## CI

- **`qa.yml`** — on push/PR: install, typecheck, run the oracle specs and the audio content-QA headless, upload `cypress/logs` (and screenshots on failure).
- **`vlm-nightly.yml`** — `workflow_dispatch` + nightly cron. Matrix over `[openai, anthropic, gemini]`, reading `*_API_KEY` from repo secrets. Runs the VLM specs, then `pnpm score`, and uploads logs + `results/`.
