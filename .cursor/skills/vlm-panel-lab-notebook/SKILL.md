---
name: vlm-panel-lab-notebook
description: >-
  Append and update entries in the VLM panel difficulty-estimation lab notebook
  (tools/vlm-panel/lab_notebook_difficulty_estimation.ipynb). Use when the user
  asks to document, add, note, or log something in the lab notebook, notebook,
  or chronology; after experiments, prompt changes, known-issue triage, analyze
  results, or panel recollects.
---

# VLM panel lab notebook

## Notebook path

`tools/vlm-panel/lab_notebook_difficulty_estimation.ipynb`

Edit with the **EditNotebook** tool (preserve markdown cell structure). Do not rewrite the whole notebook. Do not dump huge CSV/JSON into cells — link `out/` artifact paths and cite key numbers only.

## Cell map (0-based)

| Idx | Section | Put here |
|-----|---------|----------|
| 0 | Title | Rarely touch |
| 1 | Question & framing | Scope / what “done” means |
| 2 | Tooling inventory | New scripts, grids, `known_issues.json`, asset/replay modes |
| 3 | Age gradients track | Age-curve method, expected `acc=` ranges, grid ages |
| 4 | Prompt history | New prompt **versions** (table row) |
| 5 | Chronology | Dated experiment entries (primary log) |
| 6 | Key quantitative results | Update tables when metrics change |
| 7 | Conceptual learnings | Durable Q&A / principles (not raw run logs) |
| 8 | Open questions / next | Checkboxes; mark done / add next |
| 9–11 | Reload artifacts | Only if reload code cells need new filenames |

## Workflow

1. **Read** the target cell(s) first (at least chronology §5 and any section you will update).
2. **Classify** the user’s content:
   - One experiment / decision / triage → **chronology** dated entry
   - Prompt wording change → **prompt history** table row **and** short chronology pointer
   - Standing principle / Q&A → **conceptual learnings**
   - New tool/grid/flag → **tooling inventory** (one line) + chronology if it was used
   - Next steps → **open questions**
3. **Append** — do not delete prior chronology or prompt rows unless the user asks to correct an error.
4. **Tie claims to paths** under `tools/vlm-panel/out/`, grids, or source files.
5. **Update open questions** so the todo list matches reality.
6. Reply with a one-line confirmation of what was added where.

## Chronology entry template

Use today’s date from user_info. Copy this shape:

```markdown
### YYYY-MM-DD — <short title>

**Hypothesis:** …
**Change:** … (files)
**Run:** … (grid / command)
**Metrics:** … (small table + artifact paths)
**Verdict:** … (GO / NO-GO / pending / triage-only)
**Next:** …
```

If the user only wants a note (no full experiment), a shorter form is fine:

```markdown
### YYYY-MM-DD — <short title>

- **What:** …
- **Why / evidence:** … (paths or numbers)
- **Follow-up:** …
```

## Prompt history row

Add one table row to cell 4 (do not renumber older versions casually):

| Date | Commit or *(lab / working tree)* | Prompt change |

Label versions **vN** when it is a real prompt behavior change (e.g. v3 age-conditional, v4 head-noun). Note whether a **remeasure** (force replay) has happened yet.

## Conventions

- Prefer **EN TROG** unless the user specifies another task/locale.
- Ages for the default grid are **`[6, 8, 10, 12]`** (not 13).
- `acc=` in replay logs = panel accuracy, not child pass rates.
- Known broken items live in `tools/vlm-panel/known_issues.json` (suppressed from `review_*.csv`, still on `screen_*.csv`).
- Capture/replay: assets under `tools/vlm-panel/assets/trog/<lang>/`; status at `out/status.json`.
- Keep narrative tight; no emojis; no fluff.

## Anti-patterns

- Do not paste full `report.md` or CSV contents into the notebook.
- Do not invent metrics — read `out/` or say **pending**.
- Do not put ephemeral “still running” status in chronology; wait for finish or use open questions.
- Do not create a second notebook; this file is canonical.
