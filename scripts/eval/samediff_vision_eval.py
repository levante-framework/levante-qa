#!/usr/bin/env python3
"""
Same-Different-Selection instruction->card vision check: does the translated instruction
still pick the keyed card among its (minimal-pair) distractors?

The matching game's single-select trials show 4 cards and an instruction like "Choose the
card with a circle." / "Choose the card with a green shape." The 4 cards are deliberate
**minimal pairs** — identical except on one dimension (shape, colour, size, fill, number)
— so generic text metrics are useless and the real criterion is: hearing the translated
instruction, would a child still pick the keyed card? That is exactly the TROG setup, so
this reuses the TROG evaluator/classifier (4-AFC + English control + single-image
confirmation gate + cross-locale guard); only the prompt, corpus and translation keying
differ.

Note: the corpus item ids (`sds-dim-test-circle`) do NOT match the Crowdin ids
(`same-different-selection-touch-circle`), but the English instruction text matches
exactly, so translations are joined by normalised English text rather than by id.

Items + keyed answer + distractor image keys + `trial_type` come from the SDS item bank
(single-select rows, `required_selections == 1`); instructions come live from Crowdin
(default) or a saved CSV; card images come from GCS `visual/same-different-selection/`.

    python samediff_vision_eval.py --locales es-AR,de
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import random
import sys
from pathlib import Path
from typing import Dict, List, Optional

from envload import load_env
from vocab_vision_eval import ImageResolver, img_md, load_translation_rows, render_pdf, _norm_key
from trog_vision_eval import (
    TrogVisionEvaluator, _read_corpus_text, apply_cross_locale_guard, classify,
)

PROMPT_VERSION_SD = "samediff-vision-v1"

PROMPT_SD = """You are administering a card-matching game to a young child. The child hears
ONE instruction and must tap the ONE card (of {n}) that matches it. The {n} cards are
labelled {labels}, shown above in that order.

Instruction ({locale}): "{sentence}"

The cards are deliberately similar — they differ only by shape, colour, size, fill, or
number. Read the instruction carefully and choose the single card it describes.

Respond with ONLY a JSON object:
{{"choice": one of {labels},
  "confidence": 0.0-1.0,
  "reason": "one short sentence naming what the chosen card shows"}}"""

CONFIRM_PROMPT_SD = """You are checking a translated instruction from a child's card-matching
game against the ONE card it is meant to select (the keyed-correct card for this item).

Instruction ({locale}): "{sentence}"

Does this card satisfy the instruction? Judge shape, colour, size, fill and number. A
correct instruction may be phrased differently than English as long as it truthfully
selects this card. Answer "no" ONLY if the card does NOT satisfy the instruction
(wrong shape/colour/size/fill/number, or a mistranslation).

