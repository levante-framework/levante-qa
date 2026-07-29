#!/usr/bin/env python3
"""
Translation-string source for the eval suite.

The strings the evaluators score always come from a live source keyed by task +
country, never a checked-in CSV or XLIFF file. Select the source with the
`QA_TRANSLATIONS_SOURCE` env var (or the `source=` argument):

  - "draft" (default): the per-task/per-locale JSON published to
    levante-assets-draft/translations by the localization pipeline:
        translations/itembank/<task>/<locale>/item-bank-translations.json
        translations/dashboard-consolidated-flat/<live|test>/<locale>/dashboard_translations.json
    Each file is a flat { id: string } map. Override the base with
    QA_ITEMBANK_BASE_URL; pick the dashboard variant with QA_DASHBOARD_VARIANT.

  - "crowdin": the non-hidden, APPROVED strings read directly from the Crowdin
    REST API (no export/build, no XLIFF). The string `identifier` is the item id.
    Needs CROWDIN_API_TOKEN (or ~/.crowdin_api_token) and optionally
    CROWDIN_PROJECT_ID / LEVANTE_TRANSLATIONS_PROJECT_ID.

Both produce the same row schema the rest of the suite already consumes:

    { identifier, item_id, labels, contentType, _path, en, <locale...> }

`identifier` == `item_id` == the bare flat-JSON key (e.g. "vocab-item-001",
"ClassFriends", "consentModal"). The English source is the `en-US` value, exposed
as the `en` column; every other locale becomes a column named by its full locale
code (e.g. "de-DE", "nl-NL", "es-CO"). There is deliberately no fallback to a
CSV/XLIFF file: a missing source area is warned and skipped.

Stdlib only (urllib + json), so there are no extra dependencies. Use as a library
(`fetch_rows`) or a CLI:

    python translation_source.py --output output/translations.csv
    QA_TRANSLATIONS_SOURCE=crowdin python translation_source.py --output out.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, Iterator, List, Tuple

# --------------------------------------------------------------------------- #
# Shared config
# --------------------------------------------------------------------------- #
DEFAULT_BUCKET_BASE = "https://storage.googleapis.com/levante-assets-draft/translations"
GCS_JSON_API = "https://storage.googleapis.com/storage/v1/b/{bucket}/o"
CROWDIN_API_BASE = "https://api.crowdin.com/api/v2"
DEFAULT_PROJECT_ID = "756721"

# The JSON locale used as the English source; exposed as the `en` column.
SOURCE_LOCALE = "en-US"
SOURCE_COL = "en"

# Non-language meta columns (mirrors evaluate_translations.NON_LANG_COLUMNS).
META_COLUMNS = ["identifier", "item_id", "labels", "contentType", "_path", SOURCE_COL]

# itembank subfolders that are not assessment tasks.
_SURVEY_FOLDERS = {"child-survey"}
_GENERAL_FOLDERS = {"general"}

# Placeholder cells that mean "no string", not a real translation to score.
_INVALID_VALUES = {"", "NO TRANSLATION FOUND", "NO APPROVED TRANSLATION"}

# Crowdin language id -> canonical bucket locale, so columns line up across the
# two sources (Crowdin uses bare subtags for a few languages).
CROWDIN_TO_LOCALE = {"de": "de-DE", "nl": "nl-NL", "eo": "eo-UY"}


def _prettify(label: str) -> str:
    s = re.sub(r"\.[a-z0-9]+$", "", str(label or ""), flags=re.IGNORECASE)
    s = re.sub(r"[_-]+", " ", s).strip()
    return (s[:1].upper() + s[1:]) if s else "General"


def _flatten_strings(obj, prefix: str = "") -> Dict[str, str]:
    """Flatten a (possibly nested) translations map to { dotted.key: string }.

    itembank JSON is already flat; the dashboard JSON nests one level under a
    namespace (e.g. {"consentModal": {"acceptButton": "Accept"}}). Non-string
    leaves (lists/numbers/None) are ignored.
    """
    out: Dict[str, str] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            if isinstance(v, dict):
                out.update(_flatten_strings(v, key))
            elif isinstance(v, str):
                out[key] = v
    return out


def _blank_row(item_id: str, labels: str, content_type: str, path: str) -> dict:
    return {
        "identifier": item_id,
        "item_id": item_id,
        "labels": labels,
        "contentType": content_type,
        "_path": path,
        SOURCE_COL: "",
    }


# --------------------------------------------------------------------------- #
# HTTP helpers (stdlib)
# --------------------------------------------------------------------------- #
def _http_json(url: str, headers: dict | None = None, optional: bool = False):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if optional and exc.code == 404:
            return None
        raise RuntimeError(f"HTTP {exc.code} for {url}: {exc.reason}") from exc


def _bucket_from_base(base: str) -> str:
    # e.g. https://storage.googleapis.com/levante-assets-draft/translations -> levante-assets-draft
    path = urllib.parse.urlparse(base).path.lstrip("/")
    return path.split("/")[0] if path else ""


def _gcs_list_prefixes(bucket: str, prefix: str) -> List[str]:
    """Immediate child "folder" names under prefix (via the delimiter listing)."""
    names: List[str] = []
    page_token = ""
    while True:
        url = (
            f"{GCS_JSON_API.format(bucket=bucket)}"
            f"?prefix={urllib.parse.quote(prefix)}&delimiter=%2F"
        )
        if page_token:
            url += f"&pageToken={urllib.parse.quote(page_token)}"
        body = _http_json(url)
        for p in body.get("prefixes", []) or []:
            names.append(p[len(prefix):].rstrip("/"))
        page_token = body.get("nextPageToken", "")
        if not page_token:
            break
    return names


# --------------------------------------------------------------------------- #
# Draft bucket source (default)
# --------------------------------------------------------------------------- #
def _classify_itembank_folder(folder: str) -> Tuple[str, str]:
    if folder in _SURVEY_FOLDERS:
        return "survey", _prettify(folder)
    if folder in _GENERAL_FOLDERS:
        return "general", "General"
    return "itembank", _prettify(folder)


def _load_area(
    base: str,
    area: str,
    filename: str,
    content_type: str,
    labels: str,
    by_key: Dict[str, dict],
    langs: set,
) -> None:
    """Merge one bucket area (all locales) into by_key, keyed by contentType::id."""
    bucket = _bucket_from_base(base)
    prefix = f"{urllib.parse.urlparse(base).path.lstrip('/').split('/', 1)[1]}/{area}/"
    try:
        locales = _gcs_list_prefixes(bucket, prefix)
    except Exception as exc:  # noqa: BLE001
        print(f"[draft] WARN: cannot list {area} ({exc}); skipping.", file=sys.stderr)
        return
    if not locales:
        print(f"[draft] WARN: no locales under {area}; skipping.", file=sys.stderr)
        return
    for locale in locales:
        url = f"{base}/{area}/{locale}/{filename}"
        data = _http_json(url, optional=True)
        if not isinstance(data, dict):
            continue
        col = SOURCE_COL if locale == SOURCE_LOCALE else locale
        langs.add(locale)
        for item_id, text in _flatten_strings(data).items():
            if text.strip() in _INVALID_VALUES:
                continue
            key = f"{content_type}::{item_id}"
            row = by_key.setdefault(
                key, _blank_row(item_id, labels, content_type, f"{area}/{item_id}")
            )
            row[col] = text.strip()


def load_draft_rows() -> Tuple[List[dict], List[str]]:
    base = os.environ.get("QA_ITEMBANK_BASE_URL", DEFAULT_BUCKET_BASE).rstrip("/")
    bucket = _bucket_from_base(base)
    root = urllib.parse.urlparse(base).path.lstrip("/").split("/", 1)[1]  # "translations"
    by_key: Dict[str, dict] = {}
    langs: set = set()

    # itembank/<task|child-survey|general>/<locale>/item-bank-translations.json
    for folder in _gcs_list_prefixes(bucket, f"{root}/itembank/"):
        content_type, labels = _classify_itembank_folder(folder)
        _load_area(base, f"itembank/{folder}", "item-bank-translations.json",
                   content_type, labels, by_key, langs)

    # dashboard-consolidated-flat/<live|test>/<locale>/dashboard_translations.json
    variant = os.environ.get("QA_DASHBOARD_VARIANT", "live")
    _load_area(base, f"dashboard-consolidated-flat/{variant}", "dashboard_translations.json",
               "dashboard", "Dashboard", by_key, langs)

    rows = list(by_key.values())
    lang_columns = sorted(l for l in langs if l != SOURCE_LOCALE)
    return rows, lang_columns


# --------------------------------------------------------------------------- #
# Crowdin direct source (non-hidden, approved)
# --------------------------------------------------------------------------- #
def _crowdin_token() -> str:
    tok = os.environ.get("CROWDIN_API_TOKEN") or os.environ.get("CROWDIN_TOKEN")
    if tok and tok.strip():
        return tok.strip()
    path = Path.home() / ".crowdin_api_token"
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    raise RuntimeError(
        "Crowdin token not found. Set CROWDIN_API_TOKEN or create ~/.crowdin_api_token."
    )


def _crowdin_project() -> str:
    return (
        os.environ.get("CROWDIN_PROJECT_ID")
        or os.environ.get("LEVANTE_TRANSLATIONS_PROJECT_ID")
        or DEFAULT_PROJECT_ID
    )


def _crowdin_pages(path: str, token: str) -> Iterator[dict]:
    """Yield each row's `data` from a paginated Crowdin list endpoint (500/page)."""
    sep = "&" if "?" in path else "?"
    offset = 0
    while True:
        url = f"{CROWDIN_API_BASE}{path}{sep}limit=500&offset={offset}"
        body = _http_json(url, headers={"Authorization": f"Bearer {token}"})
        rows = body.get("data", []) or []
        for row in rows:
            yield row.get("data", {})
        if len(rows) < 500:
            return
        offset += 500


