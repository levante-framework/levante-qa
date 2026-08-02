# Study A — NL TROG translation rating (Prolific pilot)

Native Dutch speakers rate English→Dutch TROG stems so we can check whether
cross-lang VLM drops (`p_nl − p_en`) are **translation problems** or model noise.

**Recommended host (live):** custom survey on Vercel → Airtable inbox  
(not Qualtrics — no extra license; Prolific-ready)

## Live links

| What | URL / ID |
|------|----------|
| **Survey (production)** | https://nl-trog-study-a.vercel.app |
| **Prolific study URL** | `https://nl-trog-study-a.vercel.app/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}` |
| **Completion code** | `NLTR0GA1` |
| **Vercel project** | `levante-projects/nl-trog-study-a` |
| **Response inbox** | TranslationTracker → **VoiceConfig** rows with `Service = prolific-study-a` |

Dedicated Airtable base `NL TROG Study A (Prolific)` (`appIMZ38pmL4hKkSd`) also exists
(Submissions / Ratings tables) for a future clean schema; the live API currently
writes the inbox above because the existing PAT has write access there.

## What’s in the box

| Path | Purpose |
|------|---------|
| `blind/nl-NL.csv` | Annotator CSV (empty labels; no VLM scores) |
| `provenance.csv` | Stratum + Δ (analysis only) |
| `survey/` | Deployed web app + `/api/submit` |
| `survey/export_responses.py` | Pull inbox → `survey/responses/*.csv` |
| `PROLIFIC_COPY.md` | Screener / consent / pay copy |
| `build_items.py` | Regenerate pool from `review_xlang_nl.csv` |

## Sampling (seed=42)

| Stratum | n | Rule |
|---------|--:|------|
| `xlang_drop` | 13 | Δ ≤ −0.12 (includes the two priority items) |
| `control` | 13 | \|Δ\| ≤ 0.05, matched 1:1 on EN `p_vlm` |
| `filler` | 10 | \|Δ\| ≤ 0.08 extras |
| + attention | 2 | Built into the survey (not in provenance) |
| **Survey total** | **38** | Shuffled |

Priority drops:

- `trog_disjunctive_he_wear_despite_size` — *ondanks de grote omvang*
- `trog_preploc_plane_gray_above_cloud` — *boven de wolken*

## Launch on Prolific

1. Create study; paste listing copy from `PROLIFIC_COPY.md`.
2. Study link = production URL with Prolific params (table above).
3. Completion code = `NLTR0GA1` (survey also redirects to Prolific complete URL).
4. Filters: first language Dutch; country Netherlands; 18+; approval ≥95%.
5. Places: **8** (optional 12); reward **£3.00**; estimate 15–20 min.

## After data returns

```bash
python3 scripts/eval/studies/nl-trog-xlang-pilot/survey/export_responses.py
# → survey/responses/submissions.csv + ratings.csv
```

Join `ratings.csv` to `provenance.csv` on `identifier`. Primary contrast: Poor-rate
(`adequacy≤1` or `appropriateness≤1`) on `xlang_drop` vs `control`. Read notes on
the two priority items.

## Redeploy survey

```bash
cd scripts/eval/studies/nl-trog-xlang-pilot
python3 build_items.py
# refresh survey/items.json (rebuild script embeds attention checks — re-run the
# items packer in README history, or edit survey/items.json)
cd survey && npx vercel@latest deploy --prod --yes --scope levante-projects
```

Env on Vercel (already set): `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`, `AIRTABLE_INBOX_TABLE_ID`.

## Out of scope

- Child pass-rates · picture 4AFC (Study B) · full random nl-NL validation pool
