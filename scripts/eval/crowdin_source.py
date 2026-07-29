#!/usr/bin/env python3
"""
Approved-translation source shim (Crowdin-direct).

Historically this module built an approved-only Crowdin export (ZIP -> XLIFF) and
parsed it. That path is gone: translation strings now come from a live source
keyed by task + country (see translation_source.py) -- the draft bucket JSON by
default, or the Crowdin REST API directly (non-hidden, APPROVED) with no
export/build and no XLIFF/CSV.

`fetch_approved_rows()` is kept as a thin wrapper over the Crowdin-direct source
so existing callers (and the `--from-crowdin` code paths) keep working. The CLI
writes the same merged table the eval scripts consume.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List, Tuple

from envload import load_env
from translation_source import fetch_rows, write_csv


def fetch_approved_rows(approved_only: bool = True) -> Tuple[List[dict], List[str]]:
    """Approved translations read directly from the Crowdin API (no XLIFF/ZIP)."""
    return fetch_rows(source="crowdin", approved_only=approved_only)


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Fetch approved translations from Crowdin (direct API).")
    p.add_argument("--output", default="output/crowdin-approved.csv")
    p.add_argument("--content-type", default="", help="Filter rows: itembank | survey | dashboard | general.")
    args = p.parse_args()

    rows, lang_columns = fetch_approved_rows()
    if args.content_type:
        rows = [r for r in rows if str(r.get("contentType", "")).lower() == args.content_type.lower()]
    out = Path(args.output)
    write_csv(rows, lang_columns, out)
    print(f"[done] {len(rows)} rows, languages: {', '.join(lang_columns) or '(none)'} -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
