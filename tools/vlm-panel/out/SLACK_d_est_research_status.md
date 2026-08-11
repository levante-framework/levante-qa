# AI item difficulty priors — where we are

**Framing:** Research tool for human researchers (priors / ranking / triage) Goal is a *starting* difficulty for new or blank bank items before children take them, on a scale comparable to CAT bank `d` (higher = harder). 

## Shared tooling

| Piece | Role |
|-------|------|
| **[levante-qa](https://github.com/levante-framework/levante-qa)** / Cypress VLM panel (`tools/vlm-panel`) | Models take the real task UI → `p_vlm` → calibrator → `p_pred_child` → hybrid `d_est` (`estimate_difficulty.mjs`); optional fill of *blank* bank rows only (`apply_d_est_prior.mjs`) |
| **[levante-bench](https://github.com/langcog/levante-bench)** | Child trials / `item_params` for calibration + validation; also paper open-model runs as a re-runnable ability ladder ([Tan et al., 2026, arXiv:2606.05497](https://arxiv.org/abs/2606.05497)) |
| **Lab notebook** | `tools/vlm-panel/lab_notebook_difficulty_estimation.ipynb` |

Downstream math (`fit_bench_calibrator` → `estimate_difficulty`) is the same once you have per-item success rates. **How we get those rates differs by task.**

---

## Approach A — TROG EN: live Gemini Cypress panel

**Method:** Age-grid Cypress panel on current Gemini models (real TROG UI) → calibrate → hybrid `d_est`.

**Why this works here:** Panel accuracy spreads with age/persona; items differentiate.

| Metric | Approx. Spearman ρ |
|--------|-------------------|
| Hybrid `d_est` vs bank `d` | **~0.64** |
| Blank items: AI vs human-linked ranking | **~0.71** |
| Human-IRT → bank rescale (reference) | ~0.50 |

Detail: `out/REPORT_d_est_initial_prior.md`

---

## Approach B — Stories / ToM: curated open-model ladder

**Method:** Reuse [levante-bench](https://github.com/langcog/levante-bench) paper open-model forced-binary runs ([Tan et al., 2026](https://arxiv.org/abs/2606.05497); Smol → Qwen / InternVL / Gemma / Molmo). Drop floor/broken zoo runs; keep a **top-5-by-ToM-accuracy** subset; ability-weighted mean success → same calibrator + `estimate_difficulty` path. Bank `d` is blank for ToM; validation anchors = flipped Redivis human IRT.

**Why not Approach A alone:** Live Gemini Cypress panel was CEILING-heavy even after force recollect (non-response 33% → 0%). Hybrid `d_est` from that panel only reached LOO ρ **~0.35** vs human IRT.

| Ladder / source | Approx. Spearman ρ |
|-----------------|-------------------|
| All-17 open models (mean −p) | ~0.26 |
| Curated top-5, ability-weighted −p vs human IRT | **~0.70** |
| Same ladder through hybrid `d_est` (LOO) | **~0.61** |
| Gemini Cypress −p_pred / panel `d_est` (force EN) | ~0.69 / ~0.35 |

Detail: `out/REPORT_stories_paper_ladder_backtest.md`, `out/REPORT_stories_d_est_paper_ladder.md`

---

## Other tasks (same pipeline, weaker signal so far)

| Task | Approach | Result |
|------|----------|--------|
| **Vocab EN** | Mostly Approach A (panel + DIGIT YES\|NO / randomize-on-NO) | Hybrid ~**0.65**; prefer human params when present |
| **Matrix** | Approach A smoke | Weak (~**0.20** vs bank `d`); may need Approach B–style ladder or better features |

---

## vs typical human *initial* difficulty guesses

(Psychometric literature—not a LEVANTE expert-guess archive yet. Domain varies; treat as a literature prior.)

- Experts are better at **ranking** items than guessing absolute % correct / IRT `b` (Impara & Plake, 1998; Wauters et al., 2011; Attali et al., 2014).
- Single unaided absolute judgments often only **~0.2–0.5** with later empirical difficulty (Bejar, 1983; cf. Melican / Cross-style absolute rating studies).
- Pooled / trained / comparative methods often **~0.7–0.8+** (classic pooled ratings; training/anchors improve toward ~0.5–0.65+ in Hambleton-style work).

Our stronger AI results (TROG Approach A ~0.64; Stories Approach B ~0.70 ranking / ~0.61 `d_est`) sit in the **pooled-expert** band—and above many single seat-of-the-pants guesses—as a research prior, not final CAT truth.

**Selected refs**

1. Bejar, I. I. (1983). Subject matter experts’ assessment of item statistics. *Applied Psychological Measurement*.
2. Impara, J. C., & Plake, B. S. (1998). Teachers’ ability to estimate item difficulty. *Educational Measurement: Issues and Practice*.
3. Attali, Y., et al. (2014). Comparative judgment / ranking of item difficulty (ETS). https://doi.org/10.1002/ets2.12042
4. Wauters, K., Desmet, P., & Van den Noortgate, W. (2011). Expert vs data-driven item difficulty. *EDM*.
5. Also: Lorge & Kruglov (1950s); Hambleton, Bastari & Xing (training / anchors).

**Repos & LEVANTE-bench paper**

- [levante-qa](https://github.com/levante-framework/levante-qa)
- [levante-bench](https://github.com/langcog/levante-bench)
- Tan, A. W. M., Cardinal, D., Lorido-Botran, T., Bravo-Sánchez, L., Yu, S., & Frank, M. C. (2026). *LEVANTE-bench: Multi-Scale Comparison of VLMs to Children Using Cognitive Tasks*. arXiv:2606.05497. https://arxiv.org/abs/2606.05497

---

## Bottom line

- **TROG:** live Gemini panel is enough.
- **Stories:** prefer the **curated open-model ladder**, not the full zoo or a ceiling-heavy Gemini panel alone.
- Useful when items differentiate; not a promote-to-GCS story.

**Next:** pin an open ToM ladder for new items; try the same ladder backtest on matrix/vocab; optional LEVANTE expert-guess study as a local human baseline.
