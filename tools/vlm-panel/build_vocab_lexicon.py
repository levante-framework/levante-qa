#!/usr/bin/env python3
"""Build vocab_lexicon.json (wordfreq Zipf) for the vocab item bank.

Requires: pip install wordfreq (one-shot; committed JSON is the runtime artifact).

  python3 tools/vlm-panel/build_vocab_lexicon.py
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

from wordfreq import zipf_frequency

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
BANK = REPO / "cypress" / "cache" / "sim-item-bank-vocab.csv"
OUT = HERE / "vocab_lexicon.json"


def normalize_uid(raw: str) -> str:
    raw = (raw or "").strip()
    if raw.startswith("vocab__"):
        return "vocab_word_" + raw[len("vocab__") :]
    return raw


def main() -> None:
    words: dict[str, dict] = {}
    with BANK.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if (row.get("trial_type") or "").strip() != "test":
                continue
            word = (row.get("item") or "").strip().lower()
            uid = normalize_uid(row.get("item_uid") or "")
            if not word or not uid:
                continue
            entry = words.setdefault(word, {"zipf": round(zipf_frequency(word, "en"), 3), "item_uids": []})
            if uid not in entry["item_uids"]:
                entry["item_uids"].append(uid)

    payload = {
        "source": "wordfreq",
        "lang": "en",
        "n_words": len(words),
        "blend_beta": 0.1,
        "max_zipf": 3.0,
        "zipf_mid": 3.5,
        "zipf_scale": 1.2,
        "words": dict(sorted(words.items())),
    }
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT} ({payload['n_words']} words)")


if __name__ == "__main__":
    main()
