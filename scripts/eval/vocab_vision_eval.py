#!/usr/bin/env python3
"""
Vocab-specific check: does the translated word actually name the pictured object?

The picture-vocabulary task shows the child four images and speaks one word; they
must tap the matching picture. So the translation is correct iff the translated
word names the keyed answer image. Text-only metrics (COMET/E5) are unreliable on
single words and over-flag correct ones (e.g. coaster->posavasos), while missing
picture mismatches (scoop->cucharon). A vision model judging word-vs-image is the
right signal here.

For each vocab item we send Gemini the answer image + the translated word and ask
whether the word names the main object, returning a structured verdict. Results
are cached (resume-safe) like the MQM pass.

Translations (English + per-locale word) come from the Crowdin corpus; the answer
image is resolved from the English word against the deployed GCS `visual/vocab`
bucket (default) or a local asset dir, matching names case/separator-insensitively.

    python vocab_vision_eval.py --locales es-AR,de,nl,es-CO,fr-CA
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

from cache import JsonDirCache
from envload import load_env

PROMPT_VERSION = "vocab-vision-v1"
IMAGE_EXTS = [(".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".webp", "image/webp"), (".png", "image/png")]

PROMPT = """You are checking a picture-vocabulary test item for young children.
The child sees this image and hears ONE word; they must tap the picture the word names.

The English word for the keyed-correct picture is: "{en_word}".
The translation being checked (in {locale}) is: "{word}".

Looking ONLY at the image, decide whether the {locale} word "{word}" correctly and
naturally names the MAIN object shown — well enough that a {locale}-speaking child
would confidently pick this picture when they hear that word.

Respond with ONLY a JSON object:
{{"match": "yes" | "no" | "uncertain",
  "object_in_locale": "the most natural {locale} name for the object shown",
  "confidence": 0.0-1.0,
  "reason": "one short sentence"}}"""


class VocabVisionEvaluator:
    def __init__(self, model_name: str = "gemini-2.5-flash", fallback_model: str = "gemini-flash-latest",
                 cache_dir: str = "output/vocab_vision_cache", timeout: int = 90):
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

    def _post(self, model: str, prompt: str, img_b64: str, mime: str) -> str:
        payload = {
            "contents": [{"parts": [
                {"inline_data": {"mime_type": mime, "data": img_b64}},
                {"text": prompt},
            ]}],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json",
                                 "thinkingConfig": {"thinkingBudget": 0}},
        }
        req = urllib.request.Request(self._endpoint(model), data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["candidates"][0]["content"]["parts"][0]["text"]

    def _call(self, prompt: str, img_b64: str, mime: str) -> str:
        try:
            return self._post(self.model_name, prompt, img_b64, mime)
        except urllib.error.HTTPError as exc:
            if self.fallback_model and exc.code in {400, 404, 429, 503}:
                return self._post(self.fallback_model, prompt, img_b64, mime)
            raise

    def evaluate(self, en_word: str, word: str, locale: str, image_path: Path,
                 max_retries: int = 3) -> Dict:
        mime = next((m for ext, m in IMAGE_EXTS if image_path.suffix.lower() == ext), "image/jpeg")
        img_bytes = image_path.read_bytes()
        key = JsonDirCache.make_key(PROMPT_VERSION, self.model_name, locale, en_word, word,
                                    str(len(img_bytes)))
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        img_b64 = base64.b64encode(img_bytes).decode("ascii")
        prompt = PROMPT.format(en_word=en_word, word=word, locale=locale)
        last = ""
        for attempt in range(max_retries):
            try:
                raw = self._call(prompt, img_b64, mime)
                p = json.loads(raw)
                match = str(p.get("match", "")).strip().lower()
                if match not in ("yes", "no", "uncertain"):
                    match = "uncertain"
                result = {"ok": True, "match": match,
                          "object_in_locale": str(p.get("object_in_locale", "") or ""),
                          "confidence": p.get("confidence"),
                          "reason": str(p.get("reason", "") or ""), "error": None}
                self.cache.set(key, result)
                return result
            except json.JSONDecodeError as exc:
                last = f"JSON parse: {exc}"
            except Exception as exc:  # noqa: BLE001
                last = f"{type(exc).__name__}: {exc}"
            time.sleep(2 ** attempt)
        return {"ok": False, "match": "uncertain", "object_in_locale": "", "confidence": None,
                "reason": "", "error": last}


VOCAB_ITEM_RE = re.compile(r"vocab\.xliff::(vocab-item-\d+)")


def _vid(item_id: str) -> Optional[str]:
    m = VOCAB_ITEM_RE.search(item_id or "")
    if m:
        return m.group(1)
    m = re.search(r"(vocab-item-\d+)", item_id or "")
    return m.group(1) if m else None


def normalize_en(en_raw: Optional[str], fallback: str = "") -> str:
    """The corpus English source word, minus a leading article (e.g. 'the turnstile'
    -> 'turnstile'). This is the keyed answer word; the picture is resolved from it."""
    en = (en_raw or "").strip()
    for art in ("the ", "a ", "an "):
        if en.lower().startswith(art):
            en = en[len(art):].strip()
            break
    return en or fallback


def _norm_key(s: str) -> str:
    """Collapse a word/filename stem to a comparison key, ignoring case and
    separators so 'rubber band', 'rubberBand', 'rubber_band' all match."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def build_image_index(img_dirs) -> Dict[str, Path]:
    """Scan image dir(s) once and index by normalized stem. Replaces the legacy
    filenames.csv map: images are matched to the corpus word, not a stale asset map.

    Accepts a single path or a comma-separated string / iterable of dirs; earlier
    dirs win on collision (so `original/` source images take precedence over the
    derived `images/` copies, which only fill gaps like the corrected turnstile)."""
    if isinstance(img_dirs, (str, Path)):
        img_dirs = str(img_dirs).split(",")
    exts = {ext for ext, _ in IMAGE_EXTS}
    index: Dict[str, Path] = {}
    for d in img_dirs:
        d = Path(str(d).strip())
        if not d.is_dir():
            continue
        for p in sorted(d.iterdir()):
            if p.suffix.lower() in exts:
                index.setdefault(_norm_key(p.stem), p)
    return index


