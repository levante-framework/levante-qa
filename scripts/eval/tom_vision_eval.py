#!/usr/bin/env python3
"""
Theory-of-Mind (Stories) story->picture vision check: given the *translated* narration
plus the question, does a vision model still pick the keyed answer picture?

The Stories task (theory-of-mind) tells a short illustrated story over several narration
turns, then asks a question ("Where will Madison look for her book first?", "How does
Hannah feel?"). The child taps the ONE answer picture (of 2-4) that the story implies
(a location like `chair`/`rug`, an emotion face like `angry`/`happy`, or `yes`/`no`).
The reasoning lives entirely in the narration + question text, so a mistranslation that
breaks the false-belief / emotion logic changes the correct answer.

So we run the actual task with a vision model. For each question we assemble the story
(all preceding narration turns in its block) + the question, show the model the answer
pictures (shuffled), and it picks one. We do this first for ENGLISH (a control) then per
locale:

  - control FAILS (English doesn't resolve to the keyed picture)  -> item/model issue
    (the item is too hard for the model even in English; not a translation problem)
    -> tag `item_or_model`.
  - control PASSES but a locale FAILS -> the translation broke a solvable item
    -> tag `translation_issue`.

Unlike TROG the answer pictures are semantically distinct (not lookalike minimal pairs),
so grounding-glitch noise is low and no single-image confirmation gate is needed; the
English control plus the cross-locale guard (a lone locale miss that the control and a
majority of other locales solved is demoted to `likely_noise`) supply the precision.

Items + keyed answer + distractor image keys + question type come from the ToM item bank;
translations (narration + questions) come live from Crowdin (default) or a saved CSV;
images come from the deployed GCS `visual/theory-of-mind/` bucket (default) or a local dir.

    python tom_vision_eval.py --locales es-AR,de
"""

from __future__ import annotations

import argparse
import csv
import io
import sys
from collections import OrderedDict
from pathlib import Path
from typing import Dict, List, Optional

from envload import load_env
from vocab_vision_eval import ImageResolver, img_md, load_translation_rows, render_pdf
from trog_vision_eval import (
    TrogVisionEvaluator, _item_num, _read_corpus_text, apply_cross_locale_guard,
    resolve_layout,
)

PROMPT_VERSION_TOM = "tom-vision-v1"

PROMPT_TOM = """You are administering a "theory of mind" story-comprehension test to a
young child. The child listens to a short story and then taps the ONE picture (of {n})
that correctly answers the question. The {n} answer pictures are labelled {labels}, shown
above in that order (they may be places, emotion faces, or yes/no).

Story and question ({locale}):
{sentence}

Reason about what each character knows, believes, sees, or feels in the story — including
mistaken (false) beliefs — then choose the single picture that correctly answers the
question.

Respond with ONLY a JSON object:
{{"choice": one of {labels},
  "confidence": 0.0-1.0,
  "reason": "one short sentence explaining the choice"}}"""

FILLER_IDS = {"ToM-intro", "ToM-transition"}


def tom_corpus_url(bucket: str = "levante-assets-dev") -> str:
    """The deployed ToM item bank — exactly what the task-launcher pulls at runtime."""
    return f"https://storage.googleapis.com/{bucket}/corpus/theory-of-mind/theory-of-mind-item-bank.csv"


def load_tom_items(corpus_source: str) -> List[dict]:
    """One dict per scored question: keyed answer image key, distractor keys, question
    type, difficulty, the question's English prompt, and the ordered narration turns
    (id + English prompt) that precede it in the same story block (so each locale's story
    can be reassembled from Crowdin)."""
    rows = list(csv.DictReader(io.StringIO(_read_corpus_text(corpus_source))))
    blocks: "OrderedDict[str, list]" = OrderedDict()
    for r in rows:
        blocks.setdefault((r.get("block_index") or "").strip(), []).append(r)

    out: List[dict] = []
    for brows in blocks.values():
        narration: List[dict] = []  # accumulating story turns for this block
        for r in brows:
            tt = (r.get("trial_type") or "").strip()
            iid = (r.get("item_id") or r.get("audio_file") or "").strip()
            prompt = (r.get("prompt") or "").strip()
            if iid in FILLER_IDS:
                continue
            if tt == "instructions":
                if prompt:
                    narration.append({"id": iid, "en": prompt})
                continue
            if not tt.endswith("question"):
                continue
            answer = (r.get("answer") or "").strip().split(",")[0].strip()
            alts = [a.strip() for a in (r.get("response_alternatives") or "").split(",") if a.strip()]
            if not answer or not alts:
                continue
            d = (r.get("difficulty") or "").strip()
            out.append({
                "item_id": iid, "answer": answer, "distractors": alts,
                "trial_type": tt, "d": float(d) if d else None,
                "narration": list(narration), "question_id": iid, "en_question": prompt,
            })
    return out


