# VLM synthetic-respondent panel (pre-launch item difficulty screen)

A tool for screening LEVANTE task items **before** human data exists, by running a
panel of vision-language-model (VLM) "children" of varying ability through the
real task in the browser, estimating each item's difficulty and discrimination
from their answers, and comparing those estimates to human IRT data where it
exists.

The headline use case is catching **broken or mistranslated items** early — the
signal that first motivated this tool was TROG `item-78`
(`trog_embedding_cat_cow_chase_black`), a German center-embedded relative clause
whose translation reverses agent/patient and which only **1%** of German children
answered correctly. This panel re-discovers that item from a **cross-language
difficulty shift** with no human data at all.

> TL;DR: run `run_panel.mjs` (one locale) or **`run_langs_trog.mjs`** (cross-lang
> TROG refresh), then `analyze.mjs`. Plain-language takeaways:
> **[`LEARNINGS.md`](LEARNINGS.md)**. Numbers + handoff: **[`RESULTS.md`](RESULTS.md)**.
> Agent rules: [`.cursor/rules/vlm-panel.mdc`](../../.cursor/rules/vlm-panel.mdc).
>
> Translation triage: `out/review_xlang_<lang>.csv` (`strong_delta=yes` ⇒ |Δ|≥0.25 vs EN).

---

## Why this works (and its limits)

- A real translation/keying defect makes an item hard for **everyone**, including
  a capable model. If a model that aces the English version fails the German
  version of the *same* item, the German text or answer key is the prime suspect.
- A **panel** of models spanning ability (model tier × child-age persona ×
  temperature seeds) is needed because item *discrimination* (does the item
  separate strong from weak respondents?) can only be estimated when respondents
  actually differ in ability. If everyone scores the same, discrimination is
  undefined — the analyzer says so loudly via a **spread gate**.
- **The stimulus is never altered.** Ability is varied only on the responder side.
- This is a **screen, not ground truth.** It surfaces candidates for human
  review; it does not replace human psychometrics. VLMs have blind spots (e.g.
  negation) that a single-language pass will miss — which is exactly why the
  **cross-language shift** (where blind spots cancel) is the most trustworthy
  signal here.

---

## Directory layout

```
tools/vlm-panel/
  run_panel.mjs            # collect a panel: one Cypress run per "respondent"
  run_langs_trog.mjs       # multi-locale TROG: force stale langs, resume others
  run_xlang_pipeline.sh    # full EN→DE→analyze→ES→NL→analyze chain
  analyze.mjs              # build difficulty screen + human comparison + child preds
                           # + review_xlang_<lang>.csv (delta vs en)
  calibration.mjs          # isotonic / logistic p_vlm → p_pred_child (+ vocab Zipf prior)
  vocab_lexicon.json       # wordfreq Zipf table for vocab bank (rebuild: build_vocab_lexicon.py)
  trog_smoke_items.json    # spatial/negation regression allowlist
  check_trog_smoke.mjs     # smoke gate vs out/screen_en.csv
  aggregate_usage.mjs      # sum out/usage/*.jsonl token totals
  run_xlang_pipeline_3x.sh # force-all matched 3.x en/de/es/nl recollect
  benchHuman.mjs           # load levante-bench trials / proportions
  fit_bench_calibrator.mjs # fit on bench trials; compare to diag; write caches
  audit_residuals.mjs      # where p_vlm disagrees with humans (prompt targets)
  estimate_difficulty.mjs  # map p_pred_child → bank-scale d_est; held-out eval
  calibration/             # saved calibrators + item_pass_rates_* + age_item_rates_*
  panel_grid.json          # TROG grid (models × ages × repeats)
  panel_grid_stories.json  # Stories (Theory of Mind) grid
  README.md                # this file
  out/
    manifest.json          # per-respondent covariates + run status (resumable)
    logs/<runId>.log       # raw Cypress stdout/stderr per respondent
    report.md              # TROG screen   (task=trog uses bare filenames)
    screen_<lang>.csv      # every item: flags, p_vlm, p_human, p_pred_child, p_pred_age_*
    review_<lang>.csv      # items needing review, prioritized
    bench_calibration_<task>.md  # diag vs bench calibrator comparison
    report_stories.md      # Stories screen (non-trog tasks are namespaced)
    screen_stories_<lang>.csv
    review_stories_<lang>.csv
```

