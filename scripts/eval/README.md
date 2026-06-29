# SOTA translation evaluation (`levante-qa/scripts/eval`)

A standalone, state-of-the-art pipeline for scoring translation quality, plus a
validation harness that proves the scores agree with human reviewers. It does
**not** touch the production back-translation scripts in `levante_translations`
or `levante-web-dashboard` — those keep running as-is.

## Why these methods

| Signal | Module | What it catches | Cost |
| --- | --- | --- | --- |
| Multilingual-E5 direct cosine | `embedding_eval.py` | catastrophic failures (untranslated / unrelated / empty) | ~ms |
| Multilingual-E5 same-item centroid | `embedding_eval.py` | one language rendering an item oddly vs all the others | ~ms |
| COMET-QE (`wmt22-cometkiwi-da`) | `comet_eval.py` | nuanced semantic quality, source->target directly (no back-translation) | CPU/GPU |
| Gemini MQM judge | `llm_mqm_eval.py` | structured error diagnostics (category + severity) | API $ |

Back-translation is intentionally **not** reimplemented here: it grades the
back-translator, not your translation. COMET-QE and the MQM judge both read the
source and target directly.

## One-time setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r scripts/eval/requirements.txt

# COMET-QE uses a GATED, non-commercial model. Once per machine:
#   1. Accept the license: https://huggingface.co/Unbabel/wmt22-cometkiwi-da
#   2. Log in:
huggingface-cli login        # or: export HUGGING_FACE_HUB_TOKEN=hf_xxx
```

Credentials are read from `levante-qa/.env` automatically (no need to export):

- `GEMINI_API_KEY` — Gemini MQM judge (already present in `.env`).
- `CROWDIN_API_TOKEN` — read approved translations directly from Crowdin.
- `LEVANTE_TRANSLATIONS_PROJECT_ID` — optional, defaults to `756721`.

## Reading approved translations from Crowdin

Mirrors `levante-web-dashboard` (`export-crowdin-xliff-merged.js` /
`api/crowdin-approved-translations.js`): an approved-only build is created,
polled, downloaded, and the XLIFF/CSV parsed into the merged
`identifier,item_id,...,en,<locale>` table. The `item_id`s match the dashboard
export and the human-review seed, so everything joins cleanly.

```bash
cd scripts/eval
# Dump approved translations to a CSV:
python crowdin_source.py --output output/crowdin-approved.csv
# ...or score them in one step (no intermediate file):
python evaluate_translations.py --from-crowdin --target-col es-AR --all \
  --output-csv output/eval-es-AR.csv
```

## Scoring a translation set

Input CSV needs an id column, an English source column, a target column, and
(optionally) extra locale columns used for the centroid signal.

```bash
cd scripts/eval
python evaluate_translations.py \
  --input-csv ../../../levante-web-dashboard/data/validation/crowdin-xliff-dashboard.csv \
  --target-col es-AR \
  --auto-centroid \
  --all \
  --output-csv output/eval-es-AR.csv
```

Run a single signal with `--run-embedding`, `--run-comet`, or `--run-llm`. The
LLM pass is cached per item under `output/llm_cache/`, so re-running resumes for
free and never re-spends budget; failed items are left blank (never scored 0) and
retried on the next run.

## Validating the evaluators against humans

This answers "are these scores actually good?" by comparing every method —
including the legacy `ai_score`/`composite_score` already in the data — against
the human verdicts in the review seed (`notes` column).

```bash
cd scripts/eval
# centroid languages pulled straight from Crowdin:
python validate_evaluators.py --all --from-crowdin
# ...or from a local multi-locale CSV:
python validate_evaluators.py --all \
  --translations-csv ../../../levante-web-dashboard/data/validation/crowdin-xliff-dashboard.csv
