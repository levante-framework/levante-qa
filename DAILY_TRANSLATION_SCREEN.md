# Daily translation screen

Screens **newly appeared** approved itembank strings each day, skips placeholders
and Esperanto, and DMs findings to Slack (not `#levante-crowdin`).

- Script: `scripts/daily-translation-screen.mjs`
- Run: `pnpm run translation-screen`
- GitHub Action: `.github/workflows/translation-screen-daily.yml` (14:00 UTC)
- Output: `results/translation-screen/<YYYY-MM-DD>.{json,md}` + `latest.json`

## What it does

1. Lists `translations/itembank/<task>/<locale>/item-bank-translations.json`
   from the draft bucket (override with `QA_ITEMBANK_BASE_URL` / prod).
2. Drops:
   - `en-US` (source)
   - any `eo-*` locale (Esperanto)
   - packs whose every value is `NO APPROVED TRANSLATION` (or empty)
3. Diffs approved **keys** against `inventory-baseline.json` (updated after every
   successful run, including `--dry-run`). No new keys → one-line quiet exit,
   no Slack. Edits to existing keys do **not** trigger a re-screen.
4. For each pack with new keys:
   - **vocab / trog / theory-of-mind / same-different-selection** → vision eval
     (English control vs locale; flags `translation_issue`)
   - **everything else** → Gemini MQM on that task path (`mqm_score ≤ 90`)
   - Findings are filtered to the new keys only
   - MQM audience is **adult** for `data-questionnaire*`, caregiver, and teacher
     survey strings; **child** (ages 3–8) for everything else
5. Prints only the delta report; Slack DMs **only when there are findings**.
   Use `--force` to re-screen everything regardless of keys.

## Diagnosing item translation issues

The screen is a **new-string detector + triage assistant**, not a full psychometric
validation. It answers: “Did newly approved keys look wrong relative to English /
the item images?”

### What a finding means

| Finding kind | Tasks | Meaning |
| --- | --- | --- |
| `vision` (`translation_issue`) | vocab, trog, theory-of-mind, same-different-selection | English control answered correctly from the image; the locale string did not. Strong signal the **translation** (or keying) is wrong for that item. |
| `item_or_model` (not Slacked) | same vision tasks | English also fails. Treat as ambiguous item art / model limit — **do not** blame the translator. |
| `mqm` (`mqm_score ≤ 90`) | all other itembank tasks | Gemini MQM judge flagged accuracy/fluency/style problems in the text pack (no image check). |
| `error` | any | Eval script crashed; fix tooling before interpreting content. |

Vision evals always run an **en-US control** first. That control is what turns a
vague “the model got it wrong” into a diagnosable **translation** issue.

### How to triage a Slack alert

1. Open the posted item id + English vs locale strings.
2. For vision findings: pull the item image from prod assets and ask whether the
   locale string still names / describes the keyed target. Common fixes:
   wrong sense of a word, gender/number mismatch that changes meaning, missing
   negation, swapped response options, or a Crowdin key bound to the wrong
   source string.
3. For MQM findings: read the short `mqm_assessment`; re-check critical/major
   accuracy errors first (meaning change), then fluency.
4. Confirm the pack was meant to be live (draft bucket by default). Placeholders
   and Esperanto are skipped on purpose — silence there is **not** a clean bill
   of health; it means “not screened.”
5. Re-run locally after a Crowdin fix:
   `pnpm run translation-screen -- --tasks=<task> --locales=<locale> --force --no-slack`

### What it catches well

- Newly approved keys that break picture–word / picture–sentence match
- Obvious mistranslations and awkward calques on non-vision tasks (MQM)
- Accidental promotion of empty / placeholder-only packs (they never enter the
  eval set; if you expected coverage, their absence from inventory is the clue)

### What it does not prove

- That an **edited** existing string is still correct (edits are ignored unless
  `--force`)
- Age-appropriate difficulty or human child performance (use child-twins / VLM
  panel + human norms for that)
- That an item is psychometrically sound — only that the **locale string** is
  consistent with English for a VLM, or that MQM text quality is above threshold
- Completeness of every key vs en-US (hashing is over approved values present in
  the locale file; missing keys need a separate coverage check)

### Reading artifacts

| File | Use |
| --- | --- |
| `results/translation-screen/<date>.md` | Human-readable delta + findings |
| `results/translation-screen/<date>.json` / `latest.json` | Machine-readable triage |
| `results/eval/*-vision-<locale>.csv` | Per-item tags, reasons, EN vs translation |
| `results/eval/screen-mqm-<task>-<locale>.csv` | MQM scores and assessments |
| `results/translation-screen/inventory-baseline.json` | Yesterday’s keys/hashes (why today’s run was quiet) |

On GitHub Actions, that directory is uploaded as the `translation-screen-<run_id>`
artifact on every run. Download from the run’s **Artifacts** panel, or:

```bash
gh run download <run_id> -D /tmp/translation-screen
# then open …/translation-screen-<run_id>/<date>.json (filter findings by locale)
```

MQM rows with a blank score (judge failure) are skipped — they are not treated
as `mqm=0` findings.

## Local usage

```bash
# Needs GEMINI_API_KEY in .env for any actual screening.
pnpm run translation-screen -- --dry-run          # inventory + diff only
pnpm run translation-screen -- --no-slack         # screen, disk only
pnpm run translation-screen -- --locales=de-DE,en-GB
pnpm run translation-screen -- --tasks=vocab,trog --force
```

## Slack

Alerts go as a **DM** via bot token (not `#levante-crowdin`):

```bash
# .env
SLACK_BOT_TOKEN=xoxb-...
SLACK_ALERT_CHANNEL=W018924DJJV   # david_cardinal (default); override to change recipient
# SLACK_WEBHOOK_URL=...           # optional fallback only (channel fixed by webhook)
```

## GitHub Actions secrets

| Secret | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Vision + MQM judges |
| `SLACK_BOT_TOKEN` | DM findings via `chat.postMessage` |

The workflow caches `results/translation-screen/` so the next day can diff
against yesterday’s keys.
