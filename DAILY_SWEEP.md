# Daily `-dev` oracle sweep

A nightly health check for LEVANTE core tasks on `hs-levante-admin-dev`. It runs
**every task in every language it supports**, snapshots the pass/fail matrix,
diffs it against the previous day, and posts the current results to Slack
(flagging new regressions). This doc is the operator's guide for running and
maintaining the sweep, including bringing it up on a fresh machine.

- Script: `scripts/daily-oracle-sweep.mjs`
- Run it: `npm run sweep`
- Output: `results/daily/<YYYY-MM-DD>.json` (machine) + `<YYYY-MM-DD>.md` (human)

---

## 1. What it does

The sweep is a thin orchestrator on top of the **local QA dashboard**
(`dashboard/server.mjs`). It does not contain any task logic of its own — it
drives the same HTTP API the dashboard UI uses:

| Call | Purpose |
| --- | --- |
| `GET /api/tasks` | The task × language support matrix (Levante tasks from `languageoptions.json` + ROAR `en/de/es` mapping, already computed by the dashboard). Returns `{ tasks, languages, taskSupport }`. |
| `POST /api/run` | Launch one `(task, language)` oracle run. Body: `{ taskId, agent, language, ageYears, ageMonths }`. Returns `{ runId }`. |
| `GET /api/status?runId=…` | Poll until terminal (`passed` \| `failed` \| `error` \| `cancelled`). |
| `DELETE /api/run/:id` | Cancel a run that exceeds the per-run timeout. |

Flow (`main()` in the script):

1. `ensureDashboard()` — reuse the dashboard if it's already up; otherwise spawn
   `node dashboard/server.mjs` detached and wait up to 60s (unless
   `SWEEP_AUTOSTART=0`).
2. `buildMatrix()` — expand `taskSupport` into `(taskId, language)` cells,
   skipping `testing` locales (`ar-IL`, `he-IL`) unless `--include-testing`.
3. `runPool()` — run cells through a fixed-size concurrency pool (default 6),
   launching each via `POST /api/run` and polling `GET /api/status`.
4. `classify()` — compare each cell to yesterday's snapshot:
   - `NEW_FAIL` — failing now, was passing (or no baseline) → **alarms** 🔴
   - `NEW_PASS` — passing now, was failing → recovered 🟢
   - `STILL_FAIL` — failing now and before ⚪
   - `STILL_PASS` — passing now and before
5. Write `results/daily/<date>.json` + `.md`, then `postSlack()` the summary
   **every day** (green or not).

A cell is **failed** if the dashboard reports a non-zero Cypress exit code or any
non-empty diagnostic log (`*_no_key`, `*_key_mismatch`, `*_unsolved`,
`*_audio_content`, `*_audio_overlap`, `*_match_stuck`) — including the
audio-language cross-check (`QA_EXPECTED_AUDIO_LANG`, set automatically to the
run's language) and the speech-on-speech overlap guard (two narration clips
playing at once).

---

## 2. Bring it up on a new machine

### 2.1 Repos (must be siblings)

The dashboard's per-run provisioner lives in the **sibling** `levante-support`
repo, so clone both side by side:

```
<parent>/
  levante-qa/         # this repo
  levante-support/    # provisioner + QA-site bootstrap
```

```bash
git clone <levante-qa>      levante-qa
git clone <levante-support> levante-support
cd levante-qa
npm install
```

If `levante-support` lives elsewhere, point the dashboard at it with
`LEVANTE_SUPPORT_DIR=/abs/path/to/levante-support`.

### 2.2 Credentials

| What | Why | How |
| --- | --- | --- |
| **`-dev` Firebase admin credential** | The provisioner (`provision-participant.mjs`) creates test participants on `hs-levante-admin-dev`. | Set `LEVANTE_ADMIN_FIREBASE_CREDENTIALS` in `levante-support/.env` (same one `setup-qa-site.mjs` uses). |
| **Google Application Default Credentials** | Durable run-history mirror to `gs://levante-tools/levante-qa/`. | `gcloud auth application-default login`, or set `GCP_SERVICE_ACCOUNT_JSON` / `GOOGLE_APPLICATION_CREDENTIALS`. Optional — set `QA_GCS_DISABLE=1` for local-only history. |
| **VLM API key** (`GEMINI_API_KEY` etc.) | Only if you run the sweep with `SWEEP_AGENT=vlm` or `child`. The default `oracle` agent needs **no** model key. | `levante-qa/.env`. |
| **Slack webhook or bot token** | To post the daily summary. Optional — without it the report is just written to disk. | `levante-qa/.env` (see §4). |
| **Participant creds** | Default QA participant for `LAUNCH=dashboard`. | Already in `levante-qa/.env` (`PARTICIPANT_USER` / `PARTICIPANT_PASS`). |

The provisioner is **dev-only by design** — it refuses to run against anything
other than `hs-levante-admin-dev`.

### 2.3 Smoke test

```bash
npm run sweep -- --dry-run                 # prints the matrix, launches nothing
npm run sweep -- --languages=de-DE --tasks=hearts_and_flowers --no-slack
```

The second command runs a single cell end-to-end and writes
`results/daily/<date>.json` without touching Slack.

---

## 3. Running

```bash
npm run sweep                              # full matrix, posts to Slack
npm run sweep -- --no-slack                # full matrix, disk only
npm run sweep -- --dry-run                 # list cells, don't launch
npm run sweep -- --include-testing         # also run ar-IL / he-IL (never alarm)
npm run sweep -- --languages=de-DE,en-US   # subset of languages
npm run sweep -- --tasks=pa,sre            # subset of tasks (catalog ids)
npm run sweep -- --concurrency=4
```