```

Output is a table of Spearman/Kendall correlation with the human ordinal, ROC-AUC
for flagging the "Poor" items, and precision/recall@k, written to
`output/validation-report.json`. With no flags it still validates the legacy
baselines (no models or network needed), which is handy as a smoke test.

> On the legacy es-AR seed the back-translation score "wins" — but that seed is
> biased (it built the seed) and its single "Poor" label mixes adequacy with
> child-appropriateness. On an **independent** two-axis set (180 Prolific
> crowdsourced ratings, via `dashboard_labels.py`) the new methods are strong:
> adequacy AUC 0.89 (MQM) / 0.85 (E5) / 0.82 (COMET); appropriateness AUC 0.73
> (MQM, the only signal that reads it); overall MQM Spearman 0.58 / AUC 0.80. So
> the earlier pessimism was a measurement artifact. Build a larger unbiased
> two-axis set (below) to confirm and to set production thresholds.

## Building an unbiased v2 label set

`VALIDATION_SET_PLAN.md` is the full spec. `build_validation_pool.py` produces a
blind pool: ~70% stratified-uniform-random (an unbiased base rate, anchored to no
method) plus ~30% enrichment chosen by **evaluator disagreement** (spread of
z-scored E5-direct, E5-centroid, and optional COMET), so hard cases come from
method conflict rather than any single score's tail.

```bash
cd scripts/eval
python build_validation_pool.py --from-crowdin \
  --locales es-AR,es-CO,de,nl,fr-CA --backbone 560 --enrich 240 --enrich-with-comet
```

Outputs to `output/validation-pool-v2/`: `blind/<locale>.csv` + `blind/combined.csv`
(annotator files — inputs plus empty `adequacy`, `appropriateness`, `mqm_errors`,
`overall_verdict`, `rater_id`, `notes`; strata shuffled so annotators stay blind)
and a separate `provenance.csv` (stratum + raw signals, kept out of the annotator
file). Annotators score **two axes**: `adequacy` (meaning, 0-3) and
`appropriateness` (register/vocab for the age group, 0-3).

## Validating against the v2 two-axis labels

Once the blind CSV is annotated, point the same harness at it. The v2 schema is
auto-detected (by the `adequacy` column), and each method is scored against
`adequacy`, `appropriateness`, and the combined `overall` gate. A `*` marks the
axis each method is meant to measure (COMET/E5 -> adequacy, MQM -> appropriateness).

```bash
cd scripts/eval
python validate_evaluators.py --labels-csv output/validation-pool-v2/blind/combined.csv \
  --all --from-crowdin        # --from-crowdin enables the per-locale centroid signal
```

The v2 file is multi-locale, so locale is read per row (no `--target-locale`
needed). Unlabeled rows are skipped, so you can validate a partially-annotated
file as labels trickle in.

## Ground truth & calibration

The trustworthy labels are the **Prolific crowdsourced ratings** (purpose-built,
two-axis, external). `dashboard_labels.py --source prolific` is the reproducible
calibration seed; treat it as the source of truth until a larger v2 set exists.
The dashboard `needsReview` flag is **not** usable as truth (heterogeneous flag +
version-decoupled text — every signal, legacy included, scores at chance on it).

To extend across locales, run the same Prolific-style two-axis rating on the
`build_validation_pool.py` output for ~3-5 locales (using `ANNOTATOR_GUIDE.md`),
then re-run `calibrate_thresholds.py` per locale to get per-locale thresholds.

## Production: calibrate, then run the review queue

```bash
cd scripts/eval
# 1. Calibrate flag thresholds from the Prolific labels (writes output/scoring-config.json):
python dashboard_labels.py --source prolific
python calibrate_thresholds.py --labels-csv output/prolific-v2-es-AR.csv --target-recall 0.80

