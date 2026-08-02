# Prolific / survey copy — NL TROG Study A

## Live survey

**URL:** https://nl-trog-study-a.vercel.app

**Prolific study link (paste into Prolific):**
```
https://nl-trog-study-a.vercel.app/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
```

**Completion code:** `NLTR0GA1`  
(The app also auto-redirects to `https://app.prolific.com/submissions/complete?cc=NLTR0GA1`.)

Attention checks are built into the web app.

---

## Study title (participant-facing)

**Dutch translations for a children’s language task (English → Dutch)**

## Study description (Prolific listing)

We are checking Dutch translations used in a research assessment for children.
You will see short English sentences and their Dutch translations. For each pair,
you rate (1) whether the meaning matches and (2) whether the Dutch wording is
natural for speaking with children.

No specialised linguistics training is required. Please do **not** use
machine-translation tools — we need your own judgment.

- **Estimated time:** 15–20 minutes  
- **Payment:** £3.00  
- **Device:** desktop or laptop preferred (tablet OK); phone not recommended  

## Screener / filters (Prolific)

| Filter | Setting |
|--------|---------|
| First language | Dutch |
| Current country of residence | Netherlands *(optional second study arm: Belgium)* |
| Age | 18+ |
| Approval rate | ≥ 95% |
| Prior submissions | ≥ 20 (optional) |

Optional custom screener (reject if failed):

> Is Dutch your strongest / native language?  
> ○ Yes, I grew up speaking Dutch  
> ○ No / I learned Dutch later  

Exclude “learned later” unless you intentionally want L2 raters.

## Sample size & cost

| Plan | Completes | Pay | Est. Prolific fees | Total ballpark |
|------|----------:|----:|-------------------:|---------------:|
| Pilot | 8 | £3.00 | ~£8–10 | **~£35** |
| + spare | 12 | £3.00 | ~£12–15 | **~£50** |

## Analysis

```bash
python3 scripts/eval/studies/nl-trog-xlang-pilot/survey/export_responses.py
```

Join ratings to `provenance.csv` on `identifier`. Compare Poor rates
(`adequacy≤1` or `appropriateness≤1`) for `xlang_drop` vs `control`.