Trial logs themselves land in `cypress/logs/runs/<runId>/vlm_*.jsonl` (one
respondent per directory). `analyze.mjs` reads those, not `out/`.

---

## Quickstart

Prerequisites:

- A working LEVANTE QA Cypress setup (this repo) able to run the VLM-agent specs
  against `https://levante-tasks-demo.web.app/`.
- `GEMINI_API_KEY` exported (the panels here use Gemini). The runner runs Cypress
  headless via WSLg/Electron.

### Cross-language TROG (recommended for translation QA)

```bash
# Default: en-US resume, de-DE+es-CO force+resume, nl-NL collect. Log: out/recollect_xlang.log
node tools/vlm-panel/run_langs_trog.mjs

node tools/vlm-panel/analyze.mjs --task trog --human-source=bench
# open out/review_xlang_de.csv / _es.csv / _nl.csv
```

June 2026 de/es panels are **stale** relative to Aug 2026 EN prompt fixes — force
refresh them before trusting cross-language deltas.

### Single-locale panel

```bash
node tools/vlm-panel/run_panel.mjs --grid tools/vlm-panel/panel_grid.json --lang en-US
```

Collect + analyze (resume by default):

```bash
node tools/vlm-panel/analyze.mjs --task trog --human-source=bench
```

Stories (Theory of Mind), all three languages, then analyze:

```bash
node tools/vlm-panel/run_panel.mjs --grid tools/vlm-panel/panel_grid_stories.json --lang en-US
node tools/vlm-panel/run_panel.mjs --grid tools/vlm-panel/panel_grid_stories.json --lang de-DE
node tools/vlm-panel/run_panel.mjs --grid tools/vlm-panel/panel_grid_stories.json --lang es-CO
node tools/vlm-panel/analyze.mjs --task stories
```

Useful runner flags: `--dry-run` (print the plan), `--limit N` (first N
respondents — a smoke test).

---

## How the runner works (`run_panel.mjs`)

Expands a grid into one **respondent** per `(model × age × repeat)` cell and runs
the task's VLM-agent spec once per respondent, **sequentially**. Each respondent
gets a unique `QA_RUN_ID` so its trial log is isolated. **Resume is the default:**
respondents with a finalized `vlm_*.jsonl` (>64 bytes) are skipped; failed /
stub / missing cells are retried and stubs are cleared automatically. Pass
`--force` only to re-run successes too (expensive; use after intentional prompt
changes on already-finished cells).

Ability is varied only on the responder side, via environment variables the spec
and persona layer read:

| Env var | Set from | Effect |
|---|---|---|
| `GEMINI_MODEL` | grid `models[]` | model tier (the main spread driver) |
| `QA_PERSONA=child` | fixed | enables the child-age persona preamble |
| `QA_PERSONA_AGE_YEARS` | grid `ages[]` | which child age to emulate |
| `QA_PERSONA_ABILITY=irt` | grid `personaAbility` | grounds the persona in real per-age IRT θ |
| `VLM_TEMPERATURE` | grid `temperature` | within-cell variance across repeats |
| `QA_LANGUAGE` | `--lang` | the run language (e.g. `en-US`, `de-DE`, `es-CO`) |
| `QA_RUN_ID` | derived | isolates this respondent's logs |

Run id format: `panel_<task>_<lang>_<model>_a<age>_r<rep>`
(e.g. `panel_trog_de_25pro_a8_r2`). `analyze.mjs` parses task and language back
out of this.