def resolve_image(index: Dict[str, Path], word: str) -> Optional[Path]:
    """Find the answer image for an English word via the normalized index."""
    return index.get(_norm_key(word))


_EXT_RANK = {".webp": 0, ".jpg": 1, ".jpeg": 2, ".png": 3}


def _gcs_list(bucket: str, prefix: str) -> List[str]:
    """All object names under a public GCS bucket prefix (paginated)."""
    names: List[str] = []
    token = ""
    while True:
        url = (f"https://storage.googleapis.com/storage/v1/b/{bucket}/o"
               f"?prefix={urllib.parse.quote(prefix)}&maxResults=1000")
        if token:
            url += f"&pageToken={token}"
        with urllib.request.urlopen(url, timeout=60) as r:
            data = json.load(r)
        names += [it["name"] for it in data.get("items", [])]
        token = data.get("nextPageToken")
        if not token:
            return names


class ImageResolver:
    """Resolves an English vocab word to a local image file, from either the local
    asset repo or the deployed GCS `visual/<task>` bucket (downloaded + cached).

    GCS is the truer source — it is exactly what children are served — and is
    independent of whatever happens to be checked out locally."""

    def __init__(self, source: str = "gcs", local_dirs: str = "",
                 bucket: str = "levante-assets-dev", prefix: str = "visual/vocab/",
                 cache_dir: str = "output/gcs_vocab_cache"):
        self.source = source
        if source == "local":
            self.index = build_image_index(local_dirs)
            self.label = local_dirs
            return
        self.bucket = bucket
        self.cache = Path(cache_dir)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.label = f"gs://{bucket}/{prefix}"
        exts = set(_EXT_RANK)
        objs = [n for n in _gcs_list(bucket, prefix) if Path(n).suffix.lower() in exts]
        objs.sort(key=lambda n: _EXT_RANK.get(Path(n).suffix.lower(), 9))  # webp wins
        self.gcs_index: Dict[str, str] = {}
        for n in objs:
            self.gcs_index.setdefault(_norm_key(Path(n).stem), n)

    def __len__(self) -> int:
        return len(self.index if self.source == "local" else self.gcs_index)

    def resolve(self, word: str) -> Optional[Path]:
        key = _norm_key(word)
        if self.source == "local":
            return self.index.get(key)
        name = self.gcs_index.get(key)
        if not name:
            return None
        dest = self.cache / Path(name).name
        if dest.is_file() and dest.stat().st_size > 0:
            return dest
        try:
            with urllib.request.urlopen(f"https://storage.googleapis.com/{self.bucket}/"
                                        f"{urllib.parse.quote(name)}", timeout=60) as r:
                data = r.read()
            dest.write_bytes(data)
            return dest
        except (urllib.error.URLError, OSError):
            return None