`--tasks` and `--languages` take catalog ids / locale codes as returned by
`GET /api/tasks` (e.g. `hearts_and_flowers`, `same_different`, `de-DE`).

### Config (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `QA_DASHBOARD_URL` | `http://localhost:4180` | Dashboard base URL. |
| `QA_DASHBOARD_PORT` | `4180` | Port (used if URL unset). |
| `SWEEP_CONCURRENCY` | `6` | Max parallel runs. |
| `SWEEP_AGENT` | `oracle` | Agent to run (`oracle` \| `vlm` \| `child` \| `wrong`). |
| `SWEEP_RUN_TIMEOUT_MS` | `1800000` (30m) | Per-run timeout; on hit the run is cancelled and recorded as `timeout`. |
| `SWEEP_POLL_MS` | `5000` | Status poll interval. |
| `SWEEP_INCLUDE_TESTING` | off | Include `ar-IL` / `he-IL` (these never alarm). |
| `SWEEP_AGE_YEARS` / `_MONTHS` | `8` / `0` | Provisioned participant age. |
| `SWEEP_AUTOSTART` | on | Start the dashboard if it's down. Set `0` to require it already running. |

---

## 4. Slack

Set **one** of these in `levante-qa/.env` to enable posting (preferred first):

```bash
# Incoming webhook bound to the target channel:
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
# Or a bot token (xoxb-…); the app must be a member of the channel:
SLACK_BOT_TOKEN=xoxb-...
SLACK_ALERT_CHANNEL=levante-engineering   # bot-token path only
```

The daily message header reflects current state:

- 🟢 `all N passing`
- 🚨 `P/N passing · K new failures` (regressions vs. yesterday)
- ⚠️ `P/N passing · K failing (no new)` (pre-existing failures only)

Followed by per-language tallies and, when present, sections for new failures,
recovered cells, and still-failing cells (each with the first error line).

---

## 5. Output & snapshots

- `results/daily/<date>.json` — full classified matrix (the next day's baseline).
  Each cell: `{ key, taskId, label, language, status, pass, errors,
  failureSummary, accuracy, nTrials, durationMs, state, prevPass, hadBaseline }`.
- `results/daily/<date>.md` — the human report (same content as the console dump).

The diff baseline is **the most recent prior `<date>.json`** in `results/daily/`.
First run on a machine has no baseline, so everything failing is reported as a
`NEW_FAIL` (expected once). Snapshots are also mirrored across machines via the
GCS run-history bucket the dashboard uses for `results/runs.json`.

---

## 6. Cron

Run from the repo root with a login shell so `.env`, `node`, and `gcloud` ADC
resolve. Example — 06:00 local, log to a dated file:

```cron
0 6 * * *  cd /abs/path/to/levante-qa && /usr/bin/env bash -lc 'npm run sweep' >> /abs/path/to/levante-qa/results/daily/cron.log 2>&1
```

Notes:
- The sweep autostarts the dashboard, so no separate service is required — but a
  long-lived `npm run dashboard` is fine too (the sweep reuses it).
- Give the job enough headroom: full matrix × 30-min per-run timeout ÷
  concurrency. At concurrency 6 a full green sweep is typically well under an hour.
- ADC tokens expire; for an unattended box prefer a service-account key
  (`GOOGLE_APPLICATION_CREDENTIALS`) over `gcloud auth ... login`.

---

## 7. Interpreting results & known `-dev` flakiness

`hs-levante-admin-dev` is a live, frequently-redeployed environment, so a single
`NEW_FAIL` is **not** automatically a code regression. Before filing a bug:

1. **Re-run the cell** (`--tasks=… --languages=… --no-slack`). Transient `-dev`
   states (mid-deploy, a briefly-flipped task variant) clear on their own and the
   re-run passes.
2. Check the run's first error line in the `.md` report. Common real signals:
   - `Audio language mismatch … expected "<lang>"` — the task played a narration
     clip whose embedded `lang_code` ≠ the run's language (e.g. an en-US fallback
     served for a missing localized clip). This is **playback-based** (only fires
     for clips that actually play, never preloaded-but-unplayed assets).
   - `*_audio_overlap` — two narration clips played at the same time
     (speech-on-speech), which is confusing to a child.
   - `*_key_mismatch` / `*_unsolved` — the oracle's answer disagreed with the
     task's answer key.
3. A `NEW_PASS` the next day after a one-off `NEW_FAIL`, with the **same task
   variant**, confirms the failure was a transient `-dev` artifact rather than a
   QA-code or content bug.

Example (2026-06-03): de-DE Hearts & Flowers failed once with
`Audio language mismatch … en-US/hearts-and-flowers-instruct-keyboard.mp3`, then
passed again on re-run with the identical `de` variant — a transient `-dev`
deploy window, not a QA bug.

---

## 8. Key files

| Path | Role |
| --- | --- |
| `scripts/daily-oracle-sweep.mjs` | The sweep orchestrator (matrix, pool, diff, Slack). Exports `classify` / `buildReport` / `slackMessage` for unit testing; only sweeps when run directly. |
| `dashboard/server.mjs` | Run orchestration backend the sweep drives. |
| `dashboard/catalog.mjs` | Task → spec map; `LANGUAGES`. |
| `../levante-support/scripts/e2e-init/provision-participant.mjs` | Per-run participant provisioner (sibling repo). |
| `results/daily/<date>.json` / `.md` | Snapshots + reports. |
| `.env` | Slack creds, dashboard URL/port, sweep tuning, GCS, VLM keys. |
