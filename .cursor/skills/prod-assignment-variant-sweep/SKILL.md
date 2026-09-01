---
name: prod-assignment-variant-sweep
description: >-
  Inventories leftover (unregistered) task packs on open field-site -prod
  assignments and optionally replays them with the oracle on -dev or on -prod
  qa-tests. Use when sites have leftover packs, kids hit unregistered variants,
  or the user asks to sweep open production assignments, stale variants, or
  prod-variant-sweep.
---

# Prod open-assignment variant sweep

Sites pin a pack id (`variantId`) on each assignment. Unregistering the pack
does **not** update those open assignments. Kids keep getting the leftover
(wrong language tag, missing audio folder, splash that never continues). The
nightly `-dev` sweep only plays **registered** packs, so it misses this.

## What to run

```bash
# Read-only: leftover packs on open field-site assignments
pnpm run prod-variant-sweep -- --dry-run
pnpm run prod-variant-sweep -- --no-slack

# Replay leftovers on -dev (writes qa-tests kids on -dev only)
pnpm run prod-variant-sweep -- --run-oracle

# Replay leftovers on -prod: write qa-tests kids only, play platform.levante-network.org
# Needs a prod-capable credential (ADC or prod admin SA — not the -dev SA).
pnpm run prod-variant-sweep -- --oracle-on-prod

# Include sandbox / workshop / QA site names (off by default)
pnpm run prod-variant-sweep -- --include-sandbox
```

Needs a GCP token that can **read** `hs-levante-admin-prod` (`GOOGLE_APPLICATION_CREDENTIALS` or `gcloud auth`). `-dev` oracle also needs the local dashboard + `-dev` Firebase admin creds. `--oracle-on-prod` must **not** use a `-dev` service-account path.

Snapshots: `results/prod-assignment-variants/<YYYY-MM-DD>.{json,md}`

CI: `.github/workflows/prod-assignment-variant-sweep.yml` (05:00 PT, `--run-oracle`).

## Open / skip rules

- **Open** = `dateOpened` in the past and `dateClosed` missing or in the future.
- Skip `testData: true` and site `qa-tests` (override with `--include-test-data` / `SWEEP_SKIP_SITES`).
- Skip sandbox / test / workshop / QA / demo / playwright / cypress site names (same filter as levante-support real-site reports). `--include-sandbox` turns that off.
- Dedupes by `taskId|variantId`. One leftover used on 40 sites is one oracle cell.

## Issue labels

| Label | Meaning |
| --- | --- |
| `stale` | Variant doc exists, `registered` is not true |
| `missing` | Assignment points at a variant id that is gone |
| `no-id` | Assessment has no `variantId` |
| `ok` | Registered pack |

`--run-oracle` plays `stale` + `missing` + `no-id` when we have a QA catalog task. `--oracle-all` also plays `ok`. `--oracle-on-prod` is the same leftover set, written to **prod `qa-tests`** and played on `platform.levante-network.org`.

Oracle copies **assignment params** onto a `qa-tests` kid (`--params-json`). It does not mutate field assignments and does not clone the leftover into the catalog.

## How to read a report

Lead with how many open assignments, how many unique packs, how many are stale. Then name the leftover (task + pack name + language tag) and how many sites still use it.

Typical leftover shapes (from prior Vocab / SWR / SDS work):

- Name like `es-AR Adaptive` / `es-CO` with `language: "es"` or `"es-Ar"` and an old corpus (`CO-vocab-item-bank`).
- Registered replacement exists with the dialect tag (`es-CO` / `es-AR`) and the current item bank.
- Oracle `OK` timeout (5 min, 0 trials) = splash never hid; often a language tag whose audio folder does not exist.
- `An error occurred while starting the task` = Firekit rejected params (ROAR wants `en`/`de`/`es`, not `es-CO`).

Do **not** treat a registered-pack miss on the `-dev` nightly sweep as proof kids are fine — they may still be pinned to the leftover.

## Related

- Script: `scripts/prod-assignment-variant-sweep.mjs`
- Pinning: `POST /api/run` `{ variantId, variantName, variantParams }` → provisioner `--variant-id` / `--params-json`
- Nightly registered matrix: `pnpm run sweep` / `DAILY_SWEEP.md`
- Pack + audio inventory (no assignments): `pnpm run prod-check`