def _classify_crowdin_context(context: str) -> Tuple[str, str]:
    ctx = str(context or "")
    low = ctx.lower()
    m = re.search(r"x-crowdin-label:\s*([^\r\n]+)", ctx)
    label = (m.group(1).strip() if m else "")
    if "survey" in low or label in _SURVEY_FOLDERS:
        return "survey", _prettify(label or "survey")
    if "dashboard" in low:
        return "dashboard", "Dashboard"
    if "item-bank" in low or "itembank" in low or label:
        return "itembank", _prettify(label or "itembank")
    return "general", "General"


def _crowdin_target_languages(project: str, token: str) -> List[str]:
    body = _http_json(
        f"{CROWDIN_API_BASE}/projects/{project}",
        headers={"Authorization": f"Bearer {token}"},
    )
    return list((body.get("data", {}) or {}).get("targetLanguageIds", []) or [])


def load_crowdin_rows() -> Tuple[List[dict], List[str]]:
    token = _crowdin_token()
    project = _crowdin_project()

    # Non-hidden project strings: stringId -> {identifier, contentType, labels, en source}.
    meta_by_string: Dict[int, dict] = {}
    for s in _crowdin_pages(f"/projects/{project}/strings", token):
        if s.get("isHidden"):
            continue
        identifier = s.get("identifier")
        if not identifier:
            continue
        content_type, labels = _classify_crowdin_context(s.get("context", ""))
        meta_by_string[s.get("id")] = {
            "identifier": identifier,
            "contentType": content_type,
            "labels": labels,
            "en": (s.get("text") or "").strip(),
        }

    by_key: Dict[str, dict] = {}
    langs: set = set()
    for lang_id in _crowdin_target_languages(project, token):
        locale = CROWDIN_TO_LOCALE.get(lang_id, lang_id)
        # en-US is the English source (from string.text); don't also make it a target column.
        is_source = locale == SOURCE_LOCALE
        for t in _crowdin_pages(f"/projects/{project}/languages/{lang_id}/translations", token):
            meta = meta_by_string.get(t.get("stringId"))
            if not meta:
                continue
            text = (t.get("text") or "").strip()
            if not text:
                continue
            key = f"{meta['contentType']}::{meta['identifier']}"
            row = by_key.setdefault(
                key,
                _blank_row(meta["identifier"], meta["labels"], meta["contentType"],
                           f"crowdin/{meta['identifier']}"),
            )
            if not row[SOURCE_COL]:
                row[SOURCE_COL] = meta["en"]
            if not is_source:
                langs.add(locale)
                row[locale] = text

    # Make sure the English source is filled even for strings whose only approved
    # translations were skipped (e.g. only en-US present).
    for meta in meta_by_string.values():
        key = f"{meta['contentType']}::{meta['identifier']}"
        row = by_key.get(key)
        if row and not row[SOURCE_COL]:
            row[SOURCE_COL] = meta["en"]

    rows = list(by_key.values())
    lang_columns = sorted(l for l in langs if l != SOURCE_LOCALE)
    return rows, lang_columns


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #
def fetch_rows(source: str | None = None, approved_only: bool = True) -> Tuple[List[dict], List[str]]:
    """Return (rows, lang_columns) from the selected source.

    `approved_only` is accepted for signature compatibility; both sources are
    approved-only by construction (the draft bucket publishes approved strings;
    the Crowdin path reads approved translations).
    """
    src = (source or os.environ.get("QA_TRANSLATIONS_SOURCE") or "draft").strip().lower()
    if src in ("crowdin", "crowdin-approved"):
        return load_crowdin_rows()
    if src in ("draft", "", "bucket", "itembank"):
        return load_draft_rows()
    raise ValueError(f"Unknown translation source '{src}' (expected 'draft' or 'crowdin').")


def write_csv(rows: List[dict], lang_columns: List[str], out_path: Path) -> None:
    headers = [*META_COLUMNS, *lang_columns]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({h: row.get(h, "") for h in headers})


def main() -> int:
    try:
        from envload import load_env

        load_env()
    except Exception:  # noqa: BLE001
        pass
    p = argparse.ArgumentParser(description="Fetch translation strings (draft bucket or Crowdin).")
    p.add_argument("--source", default=None, help="draft (default) | crowdin. Overrides QA_TRANSLATIONS_SOURCE.")
    p.add_argument("--output", default="output/translations.csv")
    p.add_argument("--content-type", default="", help="Filter rows: itembank | survey | dashboard | general.")
    args = p.parse_args()

    rows, lang_columns = fetch_rows(source=args.source)
    if args.content_type:
        rows = [r for r in rows if str(r.get("contentType", "")).lower() == args.content_type.lower()]
    out = Path(args.output)
    write_csv(rows, lang_columns, out)
    print(f"[done] {len(rows)} rows, languages: {', '.join(lang_columns) or '(none)'} -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
