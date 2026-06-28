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

Inputs default to the artifacts already produced:
  --corpus-csv  output/_vocab_esar.csv          (maps vocab-item-NNN -> answer image word)
  --queue-csv   output/review-queue-es-AR.csv    (es-AR translation per item; which are flagged)
  --image-dir   ../../../core-task-assets/vocab/original

    python vocab_vision_eval.py --only-flagged --limit 20
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


def _vid(item_id: str) -> Optional[str]:
    m = re.search(r"(vocab-item-\d+)", item_id or "")
    return m.group(1) if m else None


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Vision check: does the translated word name the pictured object?")
    p.add_argument("--filenames-csv", default="../../../core-task-assets/vocab/filenames.csv",
                   help="Authoritative word<->vocab-item-id map (input=word,output=item-id).")
    p.add_argument("--queue-csv", default="output/review-queue-es-AR.csv")
    p.add_argument("--image-dir", default="../../../core-task-assets/vocab/original")
    p.add_argument("--locale", default="es-AR")
    p.add_argument("--only-flagged", action="store_true", help="Only items the queue tagged review/likely_bad.")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--output", default="output/vocab-vision-es-AR.csv")
    args = p.parse_args()

    # vocab-item-NNN -> answer-image word stem (e.g. vocab-item-055 -> "scoop").
    vid2word = {row["output"].strip(): row["input"].strip()
                for row in csv.DictReader(open(args.filenames_csv, encoding="utf-8"))
                if row.get("output", "").startswith("vocab-item-")}
    queue = [r for r in csv.DictReader(open(args.queue_csv, encoding="utf-8")) if _vid(r["item_id"])]
    if args.only_flagged:
        queue = [r for r in queue if r.get("tier") != "ok"]
    img_dir = Path(args.image_dir)

    items = []
    for r in queue:
        vid = _vid(r["item_id"])
        word_img = vid2word.get(vid, "").strip()  # answer image filename stem (English word)
        if not word_img:
            continue
        img = next((img_dir / f"{word_img}{ext}" for ext, _ in IMAGE_EXTS if (img_dir / f"{word_img}{ext}").is_file()), None)
        if not img:
            continue
        items.append({"item_id": r["item_id"], "vid": vid, "en_word": r["source_en"],
                      "es_word": r["translation"], "tier": r.get("tier", ""), "image": img})
    # likely_bad first, then by worst adequacy already encoded in queue order.
    items.sort(key=lambda x: 0 if x["tier"] == "likely_bad" else 1)
    if args.limit:
        items = items[:args.limit]
    if not items:
        sys.exit("No vocab items with images to check.")
    print(f"[vision] checking {len(items)} vocab items ...")

    ev = VocabVisionEvaluator()
    rows = []
    for it in items:
        res = ev.evaluate(it["en_word"].replace("the ", "").strip(), it["es_word"], args.locale, it["image"])
        rows.append({"item_id": it["item_id"], "tier": it["tier"], "en_word": it["en_word"],
                     "es_word": it["es_word"], "vision_match": res["match"],
                     "object_in_locale": res["object_in_locale"], "confidence": res["confidence"],
                     "reason": res["reason"]})
        mark = {"yes": "OK ", "no": "BAD", "uncertain": "?? "}[res["match"]]
        print(f"  [{mark}] {it['vid']:16} '{it['en_word']}' -> '{it['es_word']}'"
              f"   model sees: '{res['object_in_locale']}'  ({res['reason']})")

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    bad = sum(1 for r in rows if r["vision_match"] == "no")
    print(f"\n[done] {len(rows)} checked, {bad} word/image MISMATCH -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