# 2. Rank approved translations worst-first (Tier 1 = E5+COMET on all, Tier 2 = MQM
#    only on the flagged tail, capped by --max-mqm). Words come live from Crowdin by
#    default; pass --input-csv output/crowdin-approved.csv to score a saved snapshot:
python review_queue.py --locales es-AR --max-mqm 300
#    ...or a free adequacy-only pass:
python review_queue.py --locales es-AR --tier1-only
```

`output/review-queue.csv` is sorted worst-first with a `tier`
(`likely_bad` = both axes flagged, `review` = one, `ok` = neither), the raw
signals, and `reasons`. On es-AR this surfaces real errors at the top (e.g.
`the sorbet -> el helado`, `Shape Rotation -> Rotación Mental`,
`Foster Parent -> Tutor/a legal`). Thresholds are calibrated on es-AR only for
now — recalibrate per locale (above) before trusting other locales' absolute flags.

**Vocab rows are scored by the vision check, not COMET/E5.** For any item that maps
to a `vocab-item-NNN` answer image, the queue replaces the adequacy verdict with the
word-vs-image vision call (`vision_match` column; `reasons=vision_word_image_mismatch`
when it fails). This is what clears the COMET/E5 vocab false positives — on es-AR,
170 vocab rows collapse from 136 text-flags to 4 vision flags. Disable with
`--no-vocab-vision` to fall back to COMET/E5.

**TROG rows are likewise scored by a sentence-vs-pictures vision check**, not COMET/E5.
For any `sentence-understanding` item that maps to a TROG item-bank row, the queue
replaces the adequacy verdict with the 4-picture forced-choice check (`vision_match`;
`reasons=vision_sentence_picture_mismatch` when it fails). Disable with
`--no-trog-vision`. See the TROG section below for how it stays high-precision.

## Vocab: word-vs-image vision check

Picture-vocabulary items are single words backed by an answer image, and COMET/E5
are unreliable on single words — on es-AR they flagged 136/171 vocab items, mostly
false positives (correct one-word translations score low). The right signal is
whether the translated word names the pictured object. `vocab_vision_eval.py` sends
Gemini each answer image + the translated word and asks exactly that. Both the
English source word and the per-locale word come from the Crowdin corpus (`en` /
locale columns); the **answer image is matched to that English word** by normalizing
names (case/spaces/`_`/`-` ignored).

**Distractor-aware (the real 4-AFC task).** A vocab item shows four pictures; the
child hears one word and taps the one it names. So a broader/category word is fine as
long as it still uniquely points to the keyed picture. The VLM is given the item's
three distractor options (the corpus `response_alternatives`) and told to accept a
category word (e.g. `percussion` for a hi-hat) **unless** it also fits a distractor —
it answers "no" only for a wrong object, a mistranslation, or genuine ambiguity. This
removed the category-vs-instance false positives while keeping true errors.

### Two independent data sources

The check compares a **word** against a **picture**, and each side has its own source
(pick them independently):

| Side | Default | Flag(s) to change it | Other locations |
| --- | --- | --- | --- |
| **Words** (translations) | **Live Crowdin** approved translations | `--translations-csv <file>` to use a saved export instead | `output/crowdin-approved.csv` (snapshot from `crowdin_source.py`) |
| **Images** (answer pictures) | **Deployed `-dev` GCS bucket** `gs://levante-assets-dev/visual/vocab/` | `--gcs-bucket levante-assets-prod` (prod) · `--image-source local` (repo assets) | local: `core-task-assets/vocab/{original,images}` |

- **Words — live by default.** Running with no `--translations-csv` pulls approved
  translations straight from Crowdin at run time (needs `CROWDIN_API_TOKEN` in `.env`),
  so you always score the current approved words. Pass `--from-crowdin` to be explicit,
  or `--translations-csv output/crowdin-approved.csv` to score a frozen snapshot
  (faster, offline, reproducible). Both the English keyword and the per-locale word
  come from the same source row (`en` / locale columns).
- **Images — deployed `-dev` bucket by default**, downloaded + cached under
  `output/gcs_vocab_cache/`, so it validates exactly what children see. Switch to
  `--gcs-bucket levante-assets-prod` for prod, or `--image-source local` to read the
  repo's `core-task-assets/vocab/{original,images}`. (The old `filenames.csv` map was
  deleted as stale; one item, `vocab-item-171` "colander", has no matching image — the
  bucket only has the synonym `strainer.*` — and is skipped until that asset is renamed.)

It runs for any locale(s):

**Difficulty-aware:** some items are *meant* to be hard/abstract (`mammalogy`, `triad`,
`sedentary`), so the corpus's IRT difficulty `d` (`vocab-item-bank.csv`) is joined in
(`difficulty`/`hard` columns; shown as `d=` in the report). For items with
`d >= --hard-difficulty` (default `1.0`) the VLM is told **not** to answer "no" just
because the word is advanced/abstract or unlikely to be known by a young child — it
flags those only for a *genuine* word↔image error. This cleared ~19/22 hard es-AR
items (e.g. `triad`, `posterior`, `sedentary`) while keeping true errors like `claw`
(the picture is pliers).