def load_translation_rows(args) -> List[dict]:
    if args.from_crowdin:
        from crowdin_source import fetch_approved_rows
        rows, _ = fetch_approved_rows(approved_only=True)
        return rows
    return list(csv.DictReader(open(args.translations_csv, encoding="utf-8")))


def run_locale(ev: "VocabVisionEvaluator", rows: List[dict], locale: str,
               resolver: "ImageResolver", limit: int) -> List[dict]:
    items = []
    for r in rows:
        vid = _vid(r.get("item_id") or r.get("identifier") or "")
        if not vid:
            continue
        word = (r.get(locale) or "").strip()
        if not word:
            continue
        # Both the English keyed word and the image come from the corpus word
        # (`en`), so a stale asset name can't desync them.
        en_word = normalize_en(r.get("en"))
        img = resolver.resolve(en_word) if en_word else None
        if img:
            items.append({"vid": vid, "en_word": en_word, "word": word, "image": img})
    if limit:
        items = items[:limit]
    out = []
    for it in items:
        res = ev.evaluate(it["en_word"], it["word"], locale, it["image"])
        out.append({"locale": locale, "item_id": f"vocab.xliff::{it['vid']}", "vid": it["vid"],
                    "en_word": it["en_word"], "translation": it["word"], "vision_match": res["match"],
                    "object_in_locale": res["object_in_locale"], "confidence": res["confidence"],
                    "reason": res["reason"]})
    return out


def tag_mismatches(all_rows: List[dict], source_min_locales: int) -> None:
    """Tag each mismatch by its cross-locale spread (mutates rows, adds 'tag').

    A vid that mismatches in (nearly) every locale it was checked in is almost
    always a SOURCE/ITEM problem — the shared English keyword doesn't match the
    picture, or the word is too abstract to name an object — so the translation is
    not the thing to fix. A vid that mismatches in only some locales is a real
    per-locale TRANSLATION issue (the picture is fine; that language's word is off).
    """
    by_vid: Dict[str, List[dict]] = {}
    for r in all_rows:
        by_vid.setdefault(r["vid"], []).append(r)
    for vid, rs in by_vid.items():
        n_checked = len(rs)
        bad = [r for r in rs if r["vision_match"] == "no"]
        n_bad = len(bad)
        threshold = source_min_locales if source_min_locales > 0 else n_checked
        source_wide = n_bad >= 2 and n_bad >= threshold
        for r in rs:
            r["n_locales_checked"] = n_checked
            r["n_locales_mismatch"] = n_bad
            if r["vision_match"] == "no":
                r["tag"] = "source_image_issue" if source_wide else "translation_issue"
            else:
                r["tag"] = ""


