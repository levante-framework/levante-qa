# Setting item difficulty before kids take the test

**What this is about:** Using a panel of vision-language models (VLMs) to estimate how hard a TROG item is—on the same scale our adaptive test already uses—**before any child has tried that item**.

**When:** Results as of 8 August 2026 (English TROG, after a full panel re-run).

---

## The problem

Our adaptive test (CAT) needs a difficulty number (`d`) for every item so it can pick the next question wisely.

For brand-new or unfinished bank items that number is often:

- missing,
- a rough guess, or
- unavailable until enough children have taken the item and we’ve run a full statistical fit.

Missing or guessed difficulties make early adaptive routing worse. Waiting for child data delays launch.

---

## What we do instead

1. Have AI “examine” take the **same item screens** children see.
2. Translate how often the AI gets the item right into an estimate of how often **children** would.
3. Map that onto the **official difficulty scale** used in the item bank (`d_est`).
4. If the bank difficulty is blank, fill it with that estimate—**without changing** difficulties that are already established.
5. Skip items the panel clearly can’t do (broken or known-bad items).
6. When real child data exists later, normal scoring can replace the estimate.

You still need historical child data on *other* items to teach the system how AI scores relate to kids and to the bank scale. You do **not** need children on *this* new item before you have a usable starting difficulty.

---

## Why this is useful

It gives a **better starting difficulty** than a blank or a guess: grounded in behavior on the real item, expressed on the production scale, available **before** field testing that item.

It is a **starting point**, not the final word. Child data should overwrite it once you have enough.

---

## How we know it works

We checked the AI-based estimate against human evidence in two ways.

### 1. Items that already have an official difficulty

Here we can ask: “Does the AI estimate match the real bank number?”

| Approach | How well it matches official difficulty* |
|----------|------------------------------------------|
| **AI panel estimate (`d_est`)** | Strong — about **0.64** |
| Child pass rates alone | Weaker — about **0.46** |
| Human IRT parameters rescaled onto the bank | Moderate — about **0.50** |

\*Spearman rank correlation (1.0 = perfect ranking agreement). Higher is better.

So the AI estimate tracks the official scale **better than** simply using how often kids pass, and **at least as well as** (here, better than) taking human statistical parameters and forcing them onto the bank scale.

### 2. Items with no official difficulty yet (“blank” items)

Here there is no official number to hit. We ask: “Does the AI estimate and a human-data estimate **agree on which items are harder**?”

For 13 blank items where both exist, they agree at about **0.71**—a clear shared ranking, not identical numbers.

Six blank items never got a human statistical parameter at all (mostly very easy practice nouns, plus a couple of odd cases). For those, the AI estimate (or pass rates) is the only difficulty signal until they’re fit properly.

**Detail table and methods:** [blank_d_human_vs_d_est_trog_en.md](blank_d_human_vs_d_est_trog_en.md)

---

## What else we learned

**It works as a quality screen, not only as a difficulty prior.**  
The panel flags items that look broken, too hard, or too easy compared with children. On English TROG after the full re-run, difficulty ranking vs child pass rates was again about **0.64**, and predicted child pass rates were off by only about **0.07** on average.

**Some AI-only ideas do not work.**  
Trying to recover bank difficulty from “ability curves” across ages in the panel failed badly (~**0.08** correlation). We do not use that for setting `d`.

**Prompt tweaks have limits.**  
A clearer “who is the main noun?” rule helped some constructions in a small test, but a full re-run still left a few hard items broken (and one known bad item stays on a suppress list). We froze the working prompt version and do not chase every miss with more wording.

**Other languages.**  
German and Spanish panel runs look similarly useful for spotting translation or difficulty shifts; English remains the main path for setting bank priors for now.

**Vocabulary.**  
For vocab, ranking from AI pass rates is already strong; the extra hybrid step helps less than it does for TROG grammar items.

---

## Plain-language bottom line

We can set a **sensible initial difficulty** for new TROG items by having AI take the real task and mapping that onto our bank scale—**without waiting for children to take that item**.

We trust it enough to use as a prior because it **matches official difficulties well** where we can check (~0.64), **beats** a simple human-parameter rescale (~0.50), and **agrees with human-based rankings** on unfinished items (~0.71).

Use it to start adaptive testing in the right ballpark. Let real child data take over when it arrives.

---

## Where to look next

| Document | Contents |
|----------|----------|
| [blank_d_human_vs_d_est_trog_en.md](blank_d_human_vs_d_est_trog_en.md) | Side-by-side AI vs human estimates on blank items |
| `d_est_trog_en_report.md` | Full hybrid difficulty fit report |
| `d_est_prior_report_trog_en.md` | What was filled / skipped in the draft bank |
| `lab_notebook_difficulty_estimation.ipynb` | Lab chronology and decisions |
