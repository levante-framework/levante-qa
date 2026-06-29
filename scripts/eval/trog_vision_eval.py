#!/usr/bin/env python3
"""
TROG sentence->picture vision check: does the translated sentence still pick the
keyed picture among its (minimal-pair) distractors?

TROG (Test for Reception of Grammar) is a 4-alternative forced-choice grammar task:
the child hears one sentence and taps the one picture (of four) that matches its
meaning. The four pictures are deliberately *minimal pairs* on the grammatical
contrast being tested (who does what to whom, position, number, negation, passive,
etc.). That makes generic text metrics useless and makes the real criterion simple:
hearing the translated sentence, would a child still pick the keyed picture?

So we run the actual task with a vision model. For each item we show Gemini the four
choice images (shuffled) and the sentence, and it picks one. We do this first for the
ENGLISH sentence (a control) and then for each locale:

  - control FAILS (English doesn't resolve to the keyed picture)  -> item/model issue
    (the picture set or the model can't support even the English item; not a
    translation problem) -> tag `item_or_model`.
  - control PASSES but a locale FAILS -> the translation broke a solvable item
    (lost the grammatical contrast / picked a distractor) -> tag `translation_issue`.

This isolates translation problems from item/VLM noise and is exactly the
grammar-contrast-preservation test, operationalised by the pictures themselves.

Items + the keyed answer + distractor image keys + the grammatical `trial_type` come
from the TROG item bank; translations come live from Crowdin (default) or a saved CSV;
images come from the deployed GCS `visual/trog/` bucket (default) or a local dir.

    python trog_vision_eval.py --locales es-AR,de
"""

from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import random
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

from cache import JsonDirCache
from envload import load_env
from vocab_vision_eval import ImageResolver, img_md, load_translation_rows, render_pdf

