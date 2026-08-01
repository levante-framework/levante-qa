# Daily translation screen

Screens **new or changed** itembank translations each day, skips placeholders and
Esperanto, and posts findings to Slack `#levante-crowdin`.

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
3. Hashes the remaining approved strings and diffs against
   `inventory-baseline.json` (updated after every successful run, including
   `--dry-run`). Unchanged inventory → one-line quiet exit, no Slack.
4. For each new/changed pack:
   - **vocab / trog / theory-of-mind / same-different-selection** → vision eval
     (English control vs locale; flags `translation_issue`)
   - **everything else** → Gemini MQM on that task path (`mqm_score ≤ 90`)
5. Prints only the delta report; Slack posts **only when there are findings**.
   Use `--force` to re-screen everything regardless of hashes.

## Local usage

```bash
# Needs GEMINI_API_KEY in .env for any actual screening.
pnpm run translation-screen -- --dry-run          # inventory + diff only
pnpm run translation-screen -- --no-slack         # screen, disk only
pnpm run translation-screen -- --locales=de-DE,en-GB
pnpm run translation-screen -- --tasks=vocab,trog --force
```

## Slack

Same credentials as the oracle sweep. Prefer a webhook bound to
`#levante-crowdin`, or a bot token:

```bash
# .env
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...   # optional; channel fixed by webhook
SLACK_BOT_TOKEN=xoxb-...
SLACK_ALERT_CHANNEL=levante-crowdin                      # bot-token path (default)
```

## GitHub Actions secrets

| Secret | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Vision + MQM judges |
| `SLACK_BOT_TOKEN` | Post to `#levante-crowdin` |
| `SLACK_TRANSLATION_WEBHOOK_URL` | Optional webhook override |

The workflow caches `results/translation-screen/` so the next day can diff
against yesterday’s hashes.