The runner also defensively unsets two env vars that break Cypress in editor/
sandbox contexts: a sandboxed `CYPRESS_CACHE_FOLDER`, and `ELECTRON_RUN_AS_NODE`
(which makes Cypress's Electron boot as plain Node and crash).

### Grid format

```json
{
  "task": "trog",
  "spec": "cypress/e2e/trog/vlm_agent.cy.ts",
  "provider": "gemini",
  "language": "en",
  "temperature": 0.8,
  "personaAbility": "irt",
  "repeats": 4,
  "models": ["gemini-3.5-flash-lite", "gemini-3.6-flash"],
  "ages": [6, 8, 10, 13]
}
```

`ages` should be the ages for which the task has a real per-age IRT θ (see
`cypress/support/persona/age_task_ability.json`). TROG uses `[6,8,10,13]`;
Theory of Mind only has θ for `[6,8,11]`.

---

## How the analyzer works (`analyze.mjs`)

```bash
node tools/vlm-panel/analyze.mjs --task <trog|stories>
```

Pipeline per language:

1. **Load panel** — one respondent per run dir; keep scored rows for the task.
2. **Non-response handling** — a row whose `chosenIndex` is `null` (the model
   emitted no parseable choice) is treated as **missing, not wrong**. Counting
   non-responses as 0 deflates `p_vlm` and, because non-response rates differ by
   language, fabricates fake cross-language "difficulty." (See *Known issues*.)
3. **Spread gate** — report the distribution of per-respondent total scores. If
   everyone is near ceiling/floor there is no ability variance and discrimination
   is meaningless; the report marks the language `INADEQUATE`.
4. **Per-item stats** — `p_vlm` (difficulty) and a rest-score-corrected
   point-biserial `rpb_vlm` (discrimination).
5. **Human join** (see below) → attaches `p_human`, `pb_human`.
6. **Flags** — `BROKEN` (`p_vlm` below the item's chance level), `HARD` (bottom
   of panel), `CEILING` (top of panel, uninformative), else `OK`.
7. **Validation** — Spearman ρ of `p_vlm` vs human `p_correct` and of `rpb_vlm`
   vs human `point_biserial`; broken/ceiling catch rates.
8. **Cross-language shift** — per item, `p_vlm(lang) − p_vlm(en)`. A large
   negative shift in a target language is the strongest pre-launch
   broken-translation signal, and it cancels panel composition. **This is the
   key output.**

### The human-data join (item identity)

The chain that bridges a VLM trial to human psychometrics, per language:

```
normalized item text (run language)
  → item_id          via the approved itembank strings (task + country)
  → item_uid         via the task's item-bank.csv (audio_file/item_id → item_uid)
  → human p_correct, point_biserial
                     via levante-pilots/.../diag_items_allstats_selected.csv
                         (task, subset=lang, item)
```

Translation strings (the `text → item_id` step) always come from a live source
keyed by task + country — never a checked-in CSV or XLIFF. Select it with
`QA_TRANSLATIONS_SOURCE`:

- **`draft`** (default) — the per-task/per-locale JSON published to
  `levante-assets-draft/translations/itembank/<task>/<locale>/item-bank-translations.json`
  (a flat `{ item_id: string }` map). Override the base with `QA_ITEMBANK_BASE_URL`.
- **`crowdin`** — the non-hidden, **approved** strings read directly from the
  Crowdin API (no export/build, no XLIFF). The string `identifier` is the
  `item_id`. Needs `CROWDIN_API_TOKEN` (or `~/.crowdin_api_token`) and optionally
  `CROWDIN_PROJECT_ID`.

There is deliberately **no** fallback to a CSV/XLIFF: if the chosen source has no
strings for a language the cross-language alignment is left empty and the run
warns loudly.

Other external data sources (paths relative to the `levante/` workspace root) —
these are structural/research data, not translation strings:

- `crowdin-projects/corpora/<task>/shared/corpora/<task>-item-bank.csv` —
  `item_id`/`audio_file` → `item_uid`, plus per-item `chance_level`.
- `levante-pilots/04_papers/display/diag_items_allstats_selected.csv` — human
  item stats by `task` + `subset` (language).

`analyze.mjs` uses a full RFC-4180 CSV parser (quoted commas/newlines/`""`) for
those CSVs, required because ToM prose cells embed all three.

### Adding a new task

Add an entry to the `TASKS` map in `analyze.mjs`:

```js
mytask: {
  title: 'My Task',
  diagTask: 'mytask',          // the `task` value in the diag CSV
  scoredType: 'item',          // the spec's scored itemType ('item' | 'question' | ...)
  itemBank: join(CORPORA, 'mytask', 'shared', 'corpora', 'mytask-item-bank.csv'),
  identity: (rec) => rec.audioTranscript,  // what uniquely names an item in the log
  defaultChance: 0.25,         // fallback when the item bank has no chance_level
}
```

then create a `panel_grid_<task>.json` pointing at that task's VLM-agent spec.
Output files for any non-`trog` task are namespaced (`report_<task>.md`, etc.) so
panels never clobber each other.

---

## The persona layer

`QA_PERSONA=child` + `QA_PERSONA_AGE_YEARS` makes `cypress.config.ts` prepend a
persona preamble (`cypress/support/persona/childPersona.ts`) to the VLM system
prompt, grounded — when `QA_PERSONA_ABILITY=irt` — in real LEVANTE per-age
accuracy and IRT θ:

- `cypress/support/persona/age_task_ability.json` — per-age mean θ per task.
- `cypress/support/persona/age_task_accuracy.json` — per-age accuracy per task.

Empirically the **age persona is largely inert** (the models do not reliably
"play younger"); the real ability spread comes from **model tier** and
temperature seeds. Keep the persona — it is cheap and occasionally helps — but do
not rely on it as the primary spread driver.

---

## Results to date

### TROG (`out/report.md`)

Panel: 3 models × 4 ages × 4 repeats per language (en/de/es), Gemini, temp 0.8.

| lang | respondents¹ | items | ρ(difficulty) | below-chance items caught |
|---|---|---|---|---|
| en | 32 | 99 | 0.40 | 2/2 |
| de | 32 | 99 | 0.56 | 1/1 |
| es | 32 | 99 | 0.62 | 3/3 |

¹ after excluding all-non-response respondents (see *Known issues* — the 16
pro cells/language were dropped).

- **`item-78` (`trog_embedding_cat_cow_chase_black`) is re-discovered** from the
  German cross-language drop, with **no human data** — the tool's proof of value.
- Difficulty rankings correlate moderately–strongly with humans; discrimination
  correlation is weaker (expected for a coarse panel).

### Stories / Theory of Mind (`out/report_stories.md`)

Panel: 3 models × 3 ages (6/8/11) × 3 repeats per language. Human diag task =
`tom`; per-item chance varies (yes/no 0.5, others 0.33/0.25); ~26 items/language
join to human data.

| lang | respondents | items | ρ(difficulty) | non-response rate |
|---|---|---|---|---|
| en | 18 | 29 | 0.57 | 33% |
| de | 18 | 26 | 0.43 | 33% |
| es | 18 | 22 | 0.54 | 48% |

- **No translation-breakage signal** — the largest cross-language drops are small
  and benign once non-responses are excluded. (An initial "6 broken Spanish
  items at p=0.00" was a **non-response artifact**, not a defect; see below.)
- `tom_moral_reasoning_emotion_reasoning_2` is genuinely hard *and* poorly
  discriminating in **all** languages (human p_correct ≈ 0.41–0.48, low/flagged
  point-biserial) — a candidate-cut item, not a translation issue. Both humans
  and the VLM panel agree.
- **Ability spread is INADEQUATE** for Stories as-run (SD ≈ 0.06–0.08) because
  the high-ability anchor (pro) was non-responsive (now fixed — see below) and
  flash/flash-lite are near ceiling on ToM. The difficulty *ranking* still holds,
  but discrimination estimates and the screen are low-resolution until a panel is
  re-collected with a working pro tier.

---

## Known issues & caveats

### Predicting average child performance (new items / translations)

`analyze.mjs` fits a **monotonic calibrator** that maps ungated panel pass-rates
(`p_vlm`) to predicted average child pass-rates (`p_pred_child`). This is the
path for evaluating a **new item or translation** where no IRT `d` exists — the
VLM must actually answer the item; the IRT Bernoulli gate cannot help here.

```bash
# After a panel is on disk (or only new-locale cells were added):
node tools/vlm-panel/analyze.mjs --task vocab
# -> out/screen_vocab_<lang>.csv columns include p_pred_child, p_pred_age_6/8/10
# -> tools/vlm-panel/calibration/vocab_en.json (reused for locales without human joins)
```

**Workflow for a new translation pack**

1. Collect an **ungated** VLM panel for that locale (`run_panel.mjs --lang …`).
2. Run `analyze.mjs` for the task. `en` is analyzed first so its calibrator is
   available; locales with no human item joins **reuse the en calibrator**.
3. Read `p_pred_child` on `out/screen_*_<lang>.csv` as the predicted pooled child
   pass-rate. Use cross-language `p_vlm` drops (same report) as the translation-
   breakage signal; use `p_pred_child` when you need an absolute difficulty guess.

**Better human targets from levante-bench**

Sibling repo `../levante-bench` has trial-level child data. Prefer that over the
diag CSV when available:

```bash
# Build trial pass-rates + age×item rates + side-by-side vs diag:
node tools/vlm-panel/fit_bench_calibrator.mjs --task vocab
node tools/vlm-panel/fit_bench_calibrator.mjs --task trog

# Re-analyze using bench trial pass-rates (and empirical p_pred_age_* when known):
node tools/vlm-panel/analyze.mjs --task vocab --human-source=bench
```

Uses `trials.csv` aggregated `correct` (not `proportions.csv` image1 — vocab
option columns are not reliably target-in-image1). Override root with
`LEVANTE_BENCH_ROOT`.

**What the numbers mean**

| Column | Meaning |
| --- | --- |
| `p_vlm` | Empirical panel pass-rate (ungated) |
| `p_pred_child` | Calibrated estimate of average child `p_correct` |
| `p_pred_age_6/8/10` | Approximate age shift via task-level norms in `age_task_accuracy.json` (not true age×item rates) |

Calibrator: **isotonic regression** when ≥20 matched human items; else **logistic**
(Platt-style) when ≥5; else identity / reused en. Reports include in-sample and
held-out CV MAE (calibrated should beat raw `|p_vlm − p_human|`) plus Spearman.

**When not to trust `p_pred_child`**

- Reliability section marks the panel **INCONCLUSIVE** (high TOOL-failure rate).
- Spread gate is **INADEQUATE** (everyone near ceiling/floor).
- No en (or other) calibrator exists yet for the task — predictions are clipped
  `p_vlm`, not child-linked.
- Age columns are proportional shifts of the pooled prediction; do not treat them
  as measured age×item pass-rates.

Do **not** use `QA_PERSONA_GATE=irt` for this workflow: unscored items collapse to
the same age-mean `fallbackP` and cannot differentiate new content.

### Bank-scale `d` estimates (eval)

Hybrid model maps panel predictions (+ item features) onto the **deployed
item-bank** difficulty scale and scores held-out recovery:

```bash
node tools/vlm-panel/estimate_difficulty.mjs --task trog --lang en
node tools/vlm-panel/estimate_difficulty.mjs --task vocab --lang en
# -> out/d_est_<task>_en.csv
# -> out/d_est_<task>_en_report.md
# -> out/d_est_<task>_en_metrics.json
```

**Features:** `z = logit((p_pred−c)/(1−c))`; TROG construction tags (passive,
comparative, reverse_agent, …); vocab Zipf + rare flag from `vocab_lexicon.json`.
**Fit:** standardized ridge + Huber IRLS. Reports compare multivar vs p-only
affine CV and the `−p_pred_child` ranking ceiling.

Prompt changes only move that ceiling after an ungated recollect. Limited EN
TROG prompt-eval grid:

```bash
node tools/vlm-panel/run_panel.mjs \
  --grid tools/vlm-panel/panel_grid_trog_prompt_eval.json --force
# grid.language is en-US (required — audio/en/ 404s; use --lang en-US if overriding)
node tools/vlm-panel/analyze.mjs --task trog --human-source=bench \
  --run-id-re 'panel_trog_en_.*_a(8|10)_r[12]$'
node tools/vlm-panel/estimate_difficulty.mjs --task trog \
  --baseline tools/vlm-panel/out/d_est_trog_en_baseline.json
```

Requires cached banks (`cypress/cache/sim-item-bank-*.csv`). Bench
`irt_models/*_item_params.csv` is report-only `d_bench` (different scale).

### Improving raw `p_vlm` (prompts / panel quality)

Age role-play prompts do not fix child match. After calibration, audit residuals:

```bash
node tools/vlm-panel/audit_residuals.mjs --task trog
node tools/vlm-panel/audit_residuals.mjs --task vocab
# -> out/residuals_<task>.md
```

Targeted fixes already applied for common TROG failure modes (negation, reverse
agent/patient, spatial, comparative) in `trogVlmAgent` (system checklist +
transcript-conditioned user hints). Vocab prompts bias toward ordinary senses;
adult ceiling on rare words is mostly handled by calibration.

**Re-measure requires a new ungated panel** (prompt text is baked into each run).
Vocab’s last panel was TOOL-failure INCONCLUSIVE (~18%) — recollect failed cells
(and prefer `VLM_MAX_RETRIES=8+`) before comparing MAE/ρ to the residual baseline.

### `gemini-2.5-pro` was 100% non-response (FIXED)

`gemini-2.5-pro` requires "thinking" mode. The client first tried
`thinkingConfig.thinkingBudget = 0`, which pro rejects, then retried *with*
thinking but kept `maxOutputTokens: 32`. Pro's reasoning tokens consumed the
entire 32-token budget, leaving **nothing** for the visible digit → empty
response → non-response on **every** item, on **both** TROG and Stories.

Fix (`cypress/plugins/vlmClients/gemini.ts`): the thinking-required retry path
now uses `maxOutputTokens: 2048`, so the answer survives the thinking budget.
Verified live (pro now emits real digits, including genuine errors). flash and
flash-lite are unchanged (≈8% non-response).

**Consequence for existing data:** any panel collected before this fix has a dead
pro tier. TROG still produced a valid spread (flash/flash-lite × 4 ages);
**Stories should be re-collected** for the pro cells to restore spread before its
screen is trusted.

### Non-response must be treated as missing, not wrong

The specs score a `null` choice as `correct=false`. `analyze.mjs` excludes such
rows from `p_vlm`. If you change this, cross-language deltas become dominated by
differential non-response rates rather than translation quality.

### `_*_vlm_live.jsonl` is an append log — do not analyze it

`cypress/logs/_stories_vlm_live.jsonl` (and the TROG equivalent) is a **fixed
path appended across all runs**. It looks multilingual/huge because it
accumulates history. Always analyze the per-run finalized files under
`cypress/logs/runs/<runId>/vlm_*.jsonl` (what `analyze.mjs` does).

### ToM question-text collisions

Theory-of-mind reuses some question wording across scenes (~13 English
collisions), so keying items by question text drops a few cross-language pairs.
This loses data but does not create false signals.

### Spanish has two regional columns

`es` joins try `es-CO` then `es-AR` in the translation CSV; run Spanish with
`--lang es-CO`.

---

## Reproducing the figures in this README

```bash
# TROG (data already on disk):
node tools/vlm-panel/analyze.mjs --task trog      # -> out/report.md

# Stories (data already on disk):
node tools/vlm-panel/analyze.mjs --task stories   # -> out/report_stories.md
```

To re-collect from scratch, run `run_panel.mjs` per language first (each panel is
many hours; runs are sequential and resumable).
