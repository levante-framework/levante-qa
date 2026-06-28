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

## Files

- `evaluate_translations.py` — orchestrator (scores a CSV or `--from-crowdin`)
- `validate_evaluators.py` — validation harness (scores the scorers vs humans)
- `crowdin_source.py` — fetch approved translations from Crowdin (stdlib only)
- `embedding_eval.py` / `comet_eval.py` / `llm_mqm_eval.py` — the three signals
- `stats.py` — Spearman / Kendall / ROC-AUC / P@k (numpy only)
- `cache.py` — resume-safe disk cache for the LLM pass
- `envload.py` — loads `levante-qa/.env`
