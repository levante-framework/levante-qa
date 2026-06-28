# Translation-evaluation validation set v2 — labeling & sampling plan

## Why
The current gold set (`human-review-seed-es-AR.csv`, 70 rows / 10 "poor") cannot
adjudicate evaluators. It is (1) tiny, (2) **selection-biased**: it was sampled by
the legacy back-translation score, so legacy wins by construction, and (3) its
single "Poor" label **conflates two different things** — *adequacy* (is the meaning
right?) and *child-appropriateness* (right register/vocabulary/terminology for the
age group?). Adequacy metrics (COMET, E5) intentionally ignore the second axis, so
they look bad on a label dominated by it. Fix the measurement before more method work.

## Design principles
1. **Sample independently of any automatic score** so no method has home-field advantage.
2. **Label two axes separately** so each metric is validated on what it measures.
3. **Multi-locale**, enough positives for statistical power, with documented base rates.

## Sampling
Source pool: all **approved** Crowdin translations across Levante target locales
(es-AR, es-CO, de-DE, nl-NL, fr-CA, en-GH, …) — pull via `crowdin_source.py`.

- **Backbone (≈70%): uniform random**, stratified by `locale` × `contentType`
  (instructions / item-stem / response-option / feedback) × length bucket
  (short ≤5 words, medium, long ≥20 words). Gives an **unbiased base rate**.
- **Enrichment (≈30%): hard cases**, to get enough negatives without anchoring to
  one method. Select segments where evaluators **disagree** (legacy vs COMET vs
  E5-centroid vs MQM disagree by rank) — union, not any single score's tail.
- **Targets:** ≈600–1000 segments total, ≥100 per locale, aiming for **≥100 total
  positives** (adequacy or appropriateness flagged). Rationale: distinguishing
  AUC 0.85 vs 0.75 needs ~100 positives.

## Label schema (two independent axes + MQM tags)
Per segment, annotators provide:

| field | values |
|---|---|
| `adequacy` | 0 Wrong · 1 Major loss · 2 Minor loss · 3 Faithful |
| `appropriateness` | 0 Unusable for kids · 1 Awkward · 2 Acceptable · 3 Natural for age group |
| `mqm_errors` | JSON list: `{category, severity, span?}` — category ∈ accuracy/fluency/terminology/style/locale; severity ∈ minor/major/critical |
| `overall_verdict` | derived: Poor if `adequacy≤1 OR appropriateness≤1` |
| `rater_id`, `notes` | provenance / free text |

Keep `adequacy` and `appropriateness` separate in the file — validate **COMET/E5
against adequacy** and **MQM/appropriateness model against appropriateness**.

## Annotation process
- Bilingual native speakers per locale, ideally with child-education familiarity.
- **Blind to all automatic scores** (prevents anchoring — the v1 bias).
- Written guidelines + examples per axis/severity; **20-item calibration round**
  before the full run.
- **15–20% double-annotated**; report inter-annotator agreement (Krippendorff α per
  axis); adjudicate disagreements. Acceptance: **α ≥ 0.6 per axis**.

## Output format & integration
Write `levante-web-dashboard/data/validation/human-eval-v2/<locale>.csv` (+ combined),
columns aligned to the harness:
`item_id, identifier, locale, source_en, translation, contentType, length_bucket,
adequacy, appropriateness, mqm_errors, overall_verdict, rater_id, notes`.

Then extend `validate_evaluators.py` to read the two axes and report each evaluator
against its target axis (plus the combined verdict for the production gate).

## Steps
1. Freeze this schema + write annotator guidelines.
2. `crowdin_source.py` → candidate pool → stratified + enrichment sampler → blind CSVs.
3. Recruit/assign per-locale annotators; calibration round + α check.
4. Full annotation → adjudication → freeze **v2**.
5. Re-run validation; re-tune production thresholds against the unbiased base rate.

## Acceptance criteria
≥100 positives · ≥5 locales · IAA α ≥0.6 per axis · base rate estimated from the
random backbone (not the enrichment stratum).