def write_markdown_report(all_rows: List[dict], path: Path, locales: List[str]) -> None:
    """Human-readable report grouped by tag, one block per vocab item."""
    bad = [r for r in all_rows if r["vision_match"] == "no"]
    by_vid: Dict[str, List[dict]] = {}
    for r in bad:
        by_vid.setdefault(r["vid"], []).append(r)

    def vid_num(vid: str) -> int:
        try:
            return int(vid.rsplit("-", 1)[-1])
        except ValueError:
            return 0

    n_items = len({r["vid"] for r in all_rows})
    lines = ["# Vocab word-vs-image vision report", ""]
    lines.append(f"- Locales checked: {', '.join(locales)}")
    lines.append(f"- Vocab items: {n_items}  ·  total checks: {len(all_rows)}  ·  mismatches: {len(bad)}")
    lines.append(f"- Distinct items with a mismatch: {len(by_vid)}")
    lines.append("")
    lines.append("**source_image_issue** = the shared picture/English keyword is the problem "
                 "(fails across locales) — fix the item, not the translation. "
                 "**translation_issue** = locale-specific; the picture is fine but that "
                 "language's word is wrong/too narrow.")
    lines.append("")

    groups = [
        ("source_image_issue", "Source / item issues (fix the picture or English keyword)"),
        ("translation_issue", "Translation issues (fix the per-locale word)"),
    ]
    for tag, title in groups:
        vids = sorted({r["vid"] for r in bad if r["tag"] == tag}, key=vid_num)
        lines.append(f"## {title} — {len(vids)} item(s)")
        lines.append("")
        if not vids:
            lines.append("_None._")
            lines.append("")
            continue
        for vid in vids:
            rs = sorted(by_vid[vid], key=lambda r: r["locale"])
            en = rs[0]["en_word"]
            checked = next((r["n_locales_checked"] for r in all_rows if r["vid"] == vid), len(locales))
            lines.append(f"### {vid} — “{en}”  ({len(rs)}/{checked} locales)")
            lines.append("")
            lines.append("| locale | translation | model sees | why |")
            lines.append("|---|---|---|---|")
            for r in rs:
                why = (r["reason"] or "").replace("|", "\\|")
                lines.append(f"| {r['locale']} | {r['translation']} | {r['object_in_locale']} | {why} |")
            lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Vision check: does the translated word name the pictured object?")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--translations-csv", default="output/crowdin-approved.csv",
                     help="Merged Crowdin CSV (item_id + per-locale columns, incl. `en`).")
    src.add_argument("--from-crowdin", action="store_true")
    p.add_argument("--image-source", choices=["gcs", "local"], default="gcs",
                   help="Where answer images come from (default: deployed GCS visual bucket).")
    p.add_argument("--gcs-bucket", default="levante-assets-dev",
                   help="GCS bucket for --image-source gcs (use levante-assets-prod for prod).")
    p.add_argument("--gcs-prefix", default="visual/vocab/")
    p.add_argument("--image-dir",
                   default="../../../core-task-assets/vocab/original,../../../core-task-assets/vocab/images",
                   help="Comma-separated local image dir(s) for --image-source local.")
    p.add_argument("--locales", default="es-AR", help="Comma-separated locales (column names).")
    p.add_argument("--source-min-locales", type=int, default=0,
                   help="Mismatches in >= this many locales are tagged source_image_issue "
                        "(0 = all locales the item was checked in).")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--output-dir", default="output")
    args = p.parse_args()

    rows = load_translation_rows(args)
    resolver = ImageResolver(args.image_source, local_dirs=args.image_dir,
                             bucket=args.gcs_bucket, prefix=args.gcs_prefix)
    locales = [l.strip() for l in args.locales.split(",") if l.strip()]
    print(f"[vision] {len(resolver)} images indexed from {resolver.label}")

    ev = VocabVisionEvaluator()
    all_rows: List[dict] = []
    for loc in locales:
        res = run_locale(ev, rows, loc, resolver, args.limit)
        bad = [r for r in res if r["vision_match"] == "no"]
        unc = sum(1 for r in res if r["vision_match"] == "uncertain")
        print(f"\n[{loc}] {len(res)} checked | {len(bad)} MISMATCH | {unc} uncertain")
        for r in bad:
            print(f"   BAD {r['vid']:16} '{r['en_word']}' -> '{r['translation']}'"
                  f"   model sees: '{r['object_in_locale']}'  ({r['reason']})")
        all_rows.extend(res)

    tag_mismatches(all_rows, args.source_min_locales)

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    field_order = ["locale", "item_id", "vid", "en_word", "translation", "vision_match",
                   "object_in_locale", "confidence", "reason", "tag",
                   "n_locales_mismatch", "n_locales_checked"]

    def write_csv(path: Path, data: List[dict]) -> None:
        if not data:
            return
        with path.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=field_order, extrasaction="ignore")
            w.writeheader()
            w.writerows(data)

    for loc in locales:
        write_csv(out_dir / f"vocab-vision-{loc}.csv", [r for r in all_rows if r["locale"] == loc])
    write_csv(out_dir / "vocab-vision-all.csv", all_rows)

    report = out_dir / "vocab-vision-report.md"
    write_markdown_report(all_rows, report, locales)

    total_bad = sum(1 for r in all_rows if r["vision_match"] == "no")
    n_src = len({r["vid"] for r in all_rows if r["tag"] == "source_image_issue"})
    n_tr = len({r["vid"] for r in all_rows if r["tag"] == "translation_issue"})
    print(f"\n[done] {len(all_rows)} checks across {len(locales)} locale(s), "
          f"{total_bad} mismatch(es): {n_src} source/item, {n_tr} translation.")
    print(f"       CSV -> {out_dir / 'vocab-vision-all.csv'}")
    print(f"       report -> {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
