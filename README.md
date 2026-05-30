# levante-qa

QA / regression and VLM-agent benchmarking for [LEVANTE](https://github.com/levante-framework) core tasks, built on [Cypress](https://www.cypress.io/) + TypeScript.

This repo serves two purposes:

1. **QA / regression** — a deterministic, DOM-driven **oracle** agent plays a task end-to-end and asserts it can be completed at 100% accuracy with no timeouts. This catches regressions in the task itself (selectors, stimulus rendering, scoring, block sequencing).
2. **VLM-agent benchmarking** — the *same* task is driven by a vision-language model in the loop (screenshot → model → click), letting us benchmark how well different models perform the cognitive task.

Two tasks are implemented today — **Hearts & Flowers** and **EGMA math** — and others follow the same structure (see [Adding a new task](#adding-a-new-task)).

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

Per-task runners are also available, e.g. `pnpm cy:run:egma:oracle` and
`pnpm cy:run:egma:vlm -- --env provider=gemini`.

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

## Architecture

Two agent paths share the same task model (selectors, stimulus parser, response rule, scoring) and the same trial-logging pipeline:

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
| number-line          | on-screen slider       | read target + range, place the slider        |

The first four are multiple-choice and asserted at **exact 100%**. The
number-line is a slider, so it is **proximity-scored**: the oracle reads the
target and the input's range and places the slider, and the run asserts the mean
fractional placement error stays under tolerance (it is excluded from the exact
accuracy metric). Instruction/section screens are advanced via their `OK`
button.

The oracle drives ~250 items in one spec; `experimentalMemoryManagement` +
`numTestsKeptInMemory: 0` (in `cypress.config.ts`) and `{ log: false }` on the
hot-path commands keep the runner's memory flat over the long command chain. The
oracle only polls audio for number-identification (the one audio-only type) and
solves every visual item straight from the screen, which keeps the run brisk.

The VLM spec (`egma_math/vlm_agent.cy.ts`) hands each multiple-choice item's
screenshot + transcript to the model, which replies with a single number; that
is mapped to a choice and scored against the deterministic answer. Because EGMA
**gates** practice items (a wrong answer re-presents the same item), the spec
force-advances with the deterministic answer if an item persists, so a weak model
still completes the run while its original answer is the one scored. The
number-line is advanced deterministically and excluded from VLM accuracy.

## Layout

```
cypress/
  e2e/hearts_and_flowers/   oracle.cy.ts, vlm_agent.cy.ts, audio_assets.cy.ts
  e2e/egma_math/            oracle.cy.ts, vlm_agent.cy.ts
  support/
    tasks/                  heartsAndFlowers.ts, egmaMath.ts (task models), types.ts (zod schemas)
    agents/                 oracleAgent.ts, vlmAgent.ts, egmaVlmAgent.ts
    audio/                  audioCapture.ts (play-log monkeypatch), id3.ts (cy.task wrapper), audioOracle.ts
    e2e.ts, commands.ts
  plugins/
    vlmClients/             index.ts (dispatch), openai.ts, anthropic.ts, gemini.ts
    id3Reader.ts            node-side fetch + node-id3 parse + cache
scripts/                    score.ts, score_egma.ts, summarize_runs.ts
.github/workflows/          qa.yml (oracle + audio on PR), vlm-nightly.yml (scheduled matrix)
```

## Conventions

- **TypeScript strict**, no `any`, no hard-coded API keys.
- **All trial records validated** through the zod schema in `cypress/support/tasks/types.ts`.
- **Selectors are defined only** in the per-task support file (`tasks/<task>.ts`), never inline in specs. Unverified selectors carry a `TODO(selectors)` comment — confirm them against the live DOM before relying on a green oracle run.
- **Provider clients live behind a small interface** (`VLMClient` in `plugins/vlmClients/index.ts`); adding a VLM is one new file plus one dispatch-table entry.

## Adding a new task

1. Create `cypress/support/tasks/<task>.ts` exporting: `URL_BASE`, `DEFAULT_PARAMS`, selectors (with `TODO(selectors)`), `readStimulus`, `correctAction`, any task-specific congruency/condition helpers, and `scoreTrials`.
2. Reuse `cypress/support/tasks/types.ts` (extend the schemas if the task needs extra fields).
3. Add sibling specs `cypress/e2e/<task>/oracle.cy.ts` and `cypress/e2e/<task>/vlm_agent.cy.ts` modeled on the Hearts & Flowers pair.
4. The `cy:run:oracle` / `cy:run:vlm` globs and both workflows pick up the new specs automatically.

## CI

- **`qa.yml`** — on push/PR: install, typecheck, run the oracle specs and the audio content-QA headless, upload `cypress/logs` (and screenshots on failure).
- **`vlm-nightly.yml`** — `workflow_dispatch` + nightly cron. Matrix over `[openai, anthropic, gemini]`, reading `*_API_KEY` from repo secrets. Runs the VLM specs, then `pnpm score`, and uploads logs + `results/`.