Respond with ONLY a JSON object:
{{"match": "yes" | "no" | "uncertain",
  "confidence": 0.0-1.0,
  "reason": "one short sentence"}}"""


def sd_corpus_url(bucket: str = "levante-assets-dev") -> str:
    """The deployed SDS item bank — exactly what the task-launcher pulls at runtime."""
    return f"https://storage.googleapis.com/{bucket}/corpus/same-different-selection/same-different-selection-item-bank.csv"


def load_sd_items(corpus_source: str) -> List[dict]:
    """One dict per single-select SDS item (required_selections == 1): id, keyed answer
    card key, distractor card keys, `trial_type`, difficulty d, and the English
    instruction text (the join key to Crowdin)."""
    out: List[dict] = []
    for r in csv.DictReader(io.StringIO(_read_corpus_text(corpus_source))):
        iid = (r.get("item_id") or r.get("audio_file") or "").strip()
        ttype = (r.get("trial_type") or "").strip()
        if (r.get("required_selections") or "").strip() != "1":
            continue
        answer = (r.get("answer") or "").strip().split(",")[0].strip()
        alts = [a.strip() for a in (r.get("response_alternatives") or "").split(",") if a.strip()]
        instr = (r.get("item") or "").strip()
        if not answer or not alts or not instr:
            continue
        d = (r.get("difficulty") or r.get("d") or "").strip()
        out.append({"item_id": iid, "answer": answer, "distractors": alts,
                    "trial_type": ttype, "d": float(d) if d else None, "en_item": instr})
    return out


def _seed(item_id: str) -> int:
    return int(hashlib.md5(item_id.encode("utf-8")).hexdigest()[:8], 16)


def resolve_layout(resolver, item: dict, cache: Optional[dict] = None):
    """Resolve an item's choice card images and a per-item shuffled layout (seeded by a
    hash of the id so the keyed card isn't pinned to one position across items). Returns
    (ordered_keys, answer_index, ordered_image_paths, keyed_image_path) or None."""
    if cache is not None and item["item_id"] in cache:
        return cache[item["item_id"]]
    choices = [item["answer"]] + item["distractors"]
    paths = {k: resolver.resolve(k) for k in choices}
    if any(paths[k] is None for k in choices):
        result = None
    else:
        order = list(range(len(choices)))
        random.Random(_seed(item["item_id"])).shuffle(order)
        keys = [choices[i] for i in order]
        result = (keys, order.index(0), [paths[k] for k in keys], paths[item["answer"]])
    if cache is not None:
        cache[item["item_id"]] = result
    return result


def make_evaluator() -> TrogVisionEvaluator:
    return TrogVisionEvaluator(cache_dir="output/samediff_vision_cache",
                               prompt_template=PROMPT_SD, prompt_version=PROMPT_VERSION_SD,
                               confirm_template=CONFIRM_PROMPT_SD)


def build_en_tmap(rows: List[dict]) -> Dict[str, dict]:
    """Map normalised English instruction text -> Crowdin row (SDS ids don't match the
    corpus, but the English text does)."""
    tmap: Dict[str, dict] = {}
    for r in rows:
        if "same-and-different" not in (r.get("identifier", "") + r.get("_path", "")):
            continue
        en = (r.get("en") or "").strip()
        if en:
            tmap.setdefault(_norm_key(en), r)
    return tmap


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Same-Different instruction-vs-cards vision check (4-AFC + control + gate).")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--from-crowdin", action="store_true",
                     help="(Default) Pull approved translations live from Crowdin.")
    src.add_argument("--translations-csv", default=None,
                     help="Use a saved Crowdin export CSV instead of pulling live.")
    p.add_argument("--locales", default="es-AR", help="Comma-separated locales (column names).")
    p.add_argument("--image-source", choices=["gcs", "local"], default="gcs")
    p.add_argument("--gcs-bucket", default="levante-assets-dev",
                   help="GCS bucket for --image-source gcs (use levante-assets-prod for prod).")
    p.add_argument("--gcs-prefix", default="visual/same-different-selection/")
    p.add_argument("--image-dir", default="../../../core-task-assets/same-different-selection/original",
                   help="Comma-separated local image dir(s) for --image-source local.")
    p.add_argument("--corpus-csv", default=None,
                   help="Override the SDS item bank source (local path or URL). Default: live "
                        "gs://<gcs-bucket>/corpus/same-different-selection/same-different-selection-item-bank.csv.")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--output-dir", default="output")
    p.add_argument("--no-pdf", action="store_true", help="Skip rendering the report PDF.")
    args = p.parse_args()

    rows = load_translation_rows(args)
    tmap = build_en_tmap(rows)

    corpus_source = args.corpus_csv or sd_corpus_url(args.gcs_bucket)
    items = load_sd_items(corpus_source)
    print(f"[sds] item bank: {corpus_source}")
    if args.limit:
        items = items[:args.limit]
    locales = [l.strip() for l in args.locales.split(",") if l.strip()]
    resolver = ImageResolver(args.image_source, local_dirs=args.image_dir,
                             bucket=args.gcs_bucket, prefix=args.gcs_prefix,
                             cache_dir="output/gcs_samediff_cache")
    print(f"[sds] {len(resolver)} images indexed from {resolver.label}")
    print(f"[sds] {len(items)} single-select items in the bank.")

    ev = make_evaluator()
    all_rows: List[dict] = []
    n_missing_img = 0
    n_missing_tr = 0
    layout_cache: dict = {}
    from tqdm import tqdm
    for it in tqdm(items, desc="sds"):
        layout = resolve_layout(resolver, it, layout_cache)
        if layout is None:
            n_missing_img += 1
            continue
        trow = tmap.get(_norm_key(it["en_item"]))
        if trow is None:
            n_missing_tr += 1
            continue
        for loc in locales:
            sentence = ((trow.get(loc) if trow else "") or "").strip()
            if not sentence:
                continue
            all_rows.append(classify(ev, it, layout, it["en_item"], sentence, loc))

    n_guarded = apply_cross_locale_guard(all_rows)

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    field_order = ["locale", "item_id", "trial_type", "difficulty", "en_sentence", "translation",
                   "en_correct", "correct", "answer_key", "picked_key", "en_picked_key",
                   "gate_match", "gate_reason", "confidence", "reason", "tag", "guard"]

    def write_csv(path: Path, data: List[dict]) -> None:
        if not data:
            return
        with path.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=field_order, extrasaction="ignore")
            w.writeheader()
            w.writerows(data)

    for loc in locales:
        write_csv(out_dir / f"samediff-vision-{loc}.csv", [r for r in all_rows if r["locale"] == loc])
    write_csv(out_dir / "samediff-vision-all.csv", all_rows)
    report = out_dir / "samediff-vision-report.md"
    write_markdown_report(all_rows, report, locales)
    pdf = out_dir / "samediff-vision-report.pdf"
    pdf_ok = render_pdf(report, pdf, title="Same-Different Instruction-vs-Cards Vision Report") if not args.no_pdf else False

    n_tr = sum(1 for r in all_rows if r["tag"] == "translation_issue")
    n_im = len({r["item_id"] for r in all_rows if r["tag"] == "item_or_model"})
    for loc in locales:
        lr = [r for r in all_rows if r["locale"] == loc]
        bad = [r for r in lr if r["tag"] == "translation_issue"]
        ctrl = sum(1 for r in lr if r["tag"] == "item_or_model")
        print(f"\n[{loc}] {len(lr)} checked | {len(bad)} TRANSLATION ISSUE | "
              f"{ctrl} skipped (English control failed)")
        for r in bad:
            print(f"   BAD {r['item_id']:24} ({r['trial_type']}) '{r['translation']}'"
                  f"  vs {r['answer_key']}: gate says NO ({r['gate_reason']})")

    print(f"\n[done] {len(all_rows)} checks across {len(locales)} locale(s): "
          f"{n_tr} translation issues; {n_im} items failed the English control "
          f"(item/model, not translation); {n_guarded} lone miss(es) demoted to likely VLM "
          f"noise. {n_missing_img} skipped (missing image); {n_missing_tr} skipped (no translation).")
    print(f"       CSV -> {out_dir / 'samediff-vision-all.csv'}")
    print(f"       report -> {report}")
    if pdf_ok:
        print(f"       pdf -> {pdf}")
    return 0


def write_markdown_report(all_rows: List[dict], path: Path, locales: List[str]) -> None:
    """Translation issues first, then the cross-locale noise bucket, then English-control
    failures (language-independent item/model limits)."""
    by_item: Dict[str, List[dict]] = {}
    for r in all_rows:
        by_item.setdefault(r["item_id"], []).append(r)

    n_tr = sum(1 for r in all_rows if r["tag"] == "translation_issue")
    tr_items = sorted({r["item_id"] for r in all_rows if r["tag"] == "translation_issue"})
    noise_items = sorted({r["item_id"] for r in all_rows if r["tag"] == "likely_noise"})
    ctrl_items = sorted({r["item_id"] for r in all_rows if r["tag"] == "item_or_model"})

    lines = ["# Same-Different instruction-vs-cards vision report", ""]
    lines.append(f"- Locales checked: {', '.join(locales)}")
    lines.append(f"- Items checked: {len(by_item)}  ·  total checks: {len(all_rows)}  ·  "
                 f"translation issues: {n_tr}")
    lines.append("")
    lines.append("Each single-select item is run as the real 4-card forced choice with a vision "
                 "model, first for English (a control) then per locale. A miss is only a "
                 "**translation_issue** if a single-image confirmation gate — shown ONLY the keyed "
                 "card — agrees the translated instruction does NOT select it; a cross-locale guard "
                 "further demotes a lone locale miss to **likely VLM noise** when the control and a "
                 "majority of other locales solved it. **English-control failures** are "
                 "language-independent and listed separately.")
    lines.append("")

    def issue_table(tid: str, tag: str, why_header: str, why_fn) -> None:
        rs = [r for r in by_item[tid] if r["tag"] == tag]
        h = rs[0]
        d = h.get("difficulty", "")
        d_str = f", d={d}" if d != "" else ""
        lines.append(f"### {tid} ({h['trial_type']}{d_str}) — keyed `{h['answer_key']}`")
        lines.append("")
        keyed = img_md(h.get("image", ""), path.parent, alt=h["answer_key"], height=72)
        lines.append("| keyed card | source (English) | locale | translation | picked card | " + why_header + " |")
        lines.append("|---|---|---|---|---|---|")
        for i, r in enumerate(sorted(rs, key=lambda x: x["locale"])):
            pic = img_md(r.get("picked_image", ""), path.parent, alt=r["picked_key"], height=60)
            cell = f"{r['picked_key']}<br>{pic}" if pic else r["picked_key"]
            c_img = keyed if i == 0 else ""
            c_src = f"“{h['en_sentence']}”" if i == 0 else ""
            why = (why_fn(r) or "").replace("|", "\\|")
            lines.append(f"| {c_img} | {c_src} | {r['locale']} | {r['translation']} | {cell} | {why} |")
        lines.append("")

    lines.append(f"## Translation issues — {len(tr_items)} item(s)")
    lines.append("")
    if not tr_items:
        lines.append("_None._")
        lines.append("")
    for tid in tr_items:
        issue_table(tid, "translation_issue", "why (confirmation gate)",
                    lambda r: r["gate_reason"] or r["reason"])

    if noise_items:
        lines.append(f"## Likely VLM noise (suppressed) — {len(noise_items)} item(s)")
        lines.append("")
        lines.append("A single locale missed but the English control and a majority of the other "
                     "locales solved the same card — almost certainly per-run noise, not a "
                     "translation error. Listed for review; not counted as a translation issue.")
        lines.append("")
        for tid in noise_items:
            issue_table(tid, "likely_noise", "why suppressed", lambda r: r.get("guard", ""))

    lines.append(f"## English-control failures (item/model, not translation) — {len(ctrl_items)} item(s)")
    lines.append("")
    if not ctrl_items:
        lines.append("_None._")
        lines.append("")
    for tid in ctrl_items:
        h = by_item[tid][0]
        d = h.get("difficulty", "")
        d_str = f", d={d}" if d != "" else ""
        lines.append(f"- `{tid}` ({h['trial_type']}{d_str}) — “{h['en_sentence']}”: "
                     f"model picked `{h['en_picked_key']}` for English, keyed `{h['answer_key']}`.")
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