def build_sentence(item: dict, tmap: Dict[str, dict], lang: str) -> tuple[str, str]:
    """Reassemble (story, question) for an item in `lang` ('en' or a locale column),
    falling back to the English corpus text when a Crowdin row is missing."""
    parts: List[str] = []
    for n in item["narration"]:
        row = tmap.get(n["id"])
        txt = ((row.get(lang) if row else "") or "").strip()
        if not txt and lang == "en":
            txt = n["en"]
        if txt:
            parts.append(txt)
    qrow = tmap.get(item["question_id"])
    q = ((qrow.get(lang) if qrow else "") or "").strip()
    if not q and lang == "en":
        q = item["en_question"]
    return " ".join(parts), q


def _combined(story: str, q: str) -> str:
    return f"Story: {story}\n\nQuestion: {q}" if story else f"Question: {q}"


def apply_reliability_gate(all_rows: List[dict], min_solved_frac: float = 0.5,
                           min_solved: int = 2) -> int:
    """ToM reasoning is hard for the VLM, so a single English-control pass does NOT prove
    an item is reliably solvable — and when the model fails the SAME item across many
    locales (even on a faithful translation, incl. en-GB) those are model-variance noise,
    not translation errors. So only let a locale failure count as a `translation_issue`
    when a strict majority of locales (>= `min_solved`) ALSO solved the item; otherwise the
    item is model-unreliable -> reclassify its flags to `item_or_model`. Returns the count
    reclassified. (TROG doesn't need this: its English control + per-item reliability are
    high; ToM's are not.)"""
    by_item: Dict[str, List[dict]] = {}
    for r in all_rows:
        by_item.setdefault(r["item_id"], []).append(r)
    moved = 0
    for rs in by_item.values():
        n = len(rs)
        solved = sum(int(x["correct"]) for x in rs)
        if solved >= min_solved and solved > n * min_solved_frac:
            continue  # reliably solvable -> a minority failure can be a translation issue
        for r in rs:
            if r["tag"] == "translation_issue":
                r["tag"] = "item_or_model"
                moved += 1
    return moved


