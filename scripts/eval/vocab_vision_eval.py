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
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

from cache import JsonDirCache
from envload import load_env

PROMPT_VERSION = "vocab-vision-v3"
IMAGE_EXTS = [(".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".webp", "image/webp"), (".png", "image/png")]

PROMPT = """You are checking a picture-vocabulary test item for young children.
This is a four-choice task: the child sees FOUR pictures, hears ONE word, and taps the
picture that word names. You are shown the KEYED-CORRECT picture for this item.

The English word for it is: "{en_word}".
The translation being checked (in {locale}) is: "{word}".
The other three options the child can choose from are: {distractors}.

The translation WORKS if, hearing "{word}", a {locale}-speaking child would pick THIS
picture rather than the other three. That needs both:
  (1) "{word}" names — or is clearly the best match for — the object shown, and
  (2) "{word}" does not equally fit any of the other three options.

A broader/category word (e.g. "percussion" for a hi-hat) is FINE as long as it still
points to this picture and to none of the other three. Answer "no" ONLY for a real
problem: the word names a different object than the one shown, is a mistranslation, or
is ambiguous because it also fits one of the other three options (say which).
{hard_note}
Respond with ONLY a JSON object:
{{"match": "yes" | "no" | "uncertain",
  "object_in_locale": "the most natural {locale} name for the object shown",
  "confidence": 0.0-1.0,
  "reason": "one short sentence"}}"""

# Inserted only for items the item-bank marks as intentionally difficult.
HARD_NOTE = """
NOTE: This is an INTENTIONALLY ADVANCED item — it is supposed to be hard, abstract,
or unfamiliar for young children. Do NOT answer "no" merely because the word is
advanced/technical/abstract, because a young child is unlikely to know it, or because
the picture does not obviously depict the concept. Judge ONLY correctness: answer
"yes" if "{word}" is a correct and standard {locale} name for what is pictured (even
if sophisticated), and "no" ONLY for a genuine error — the word names a different
object than the one shown, or is a mistranslation. Still report any such real issue.
"""


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
                 is_hard: bool = False, distractors: Optional[List[str]] = None,
                 max_retries: int = 3) -> Dict:
        mime = next((m for ext, m in IMAGE_EXTS if image_path.suffix.lower() == ext), "image/jpeg")
        img_bytes = image_path.read_bytes()
        distractor_str = ", ".join(distractors) if distractors else "(not available)"
        key = JsonDirCache.make_key(PROMPT_VERSION, self.model_name, locale, en_word, word,
                                    str(len(img_bytes)), "hard" if is_hard else "std",
                                    distractor_str)
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        img_b64 = base64.b64encode(img_bytes).decode("ascii")
        hard_note = HARD_NOTE.format(word=word, locale=locale) if is_hard else ""
        prompt = PROMPT.format(en_word=en_word, word=word, locale=locale,
                               distractors=distractor_str, hard_note=hard_note)
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


def load_difficulty(corpus_csv: str) -> Dict[str, float]:
    """vocab-item-NNN -> IRT difficulty `d` from the corpus item-bank (negative =
    easier). Items above a threshold are intentionally hard and shouldn't be flagged
    just for being hard. Missing/blank `d` is simply absent (treated as not-hard)."""
    out: Dict[str, float] = {}
    try:
        with open(corpus_csv, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                vid = (r.get("audio_file") or "").strip()
                d = (r.get("d") or "").strip()
                if vid.startswith("vocab-item-") and d:
                    try:
                        out[vid] = float(d)
                    except ValueError:
                        pass
    except OSError:
        pass
    return out


def load_distractors(corpus_csv: str) -> Dict[str, List[str]]:
    """vocab-item-NNN -> the 3 other answer options (English `response_alternatives`).
    Used to judge the real 4-AFC task: a too-broad/category word is fine as long as it
    doesn't also fit one of the distractors."""
    out: Dict[str, List[str]] = {}
    try:
        with open(corpus_csv, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                vid = (r.get("audio_file") or "").strip()
                alts = (r.get("response_alternatives") or "").strip()
                if vid.startswith("vocab-item-") and alts:
                    out[vid] = [a.strip() for a in alts.split(",") if a.strip()]
    except OSError:
        pass
    return out


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
    # Default: pull approved translations live from Crowdin. A saved export CSV is
    # used only when --translations-csv is given explicitly.
    if args.translations_csv:
        print(f"[words] reading saved Crowdin export: {args.translations_csv}")
        return list(csv.DictReader(open(args.translations_csv, encoding="utf-8")))
    print("[words] pulling approved translations live from Crowdin (--from-crowdin default)")
    from crowdin_source import fetch_approved_rows
    rows, _ = fetch_approved_rows(approved_only=True)
    return rows


def run_locale(ev: "VocabVisionEvaluator", rows: List[dict], locale: str,
               resolver: "ImageResolver", limit: int,
               difficulty: Optional[Dict[str, float]] = None,
               hard_threshold: float = 1.0,
               distractors: Optional[Dict[str, List[str]]] = None) -> List[dict]:
    difficulty = difficulty or {}
    distractors = distractors or {}
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
        d = difficulty.get(it["vid"])
        is_hard = d is not None and d >= hard_threshold
        res = ev.evaluate(it["en_word"], it["word"], locale, it["image"], is_hard=is_hard,
                          distractors=distractors.get(it["vid"]))
        out.append({"locale": locale, "item_id": f"vocab.xliff::{it['vid']}", "vid": it["vid"],
                    "en_word": it["en_word"], "translation": it["word"], "vision_match": res["match"],
                    "object_in_locale": res["object_in_locale"], "confidence": res["confidence"],
                    "reason": res["reason"],
                    "difficulty": "" if d is None else round(d, 4),
                    "hard": 1 if is_hard else 0})
    return out


def tag_mismatches(all_rows: List[dict], source_min_locales: int,
                   source_frac: float = 0.6) -> None:
    """Tag each mismatch by its cross-locale spread (mutates rows, adds 'tag').

    A vid that mismatches in most locales it was checked in is almost always a
    SOURCE/ITEM problem — the shared English keyword doesn't match the picture, or
    the word is too abstract to name an object — so the translation is not the thing
    to fix. A vid that mismatches in only a few locales is a real per-locale
    TRANSLATION issue (the picture is fine; that language's word is off).

    By default an item is "source-wide" when it fails in >= `source_frac` of the
    locales it was checked in (and at least 2). `source_min_locales > 0` overrides
    this with an absolute locale count.
    """
    import math
    by_vid: Dict[str, List[dict]] = {}
    for r in all_rows:
        by_vid.setdefault(r["vid"], []).append(r)
    for vid, rs in by_vid.items():
        n_checked = len(rs)
        bad = [r for r in rs if r["vision_match"] == "no"]
        n_bad = len(bad)
        threshold = (source_min_locales if source_min_locales > 0
                     else math.ceil(source_frac * n_checked))
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
            d = rs[0].get("difficulty", "")
            d_str = f", d={d}" if d != "" else ""
            lines.append(f"### {vid} — “{en}”  ({len(rs)}/{checked} locales{d_str})")
            lines.append("")
            lines.append("| locale | translation | model sees | why |")
            lines.append("|---|---|---|---|")
            for r in rs:
                why = (r["reason"] or "").replace("|", "\\|")
                lines.append(f"| {r['locale']} | {r['translation']} | {r['object_in_locale']} | {why} |")
            lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


PDF_CSS = """<style>
  @page { size: A4 landscape; margin: 8mm; }
  /* pandoc's default template caps body width; force full-page width so the table
     spans the whole landscape page and the slack goes to the wide `why` column. */
  html, body { max-width: none !important; margin: 0 !important; padding: 0 !important; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         font-size: 9pt; line-height: 1.25; color: #1a1a1a; }
  h1 { font-size: 15pt; margin: 0 0 6px; border-bottom: 2px solid #333; padding-bottom: 3px; }
  h2 { font-size: 12pt; margin: 12px 0 4px; color: #b03000; border-bottom: 1px solid #ccc; }
  h3 { font-size: 10pt; margin: 8px 0 2px; color: #00408a; page-break-after: avoid; }
  ul { margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; margin: 2px 0 8px;
          table-layout: fixed; page-break-inside: auto; }
  th, td { border: 1px solid #bbb; padding: 2px 4px; text-align: left;
           vertical-align: top; word-wrap: break-word; overflow-wrap: anywhere; }
  th { background: #f0f0f0; font-weight: 600; }
  tr { page-break-inside: avoid; }
  tr:nth-child(even) td { background: #fafafa; }
  /* short columns kept tight; all slack goes to the wide `why` column */
  td:nth-child(1), th:nth-child(1) { width: 6%; }
  td:nth-child(2), th:nth-child(2) { width: 15%; }
  td:nth-child(3), th:nth-child(3) { width: 16%; }
  td:nth-child(4), th:nth-child(4) { width: 63%; }
  code { background: #f3f3f3; padding: 0 3px; border-radius: 3px; }
</style>
"""


def render_pdf(md_path: Path, pdf_path: Path) -> bool:
    """Render the Markdown report to a styled PDF via pandoc (md->html) + headless
    Chrome (html->pdf). Best-effort: returns False (with a note) if either tool is
    missing rather than failing the run."""
    pandoc = shutil.which("pandoc")
    chrome = next((shutil.which(b) for b in
                   ("google-chrome", "chromium", "chromium-browser", "google-chrome-stable")
                   if shutil.which(b)), None)
    if not pandoc or not chrome:
        missing = "pandoc" if not pandoc else "chrome/chromium"
        print(f"[pdf] skipped (no {missing} on PATH).")
        return False
    css = md_path.with_suffix(".pdfcss.html")
    html = md_path.with_suffix(".pdf.html")
    try:
        css.write_text(PDF_CSS, encoding="utf-8")
        subprocess.run([pandoc, str(md_path), "-s",
                        "--metadata", "title=Vocab Word-vs-Image Vision Report",
                        f"--include-in-header={css}", "-o", str(html)],
                       check=True, capture_output=True, text=True)
        subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
                        "--no-pdf-header-footer", f"--print-to-pdf={pdf_path}", str(html)],
                       check=True, capture_output=True, text=True)
        return pdf_path.is_file()
    except (subprocess.CalledProcessError, OSError) as e:
        print(f"[pdf] skipped (render failed: {e}).")
        return False
    finally:
        for f in (css, html):
            f.unlink(missing_ok=True)


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Vision check: does the translated word name the pictured object?")
    # WORDS (translations) source. Default = live Crowdin.
    src = p.add_mutually_exclusive_group()
    src.add_argument("--from-crowdin", action="store_true",
                     help="(Default) Pull approved translations live from Crowdin. Kept for "
                          "explicitness; the live pull happens unless --translations-csv is given.")
    src.add_argument("--translations-csv", default=None,
                     help="Use a saved Crowdin export CSV (item_id + per-locale cols incl. `en`) "
                          "instead of pulling live, e.g. output/crowdin-approved.csv.")
    p.add_argument("--image-source", choices=["gcs", "local"], default="gcs",
                   help="Where answer images come from (default: deployed GCS visual bucket).")
    p.add_argument("--gcs-bucket", default="levante-assets-dev",
                   help="GCS bucket for --image-source gcs (use levante-assets-prod for prod).")
    p.add_argument("--gcs-prefix", default="visual/vocab/")
    p.add_argument("--image-dir",
                   default="../../../core-task-assets/vocab/original,../../../core-task-assets/vocab/images",
                   help="Comma-separated local image dir(s) for --image-source local.")
    p.add_argument("--locales", default="es-AR", help="Comma-separated locales (column names).")
    p.add_argument("--corpus-csv",
                   default="../../../crowdin-projects/corpora/vocab-test/shared/corpora/vocab-item-bank.csv",
                   help="Vocab item-bank with the IRT `d` difficulty column.")
    p.add_argument("--hard-difficulty", type=float, default=1.0,
                   help="Items with IRT d >= this are intentionally hard; the VLM is told "
                        "not to flag them just for being hard (still flags real errors).")
    p.add_argument("--source-frac", type=float, default=0.6,
                   help="Fraction of checked locales an item must fail in to be tagged "
                        "source_image_issue (default 0.6 = most locales).")
    p.add_argument("--source-min-locales", type=int, default=0,
                   help="Absolute locale-count override for source_image_issue tagging "
                        "(0 = use --source-frac instead).")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--output-dir", default="output")
    p.add_argument("--no-pdf", action="store_true",
                   help="Skip rendering vocab-vision-report.pdf (needs pandoc + chrome).")
    args = p.parse_args()

    rows = load_translation_rows(args)
    resolver = ImageResolver(args.image_source, local_dirs=args.image_dir,
                             bucket=args.gcs_bucket, prefix=args.gcs_prefix)
    difficulty = load_difficulty(args.corpus_csv)
    distractors = load_distractors(args.corpus_csv)
    locales = [l.strip() for l in args.locales.split(",") if l.strip()]
    n_hard = sum(1 for d in difficulty.values() if d >= args.hard_difficulty)
    print(f"[vision] {len(resolver)} images indexed from {resolver.label}")
    print(f"[vision] difficulty for {len(difficulty)} items; "
          f"{n_hard} are hard (d >= {args.hard_difficulty}) and won't be flagged for difficulty.")
    print(f"[vision] distractor options for {len(distractors)} items (category words OK "
          f"unless a distractor also fits).")

    ev = VocabVisionEvaluator()
    all_rows: List[dict] = []
    for loc in locales:
        res = run_locale(ev, rows, loc, resolver, args.limit, difficulty, args.hard_difficulty,
                         distractors)
        bad = [r for r in res if r["vision_match"] == "no"]
        unc = sum(1 for r in res if r["vision_match"] == "uncertain")
        print(f"\n[{loc}] {len(res)} checked | {len(bad)} MISMATCH | {unc} uncertain")
        for r in bad:
            print(f"   BAD {r['vid']:16} '{r['en_word']}' -> '{r['translation']}'"
                  f"   model sees: '{r['object_in_locale']}'  ({r['reason']})")
        all_rows.extend(res)

    tag_mismatches(all_rows, args.source_min_locales, args.source_frac)

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    field_order = ["locale", "item_id", "vid", "en_word", "translation", "vision_match",
                   "object_in_locale", "confidence", "reason", "tag", "difficulty", "hard",
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
    pdf = out_dir / "vocab-vision-report.pdf"
    pdf_ok = render_pdf(report, pdf) if not args.no_pdf else False

    total_bad = sum(1 for r in all_rows if r["vision_match"] == "no")
    n_src = len({r["vid"] for r in all_rows if r["tag"] == "source_image_issue"})
    n_tr = len({r["vid"] for r in all_rows if r["tag"] == "translation_issue"})
    print(f"\n[done] {len(all_rows)} checks across {len(locales)} locale(s), "
          f"{total_bad} mismatch(es): {n_src} source/item, {n_tr} translation.")
    print(f"       CSV -> {out_dir / 'vocab-vision-all.csv'}")
    print(f"       report -> {report}")
    if pdf_ok:
        print(f"       pdf -> {pdf}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