PROMPT_VERSION = "trog-vision-v1"
LETTERS = ["A", "B", "C", "D", "E", "F"]
IMAGE_EXTS = [(".webp", "image/webp"), (".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".png", "image/png")]

PROMPT = """You are checking a grammar-comprehension test item for young children.
The child hears ONE sentence and must tap the ONE picture (of {n}) that matches its
meaning. The {n} pictures are labelled {labels}, shown above in that order.

Sentence ({locale}): "{sentence}"

The pictures are deliberately similar — they differ by who does what to whom, position
(in/on/above/below), number (one/many), negation, or active/passive role. Read the
sentence carefully and choose the single picture it describes.

Respond with ONLY a JSON object:
{{"choice": one of {labels},
  "confidence": 0.0-1.0,
  "reason": "one short sentence naming what the chosen picture shows"}}"""

# Confirmation gate. The 4-AFC alone has poor precision: the vision model often
# *understands* a correct translation but mis-grounds it to the wrong tile among the
# deliberately-similar pictures. So a 4-AFC miss is only treated as a real translation
# problem if the model, shown ONLY the keyed-correct picture, also says the translated
# sentence does not describe it. This single-image judgement is far more reliable.
CONFIRM_PROMPT = """You are checking a translated sentence from a grammar-comprehension
test for young children against the ONE picture it is meant to describe (the
keyed-correct picture for this item).

Sentence ({locale}): "{sentence}"

Does this sentence correctly describe THIS picture? Judge meaning, paying attention to
who does what to whom, position (in/on/above/below), number (one/many), and negation.
A correct sentence may be phrased differently than English as long as it truthfully
describes the picture. Answer "no" ONLY if the sentence does NOT truthfully describe
the picture (wrong roles, wrong position/number, missing or added negation, mistranslation).

Respond with ONLY a JSON object:
{{"match": "yes" | "no" | "uncertain",
  "confidence": 0.0-1.0,
  "reason": "one short sentence"}}"""


class TrogVisionEvaluator:
    def __init__(self, model_name: str = "gemini-2.5-flash", fallback_model: str = "gemini-flash-latest",
                 cache_dir: str = "output/trog_vision_cache", timeout: int = 120):
        load_env()
        import os
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise ValueError("GEMINI_API_KEY not set.")
        self.api_key = key
        self.model_name = model_name
        self.fallback_model = fallback_model
        self.timeout = timeout
        self.cache = JsonDirCache(cache_dir)

    def _endpoint(self, model: str) -> str:
        return (f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{model}:generateContent?key={self.api_key}")

    def _post(self, model: str, parts: List[dict]) -> str:
        payload = {
            "contents": [{"parts": parts}],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json",
                                 "thinkingConfig": {"thinkingBudget": 0}},
        }
        req = urllib.request.Request(self._endpoint(model), data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["candidates"][0]["content"]["parts"][0]["text"]

    def _call(self, parts: List[dict]) -> str:
        try:
            return self._post(self.model_name, parts)
        except urllib.error.HTTPError as exc:
            if self.fallback_model and exc.code in {400, 404, 429, 503}:
                return self._post(self.fallback_model, parts)
            raise

    def evaluate(self, item_id: str, sentence: str, locale: str, images: List[Path],
                 keys: List[str], max_retries: int = 3) -> Dict:
        n = len(images)
        labels = LETTERS[:n]
        key = JsonDirCache.make_key(PROMPT_VERSION, self.model_name, locale, item_id,
                                    sentence, ",".join(keys))
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        parts: List[dict] = []
        for letter, img in zip(labels, images):
            mime = next((m for ext, m in IMAGE_EXTS if img.suffix.lower() == ext), "image/webp")
            parts.append({"text": f"Picture {letter}:"})
            parts.append({"inline_data": {"mime_type": mime,
                                          "data": base64.b64encode(img.read_bytes()).decode("ascii")}})
        prompt = PROMPT.format(n=n, labels="/".join(labels), locale=locale, sentence=sentence)
        parts.append({"text": prompt})
        last = ""
        for attempt in range(max_retries):
            try:
                p = json.loads(self._call(parts))
                choice = str(p.get("choice", "")).strip().upper()[:1]
                idx = labels.index(choice) if choice in labels else -1
                result = {"ok": idx >= 0, "choice_index": idx,
                          "confidence": p.get("confidence"),
                          "reason": str(p.get("reason", "") or ""), "error": None}
                self.cache.set(key, result)
                return result
            except json.JSONDecodeError as exc:
                last = f"JSON parse: {exc}"
            except Exception as exc:  # noqa: BLE001
                last = f"{type(exc).__name__}: {exc}"
            time.sleep(2 ** attempt)
        return {"ok": False, "choice_index": -1, "confidence": None, "reason": "", "error": last}

    def confirm(self, item_id: str, sentence: str, locale: str, image: Path,
                max_retries: int = 3) -> Dict:
        """Single-image gate: does `sentence` truthfully describe the keyed picture?
        Used to confirm a 4-AFC miss is a real translation error, not a grounding glitch."""
        key = JsonDirCache.make_key(PROMPT_VERSION, "confirm", self.model_name, locale,
                                    item_id, sentence, image.name)
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        mime = next((m for ext, m in IMAGE_EXTS if image.suffix.lower() == ext), "image/webp")
        parts = [{"inline_data": {"mime_type": mime,
                                  "data": base64.b64encode(image.read_bytes()).decode("ascii")}},
                 {"text": CONFIRM_PROMPT.format(locale=locale, sentence=sentence)}]
        last = ""
        for attempt in range(max_retries):
            try:
                p = json.loads(self._call(parts))
                match = str(p.get("match", "")).strip().lower()
                if match not in ("yes", "no", "uncertain"):
                    match = "uncertain"
                result = {"ok": True, "match": match, "confidence": p.get("confidence"),
                          "reason": str(p.get("reason", "") or ""), "error": None}
                self.cache.set(key, result)
                return result
            except json.JSONDecodeError as exc:
                last = f"JSON parse: {exc}"
            except Exception as exc:  # noqa: BLE001
                last = f"{type(exc).__name__}: {exc}"
            time.sleep(2 ** attempt)
        return {"ok": False, "match": "uncertain", "confidence": None, "reason": "", "error": last}


TROG_ITEM_RE = re.compile(r"(trog-item-\d+)")


def _tid(item_id: str) -> Optional[str]:
    m = TROG_ITEM_RE.search(item_id or "")
    return m.group(1) if m else None


def _item_num(tid: str) -> int:
    m = re.search(r"(\d+)", tid)
    return int(m.group(1)) if m else 0


def trog_corpus_url(bucket: str = "levante-assets-dev") -> str:
    """The deployed TROG item bank — exactly what the task-launcher pulls at runtime
    (see core-tasks getCorpus.ts / constants.ts)."""
    return f"https://storage.googleapis.com/{bucket}/corpus/trog/trog-item-bank.csv"


def _read_corpus_text(source: str) -> str:
    if source.startswith(("http://", "https://")):
        with urllib.request.urlopen(source, timeout=60) as r:
            return r.read().decode("utf-8-sig")
    return Path(source).read_text(encoding="utf-8-sig")


def load_trog_items(corpus_source: str) -> List[dict]:
    """One dict per scored TROG item: id, keyed answer image key, distractor keys,
    grammatical trial_type, difficulty d, and the English reference sentence.
    `corpus_source` is a local path or an https URL (the deployed corpus bucket)."""
    out: List[dict] = []
    for r in csv.DictReader(io.StringIO(_read_corpus_text(corpus_source))):
        tid = (r.get("audio_file") or r.get("item_id") or "").strip()
        ttype = (r.get("trial_type") or "").strip()
        answer = (r.get("answer") or "").strip().split(",")[0].strip()
        if not tid.startswith("trog-item-") or ttype in ("", "instructions") or not answer:
            continue
        alts = [a.strip() for a in (r.get("response_alternatives") or "").split(",") if a.strip()]
        d = (r.get("d") or "").strip()
        out.append({"item_id": tid, "answer": answer, "distractors": alts,
                    "trial_type": ttype, "d": float(d) if d else None,
                    "en_item": (r.get("item") or "").strip()})
    return out


def build_choice_layout(item: dict, seed_salt: int = 0) -> tuple[List[str], int]:
    """Deterministically shuffle [answer, *distractors] so the layout is identical
    across English and every locale (no position-bias leakage). Returns the ordered
    image keys and the index of the keyed-correct one."""
    choices = [item["answer"]] + item["distractors"]
    order = list(range(len(choices)))
    random.Random(_item_num(item["item_id"]) * 1009 + seed_salt).shuffle(order)
    keys = [choices[i] for i in order]
    return keys, order.index(0)


def resolve_layout(resolver, item: dict, cache: Optional[dict] = None):
    """Resolve an item's choice images and fixed layout once. Returns
    (ordered_keys, answer_index, ordered_image_paths, keyed_image_path) or None if any
    image is missing. Optional per-item cache so callers can reuse across locales."""
    if cache is not None and item["item_id"] in cache:
        return cache[item["item_id"]]
    choices = [item["answer"]] + item["distractors"]
    paths = {k: resolver.resolve(k) for k in choices}
    if any(paths[k] is None for k in choices):
        result = None
    else:
        keys, answer_idx = build_choice_layout(item)
        result = (keys, answer_idx, [paths[k] for k in keys], paths[item["answer"]])
    if cache is not None:
        cache[item["item_id"]] = result
    return result


def classify(ev: "TrogVisionEvaluator", item: dict, layout, en_sentence: str,
             sentence: str, locale: str) -> dict:
    """Run the 4-AFC (locale + English control) and, on a miss, the single-image
    confirmation gate, then apply the precision rule:
      - English control fails  -> `item_or_model` (picture/model issue, not translation)
      - control OK + gate "no"  -> `translation_issue`
      - otherwise               -> "" (correct, or a mere grounding glitch)
    Returns a full result row shared by the standalone report and review_queue."""
    keys, answer_idx, images, keyed_img = layout
    en = ev.evaluate(item["item_id"], en_sentence, "en", images, keys)
    en_ok = en["choice_index"] == answer_idx
    res = ev.evaluate(item["item_id"], sentence, locale, images, keys)
    loc_ok = res["choice_index"] == answer_idx
    picked = keys[res["choice_index"]] if res["choice_index"] >= 0 else "(none)"
    gate_match, gate_reason = "", ""
    if loc_ok:
        tag = ""
    else:
        gate = ev.confirm(item["item_id"], sentence, locale, keyed_img)
        gate_match, gate_reason = gate["match"], gate["reason"]
        if not en_ok:
            tag = "item_or_model"
        elif gate_match == "no":
            tag = "translation_issue"
        else:
            tag = ""
    return {
        "locale": locale, "item_id": item["item_id"], "trial_type": item["trial_type"],
        "difficulty": "" if item["d"] is None else round(item["d"], 4),
        "en_sentence": en_sentence, "translation": sentence,
        "en_correct": int(en_ok), "correct": int(loc_ok),
        "answer_key": item["answer"], "picked_key": picked,
        "en_picked_key": keys[en["choice_index"]] if en["choice_index"] >= 0 else "(none)",
        "image": str(keyed_img), "picked_image": str(images[res["choice_index"]]) if res["choice_index"] >= 0 else "",
        "gate_match": gate_match, "gate_reason": gate_reason,
        "confidence": res["confidence"], "reason": res["reason"], "tag": tag, "guard": "",
    }


def apply_cross_locale_guard(all_rows: List[dict], min_other_correct: int = 2) -> int:
    """Demote a lone `translation_issue` to `likely_noise` when the SAME keyed picture is
    solved correctly by the English control AND a strict majority of the OTHER locales for
    that item. A real translation error would not be contradicted by so many correct
    siblings; a single miss on a deliberately-similar minimal pair is almost always per-run
    VLM grounding noise (the confirmation gate can repeat the same misread of the picture).
    Returns the number of rows demoted. No-op when an item has only one locale."""
    by_item: Dict[str, List[dict]] = {}
    for r in all_rows:
        by_item.setdefault(r["item_id"], []).append(r)
    demoted = 0
    for rs in by_item.values():
        n = len(rs)
        for r in rs:
            if r["tag"] != "translation_issue" or not int(r["en_correct"]):
                continue
            others_ok = sum(int(x["correct"]) for x in rs if x is not r)
            if others_ok >= min_other_correct and others_ok > (n - 1) / 2:
                r["tag"] = "likely_noise"
                r["guard"] = f"solved by English control + {others_ok}/{n - 1} other locales"
                demoted += 1
    return demoted


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="TROG sentence-vs-pictures vision check (4-AFC + English control).")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--from-crowdin", action="store_true",
                     help="(Default) Pull approved translations live from Crowdin.")
    src.add_argument("--translations-csv", default=None,
                     help="Use a saved Crowdin export CSV instead of pulling live.")
    p.add_argument("--locales", default="es-AR", help="Comma-separated locales (column names).")
    p.add_argument("--image-source", choices=["gcs", "local"], default="gcs",
                   help="Where choice images come from (default: deployed GCS visual bucket).")
    p.add_argument("--gcs-bucket", default="levante-assets-dev",
                   help="GCS bucket for --image-source gcs (use levante-assets-prod for prod).")
    p.add_argument("--gcs-prefix", default="visual/trog/")
    p.add_argument("--image-dir", default="../../../core-task-assets/TROG/original",
                   help="Comma-separated local image dir(s) for --image-source local.")
    p.add_argument("--corpus-csv", default=None,
                   help="Override the TROG item bank source (local path or URL). Default: pull "
                        "live from the deployed corpus, gs://<gcs-bucket>/corpus/trog/trog-item-bank.csv.")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--output-dir", default="output")
    p.add_argument("--no-pdf", action="store_true", help="Skip rendering the report PDF.")
    args = p.parse_args()

    rows = load_translation_rows(args)
    tmap = {}
    for r in rows:
        if "sentence-understanding" not in (r.get("item_id", "") + r.get("_path", "")):
            continue
        tid = _tid(r.get("item_id", "") or r.get("identifier", ""))
        if tid:
            tmap[tid] = r

    corpus_source = args.corpus_csv or trog_corpus_url(args.gcs_bucket)
    items = load_trog_items(corpus_source)
    print(f"[trog] item bank: {corpus_source}")
    if args.limit:
        items = items[:args.limit]
    resolver = ImageResolver(args.image_source, local_dirs=args.image_dir,
                             bucket=args.gcs_bucket, prefix=args.gcs_prefix,
                             cache_dir="output/gcs_trog_cache")
    print(f"[trog] {len(resolver)} images indexed from {resolver.label}")
    print(f"[trog] {len(items)} scored items in the bank; {len(tmap)} have translations.")

    locales = [l.strip() for l in args.locales.split(",") if l.strip()]
    ev = TrogVisionEvaluator()

    all_rows: List[dict] = []
    n_missing_img = 0
    layout_cache: dict = {}
    from tqdm import tqdm
    for it in tqdm(items, desc="trog"):
        layout = resolve_layout(resolver, it, layout_cache)
        if layout is None:
            n_missing_img += 1
            continue
        en_sentence = (tmap.get(it["item_id"], {}).get("en") or it["en_item"]).strip()
        for loc in locales:
            row = tmap.get(it["item_id"])
            sentence = ((row.get(loc) if row else "") or "").strip()
            if not sentence:
                continue
            all_rows.append(classify(ev, it, layout, en_sentence, sentence, loc))

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
        write_csv(out_dir / f"trog-vision-{loc}.csv", [r for r in all_rows if r["locale"] == loc])
    write_csv(out_dir / "trog-vision-all.csv", all_rows)
    report = out_dir / "trog-vision-report.md"
    write_markdown_report(all_rows, report, locales)
    pdf = out_dir / "trog-vision-report.pdf"
    pdf_ok = render_pdf(report, pdf, title="TROG Sentence-vs-Pictures Vision Report") if not args.no_pdf else False

    n_tr = sum(1 for r in all_rows if r["tag"] == "translation_issue")
    n_im = len({r["item_id"] for r in all_rows if r["tag"] == "item_or_model"})
    for loc in locales:
        lr = [r for r in all_rows if r["locale"] == loc]
        bad = [r for r in lr if r["tag"] == "translation_issue"]
        ctrl = sum(1 for r in lr if r["tag"] == "item_or_model")
        print(f"\n[{loc}] {len(lr)} checked | {len(bad)} TRANSLATION ISSUE | "
              f"{ctrl} skipped (English control failed)")
        for r in bad:
            print(f"   BAD {r['item_id']:14} ({r['trial_type']}) '{r['translation']}'"
                  f"  vs {r['answer_key']}: gate says NO ({r['gate_reason']})")

    print(f"\n[done] {len(all_rows)} checks across {len(locales)} locale(s): "
          f"{n_tr} translation issues; {n_im} items failed the English control "
          f"(item/model, not translation); {n_guarded} lone miss(es) demoted to likely VLM "
          f"noise by the cross-locale guard. {n_missing_img} items skipped (missing image).")
    print(f"       CSV -> {out_dir / 'trog-vision-all.csv'}")
    print(f"       report -> {report}")
    if pdf_ok:
        print(f"       pdf -> {pdf}")
    return 0


def write_markdown_report(all_rows: List[dict], path: Path, locales: List[str]) -> None:
    """Human-readable report: translation issues first (control passed, locale failed),
    then English-control failures (language-independent item/model limits)."""
    by_item: Dict[str, List[dict]] = {}
    for r in all_rows:
        by_item.setdefault(r["item_id"], []).append(r)

    n_items = len(by_item)
    n_tr = sum(1 for r in all_rows if r["tag"] == "translation_issue")
    ctrl_items = sorted({r["item_id"] for r in all_rows if r["tag"] == "item_or_model"}, key=_item_num)

    lines = ["# TROG sentence-vs-pictures vision report", ""]
    lines.append(f"- Locales checked: {', '.join(locales)}")
    lines.append(f"- Items checked: {n_items}  ·  total checks: {len(all_rows)}  ·  "
                 f"translation issues: {n_tr}")
    lines.append("")
    lines.append("Each item is run as the real 4-picture forced choice with a vision model, "
                 "first for English (a control) then per locale. A miss is only a "
                 "**translation_issue** if a single-image confirmation gate — shown ONLY the "
                 "keyed picture — agrees the translated sentence does NOT truthfully describe "
                 "it (this filters out cases where the model understands a correct translation "
                 "but mis-grounds it among the deliberately-similar tiles). "
                 "**English-control failures** are language-independent (the picture set or "
                 "the model can't resolve even the English item) and are listed separately. "
                 "A cross-locale guard further demotes a lone locale miss to **likely VLM "
                 "noise** when the English control and a majority of the other locales solved "
                 "the same keyed picture.")
    lines.append("")

    tr_items = sorted({r["item_id"] for r in all_rows if r["tag"] == "translation_issue"}, key=_item_num)
    lines.append(f"## Translation issues — {len(tr_items)} item(s)")
    lines.append("")
    if not tr_items:
        lines.append("_None._")
        lines.append("")
    for tid in tr_items:
        rs = [r for r in by_item[tid] if r["tag"] == "translation_issue"]
        h = rs[0]
        d = h.get("difficulty", "")
        d_str = f", d={d}" if d != "" else ""
        lines.append(f"### {tid} ({h['trial_type']}{d_str}) — keyed `{h['answer_key']}`")
        lines.append("")
        keyed = img_md(h.get("image", ""), path.parent, alt=h["answer_key"], height=72)
        rs_sorted = sorted(rs, key=lambda x: x["locale"])
        lines.append("| keyed picture | source (English) | locale | translation | picked picture | why (confirmation gate) |")
        lines.append("|---|---|---|---|---|---|")
        for i, r in enumerate(rs_sorted):
            why = (r["gate_reason"] or r["reason"] or "").replace("|", "\\|")
            pic = img_md(r.get("picked_image", ""), path.parent, alt=r["picked_key"], height=60)
            cell = f"{r['picked_key']}<br>{pic}" if pic else r["picked_key"]
            c_img = keyed if i == 0 else ""
            c_src = f"“{h['en_sentence']}”" if i == 0 else ""
            lines.append(f"| {c_img} | {c_src} | {r['locale']} | {r['translation']} | {cell} | {why} |")
        lines.append("")

    noise_items = sorted({r["item_id"] for r in all_rows if r["tag"] == "likely_noise"}, key=_item_num)
    if noise_items:
        lines.append(f"## Likely VLM noise (suppressed) — {len(noise_items)} item(s)")
        lines.append("")
        lines.append("A single locale missed the 4-AFC and the gate agreed, but the English control "
                     "and a majority of the other locales solved the SAME keyed picture — so the "
                     "lone miss is almost certainly per-run grounding noise, not a translation "
                     "error. Listed for review; not counted as a translation issue.")
        lines.append("")
        for tid in noise_items:
            rs = [r for r in by_item[tid] if r["tag"] == "likely_noise"]
            h = rs[0]
            d = h.get("difficulty", "")
            d_str = f", d={d}" if d != "" else ""
            lines.append(f"### {tid} ({h['trial_type']}{d_str}) — keyed `{h['answer_key']}`")
            lines.append("")
            keyed = img_md(h.get("image", ""), path.parent, alt=h["answer_key"], height=72)
            rs_sorted = sorted(rs, key=lambda x: x["locale"])
            lines.append("| keyed picture | source (English) | locale | translation | picked picture | why suppressed |")
            lines.append("|---|---|---|---|---|---|")
            for i, r in enumerate(rs_sorted):
                pic = img_md(r.get("picked_image", ""), path.parent, alt=r["picked_key"], height=60)
                cell = f"{r['picked_key']}<br>{pic}" if pic else r["picked_key"]
                c_img = keyed if i == 0 else ""
                c_src = f"“{h['en_sentence']}”" if i == 0 else ""
                lines.append(f"| {c_img} | {c_src} | {r['locale']} | {r['translation']} | {cell} | {r.get('guard', '')} |")
            lines.append("")

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