def classify(ev: "TrogVisionEvaluator", item: dict, layout, tmap: Dict[str, dict],
             locale: str) -> Optional[dict]:
    """Run the AFC for English (control) and the locale, then tag:
      - locale correct           -> "" (fine)
      - control fails            -> `item_or_model` (too hard even in English)
      - control OK, locale fails -> `translation_issue`
    Returns None when the locale has no translated question to score."""
    keys, answer_idx, images, keyed_img = layout
    en_story, en_q = build_sentence(item, tmap, "en")
    loc_story, loc_q = build_sentence(item, tmap, locale)
    if not loc_q:
        return None
    en_text, loc_text = _combined(en_story, en_q), _combined(loc_story, loc_q)

    en = ev.evaluate(item["item_id"], en_text, "en", images, keys)
    en_ok = en["choice_index"] == answer_idx
    res = ev.evaluate(item["item_id"], loc_text, locale, images, keys)
    loc_ok = res["choice_index"] == answer_idx
    picked = keys[res["choice_index"]] if res["choice_index"] >= 0 else "(none)"

    if loc_ok:
        tag = ""
    elif not en_ok:
        tag = "item_or_model"
    else:
        tag = "translation_issue"
    return {
        "locale": locale, "item_id": item["item_id"], "trial_type": item["trial_type"],
        "difficulty": "" if item["d"] is None else round(item["d"], 4),
        "en_sentence": en_text, "translation": loc_text,
        "en_question": en_q, "translation_question": loc_q,
        "en_correct": int(en_ok), "correct": int(loc_ok),
        "answer_key": item["answer"], "picked_key": picked,
        "en_picked_key": keys[en["choice_index"]] if en["choice_index"] >= 0 else "(none)",
        "image": str(keyed_img),
        "picked_image": str(images[res["choice_index"]]) if res["choice_index"] >= 0 else "",
        "confidence": res["confidence"], "reason": res["reason"], "tag": tag, "guard": "",
    }


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Theory-of-Mind story-vs-pictures vision check (AFC + English control).")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--from-crowdin", action="store_true",
                     help="(Default) Pull approved translations live from Crowdin.")
    src.add_argument("--translations-csv", default=None,
                     help="Use a saved Crowdin export CSV instead of pulling live.")
    p.add_argument("--locales", default="es-AR", help="Comma-separated locales (column names).")
    p.add_argument("--image-source", choices=["gcs", "local"], default="gcs",
                   help="Where answer images come from (default: deployed GCS visual bucket).")
    p.add_argument("--gcs-bucket", default="levante-assets-dev",
                   help="GCS bucket for --image-source gcs (use levante-assets-prod for prod).")
    p.add_argument("--gcs-prefix", default="visual/theory-of-mind/")
    p.add_argument("--image-dir", default="../../../core-task-assets/theory-of-mind/original",
                   help="Comma-separated local image dir(s) for --image-source local.")
    p.add_argument("--corpus-csv", default=None,
                   help="Override the ToM item bank source (local path or URL). Default: pull "
                        "live from gs://<gcs-bucket>/corpus/theory-of-mind/theory-of-mind-item-bank.csv.")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--output-dir", default="output")
    p.add_argument("--no-pdf", action="store_true", help="Skip rendering the report PDF.")
    args = p.parse_args()

    rows = load_translation_rows(args)
    tmap: Dict[str, dict] = {}
    for r in rows:
        ident = r.get("identifier", "") or r.get("item_id", "")
        if "stories.xliff" not in (ident + r.get("_path", "")):
            continue
        tmap[ident.split("::")[-1]] = r

    corpus_source = args.corpus_csv or tom_corpus_url(args.gcs_bucket)
    items = load_tom_items(corpus_source)
    print(f"[tom] item bank: {corpus_source}")
    if args.limit:
        items = items[:args.limit]
    locales = [l.strip() for l in args.locales.split(",") if l.strip()]
    resolver = ImageResolver(args.image_source, local_dirs=args.image_dir,
                             bucket=args.gcs_bucket, prefix=args.gcs_prefix,
                             cache_dir="output/gcs_tom_cache")
    print(f"[tom] {len(resolver)} images indexed from {resolver.label}")
    print(f"[tom] {len(items)} scored questions in the bank; {len(tmap)} translatable strings.")

    ev = TrogVisionEvaluator(cache_dir="output/tom_vision_cache",
                             prompt_template=PROMPT_TOM, prompt_version=PROMPT_VERSION_TOM)

    all_rows: List[dict] = []
    n_missing_img = 0
    layout_cache: dict = {}
    from tqdm import tqdm
    for it in tqdm(items, desc="tom"):
        layout = resolve_layout(resolver, it, layout_cache)
        if layout is None:
            n_missing_img += 1
            continue
        for loc in locales:
            row = classify(ev, it, layout, tmap, loc)
            if row is not None:
                all_rows.append(row)

    n_unreliable = apply_reliability_gate(all_rows)
    n_guarded = apply_cross_locale_guard(all_rows)

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    field_order = ["locale", "item_id", "trial_type", "difficulty", "en_question",
                   "translation_question", "en_correct", "correct", "answer_key",
                   "picked_key", "en_picked_key", "confidence", "reason", "tag", "guard"]

    def write_csv(path: Path, data: List[dict]) -> None:
        if not data:
            return
        with path.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=field_order, extrasaction="ignore")
            w.writeheader()
            w.writerows(data)

    for loc in locales:
        write_csv(out_dir / f"tom-vision-{loc}.csv", [r for r in all_rows if r["locale"] == loc])
    write_csv(out_dir / "tom-vision-all.csv", all_rows)
    report = out_dir / "tom-vision-report.md"
    write_markdown_report(all_rows, report, locales)
    pdf = out_dir / "tom-vision-report.pdf"
    pdf_ok = render_pdf(report, pdf, title="Theory-of-Mind Story-vs-Pictures Vision Report") if not args.no_pdf else False

    n_tr = sum(1 for r in all_rows if r["tag"] == "translation_issue")
    n_im = len({r["item_id"] for r in all_rows if r["tag"] == "item_or_model"})
    for loc in locales:
        lr = [r for r in all_rows if r["locale"] == loc]
        bad = [r for r in lr if r["tag"] == "translation_issue"]
        ctrl = sum(1 for r in lr if r["tag"] == "item_or_model")
        print(f"\n[{loc}] {len(lr)} checked | {len(bad)} TRANSLATION ISSUE | "
              f"{ctrl} skipped (English control failed)")
        for r in bad:
            print(f"   BAD {r['item_id']:34} ({r['trial_type']}) keyed {r['answer_key']} "
                  f"-> picked {r['picked_key']} ({r['reason']})")

    print(f"\n[done] {len(all_rows)} checks across {len(locales)} locale(s): "
          f"{n_tr} translation issues; {n_im} questions failed the English control "
          f"(item/model, not translation); {n_unreliable} flag(s) reclassified as model-unreliable "
          f"(item not solved by a locale majority); {n_guarded} lone miss(es) demoted to likely VLM "
          f"noise by the cross-locale guard. {n_missing_img} questions skipped (missing image).")
    print(f"       CSV -> {out_dir / 'tom-vision-all.csv'}")
    print(f"       report -> {report}")
    if pdf_ok:
        print(f"       pdf -> {pdf}")
    return 0


