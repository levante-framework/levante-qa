# Child Twins panel

Age × country × language agents for LEVANTE core tasks — psychometric twin
(`sim_child`) and VLM persona on one resumable grid.

## Axes

| Axis | Default MVP values | Env |
|------|--------------------|-----|
| Age | 6, 8, 10 | `QA_SIM_AGE_YEARS` / `QA_PERSONA_AGE_YEARS` |
| Country | `de`, `co`, `ca` | `QA_SIM_COUNTRY` / `QA_PERSONA_COUNTRY` |
| Language | paired with country | `QA_LANGUAGE` |
| Task | trog, vocab, matrix, stories, egma, SDS, mental rotation | Cypress specs |
| Agent | `sim`, `vlm` | entry specs |

**Locale pairs** (edit `locales[]` in `panel_grid.json` to add cross pairs):

- `de` + `de-DE`
- `co` + `es-CO`
- `ca` + `en-US`

Country norms come from `cypress/support/persona/age_task_*_by_country.json`
(synced from levante-bench via `pnpm persona:sync`).

## Usage

```bash
pnpm child-twins:dry              # print the full plan
pnpm child-twins:smoke            # run the first cell only
node tools/child-twins/run_panel.mjs --agent sim
node tools/child-twins/run_panel.mjs --agent vlm --limit 2
node tools/child-twins/run_panel.mjs --grid path/to/grid.json
```

Runs are sequential (parallel Cypress OOMs under WSL2). Progress is in
`tools/child-twins/out/manifest.json`; cells whose `cypress/logs/runs/<QA_RUN_ID>/`
already has a `.jsonl` are skipped.

## Single-cell examples

```bash
QA_SIM_AGE_YEARS=6 QA_SIM_COUNTRY=co QA_LANGUAGE=es-CO pnpm cy:run:trog:sim
QA_PERSONA=child QA_PERSONA_AGE_YEARS=10 QA_PERSONA_COUNTRY=de \
  QA_PERSONA_ABILITY=irt QA_LANGUAGE=de-DE pnpm cy:run:vocab:vlm
```