```bash
cd scripts/eval
# Default: live Crowdin words + deployed -dev images. One or many locales
# (the image is shared; only the word changes per locale).
python vocab_vision_eval.py --locales es-AR,de,nl,es-CO,fr-CA,pt-PT,en-GB

# Score a saved snapshot instead of pulling live (offline / reproducible):
python vocab_vision_eval.py --translations-csv output/crowdin-approved.csv --locales de,nl

# Validate prod images instead of -dev:
python vocab_vision_eval.py --gcs-bucket levante-assets-prod --locales es-AR
```

Writes `output/vocab-vision-<locale>.csv` per locale, `vocab-vision-all.csv`, a
human-readable `vocab-vision-report.md`, and a styled `vocab-vision-report.pdf`
(rendered from the Markdown via `pandoc` + headless Chrome; pass `--no-pdf` to skip,
e.g. on a machine without them). Each item block embeds the **answer image** next to
the English keyword (inlined into the PDF via `pandoc --embed-resources`), so a reviewer
sees the picture, the source word, and each locale's translation together — e.g. the
`claw` picture is plainly a pair of pliers. Responses cache under
`output/vocab_vision_cache/`. On es-AR it collapsed 136 COMET/E5 text-flags to 4 real
mismatches (e.g. `claw -> la garra` over a pliers image). Across **all nine locales
with vocab coverage** (es-AR, de, nl, es-CO, fr-CA, pt-PT, eo, en-GB; pt-BR has no
vocab translations) a 1357-check sweep surfaced **50** mismatches over **24** items
(Esperanto alone accounts for 15 — several are outright wrong words).

Each mismatch is auto-tagged (the `tag` column / report sections) by its cross-locale
spread, which separates two very different fixes:
- **`source_image_issue`** — the *English* keyword / shared picture is the problem, so
  it mismatches across locales (e.g. `claw` over a pliers image, 7/8 locales;
  `mammalogy` is too abstract to name an object, 6/8). **Fix the item, not the
  translation.** A row counts as source-wide when it fails in at least
  `--source-frac` of the locales it was checked in (default `0.6`); pass an absolute
  count via `--source-min-locales` to override.
- **`translation_issue`** — locale-specific: the picture is fine but that language's
  word is wrong/too narrow (e.g. `scoop -> la cuillère` fr-CA, `cloak -> la capucha`
  es-CO, `suede -> der Velours` de). **Fix the per-locale word.**

This is the vocab track — it judges by the real task criterion (would a child pick
this picture hearing the word), so it is high-precision. `review_queue.py` uses it
automatically for vocab rows (below).

## TROG: sentence-vs-pictures vision check

TROG (`sentence-understanding`) is a 4-alternative forced-choice grammar task: the
child hears one sentence and taps the one picture (of four) that matches its meaning.
The four pictures are deliberately **minimal pairs** on the grammatical contrast under
test (who-does-what-to-whom, in/on/above/below, one/many, negation, active/passive),
so generic text metrics are useless and the real criterion is simple: hearing the
translated sentence, would a child still pick the keyed picture? `trog_vision_eval.py`
runs exactly that with a vision model — it shows Gemini the four shuffled choice images
and the sentence and has it pick one. Items + the keyed answer + the distractor image
keys + the grammatical `trial_type` all come from the TROG item bank (`answer` /
`response_alternatives` columns; image key `45-horse-chase-girl` → `visual/trog/45-horse-chase-girl.webp`).

**Two safeguards keep it high-precision** (the raw 4-AFC alone has poor precision,
because the model often *understands* a correct translation but mis-grounds it to the
wrong tile among the lookalike pictures):

1. **English control.** Every item is run for the English sentence first. If the model
   can't pick the keyed picture even in English, the item/picture set is the problem
   (not the translation) — it's tagged `item_or_model` and never blamed on a locale.