def _cell(s: str) -> str:
    return (s or "").replace("|", "\\|").replace("\n", " ").strip()


def write_markdown_report(all_rows: List[dict], path: Path, locales: List[str]) -> None:
    """Translation issues first (control passed, locale failed), then the cross-locale
    noise bucket, then English-control failures (language-independent item/model limits)."""
    by_item: Dict[str, List[dict]] = {}
    for r in all_rows:
        by_item.setdefault(r["item_id"], []).append(r)

    n_items = len(by_item)
    n_tr = sum(1 for r in all_rows if r["tag"] == "translation_issue")
    tr_items = sorted({r["item_id"] for r in all_rows if r["tag"] == "translation_issue"})
    noise_items = sorted({r["item_id"] for r in all_rows if r["tag"] == "likely_noise"})
    ctrl_items = sorted({r["item_id"] for r in all_rows if r["tag"] == "item_or_model"})

    lines = ["# Theory-of-Mind story-vs-pictures vision report", ""]
    lines.append(f"- Locales checked: {', '.join(locales)}")
    lines.append(f"- Questions checked: {n_items}  ·  total checks: {len(all_rows)}  ·  "
                 f"translation issues: {n_tr}")
    lines.append("")
    lines.append("Each question is run as the real picture forced choice with a vision model, "
                 "given the assembled story + question, first for English (a control) then per "
                 "locale. A locale miss is a **translation_issue** only when the English control "
                 "solved the same item (so the picture set and reasoning are fine and the broken "
                 "input is the translation). **English-control failures** are language-independent "
                 "(the model can't resolve even the English item — common for hard false-belief "
                 "reasoning) and are listed separately. A cross-locale guard demotes a lone locale "
                 "miss to **likely VLM noise** when the control and a majority of other locales "
                 "solved the same item.")
    lines.append("")

    def issue_table(tid: str, tag: str, why_header: str, why_fn) -> None:
        rs = [r for r in by_item[tid] if r["tag"] == tag]
        h = rs[0]
        d = h.get("difficulty", "")
        d_str = f", d={d}" if d != "" else ""
        lines.append(f"### {tid} ({h['trial_type']}{d_str}) — keyed `{h['answer_key']}`")
        lines.append("")
        lines.append(f"_Story (EN):_ {_cell(h['en_sentence'])}")
        lines.append("")
        keyed = img_md(h.get("image", ""), path.parent, alt=h["answer_key"], height=72)
        lines.append("| keyed answer | English question | locale | translated question | picked | " + why_header + " |")
        lines.append("|---|---|---|---|---|---|")
        for i, r in enumerate(sorted(rs, key=lambda x: x["locale"])):
            pic = img_md(r.get("picked_image", ""), path.parent, alt=r["picked_key"], height=60)
            cell = f"{r['picked_key']}<br>{pic}" if pic else r["picked_key"]
            c_img = keyed if i == 0 else ""
            c_src = _cell(h["en_question"]) if i == 0 else ""
            lines.append(f"| {c_img} | {c_src} | {r['locale']} | {_cell(r['translation_question'])} "
                         f"| {cell} | {_cell(why_fn(r))} |")
        lines.append("")

    lines.append(f"## Translation issues — {len(tr_items)} question(s)")
    lines.append("")
    if not tr_items:
        lines.append("_None._")
        lines.append("")
    for tid in tr_items:
        issue_table(tid, "translation_issue", "why (model's reason)", lambda r: r["reason"])

    if noise_items:
        lines.append(f"## Likely VLM noise (suppressed) — {len(noise_items)} question(s)")
        lines.append("")
        lines.append("A single locale missed but the English control and a majority of the other "
                     "locales solved the same item — almost certainly per-run noise, not a "
                     "translation error. Listed for review; not counted as a translation issue.")
        lines.append("")
        for tid in noise_items:
            issue_table(tid, "likely_noise", "why suppressed", lambda r: r.get("guard", ""))

    lines.append(f"## English-control failures (item/model, not translation) — {len(ctrl_items)} question(s)")
    lines.append("")
    if not ctrl_items:
        lines.append("_None._")
        lines.append("")
    for tid in ctrl_items:
        h = by_item[tid][0]
        d = h.get("difficulty", "")
        d_str = f", d={d}" if d != "" else ""
        lines.append(f"- `{tid}` ({h['trial_type']}{d_str}) — “{_cell(h['en_question'])}”: "
                     f"model picked `{h['en_picked_key']}` for English, keyed `{h['answer_key']}`.")
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