2. **Confirmation gate.** A locale miss is only a `translation_issue` if a second,
   single-image call — shown *only* the keyed picture — agrees the translated sentence
   does **not** truthfully describe it. This filters out the mis-grounding glitches
   (where the model's own reason describes the correct meaning yet it tapped a
   distractor). On es-AR + de this took the flag set from 10 noisy hits down to 1.
3. **Cross-locale guard.** A lone locale miss is demoted to `likely_noise` (listed in the
   report for review but not counted as a translation issue) when the English control
   **and** a strict majority of the *other* locales solved the same keyed picture — a real
   translation error wouldn't be contradicted by that many correct siblings, so the single
   miss is almost certainly per-run grounding noise the gate happened to repeat. Across the
   7 production locales this demoted all 3 remaining flags (e.g. `the fork is longer than
   the pencil` → de, which 6/6 other locales + English solved correctly).

So a sentence is flagged only when the English control passes, the gate confirms the
translation doesn't match the keyed picture, **and** the cross-locale guard doesn't find a
majority of siblings solving it. All three inputs are live by default, so nothing goes
stale:
- **Sentences** (translations): live Crowdin (`--translations-csv` for a saved snapshot).
- **Images**: deployed `-dev` bucket `gs://levante-assets-dev/visual/trog/`
  (`--gcs-bucket levante-assets-prod` for prod, `--image-source local` for repo assets).
- **Item bank** (keyed answer + distractors + `trial_type` + `d`): the deployed corpus
  `gs://<gcs-bucket>/corpus/trog/trog-item-bank.csv` — exactly what the task-launcher
  pulls at runtime (`core-tasks` `getCorpus.ts`). Override with `--corpus-csv <path|url>`.

Responses cache under `output/trog_vision_cache/`.

```bash
cd scripts/eval
# Default: live Crowdin sentences + deployed -dev images.
python trog_vision_eval.py --locales es-AR,de

# Score a saved snapshot instead of pulling live:
python trog_vision_eval.py --translations-csv output/crowdin-approved.csv --locales es-AR,de
```

Writes `output/trog-vision-<locale>.csv` per locale, `trog-vision-all.csv`, a
`trog-vision-report.md` (translation issues first, then the language-independent
English-control failures), and a styled `trog-vision-report.pdf` (`--no-pdf` to skip).
Each flagged item shows the **keyed picture** (what the sentence should match) plus the
**picked picture** per locale, embedded in the PDF — e.g. for the lone `de` flag the
keyed fork/pencil image plainly shows the fork longer, confirming the gate misread it
rather than a translation error.
`review_queue.py` uses this automatically for `sentence-understanding` rows. (Note:
image blocks 33–36 have assets + Crowdin strings but no item-bank rows, so those four
are not in the administered 99 and fall back to text metrics.)

## Files

- `evaluate_translations.py` — orchestrator (scores a CSV or `--from-crowdin`)
- `vocab_vision_eval.py` — vocab word-vs-answer-image check (Gemini vision)
- `trog_vision_eval.py` — TROG sentence-vs-pictures 4-AFC check + confirmation gate + cross-locale guard (Gemini vision)
- `validate_evaluators.py` — validation harness (seed schema + v2 two-axis, auto-detected)
- `dashboard_labels.py` — adapt dashboard human-review logs (Prolific / shared) to v2 labels
- `calibrate_thresholds.py` — pick per-axis flag thresholds from the Prolific ROC
- `review_queue.py` — tiered advisory review queue over approved translations
- `build_validation_pool.py` — blind, unbiased v2 label pool builder
- `ensemble_eval.py` — legacy + COMET + MQM-major-count blend, leave-one-out CV
- `crowdin_source.py` — fetch approved translations from Crowdin (stdlib only)
- `embedding_eval.py` / `comet_eval.py` / `llm_mqm_eval.py` — the three signals
- `stats.py` — Spearman / Kendall / ROC-AUC / P@k (numpy only)
- `cache.py` — resume-safe disk cache for the LLM pass
- `envload.py` — loads `levante-qa/.env`
- `VALIDATION_SET_PLAN.md` / `ANNOTATOR_GUIDE.md` — v2 sampling spec + annotator rubric
