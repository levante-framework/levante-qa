#!/usr/bin/env python3
"""
Read APPROVED translations directly from Crowdin.

Mirrors levante-web-dashboard's `scripts/export-crowdin-xliff-merged.js` /
`api/crowdin-approved-translations.js`: create an approved-only build, poll until
it finishes, download the ZIP, and parse the XLIFF trans-units (plus the
dashboard CSVs) into one merged table with columns:

    identifier, item_id, labels, contentType, _path, en, <locale...>

The `item_id` is `<canonical-path>::<resname-or-id>`, identical to the dashboard
export, so rows join cleanly to the human-review seed and to the centroid signal.

Auth (from levante-qa/.env, same names as the dashboard):
    CROWDIN_API_TOKEN              (required)
    LEVANTE_TRANSLATIONS_PROJECT_ID (optional, default 756721)

Stdlib only (urllib + zipfile + regex), so there are no extra dependencies and an
SDK can't break it. Use as a library (`fetch_approved_rows`) or a CLI:

    python crowdin_source.py --output output/crowdin-approved.csv
    python crowdin_source.py --output output/crowdin-all.csv --include-unapproved
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import time
import urllib.request
import zipfile
from html import unescape
from pathlib import Path
from typing import Dict, List, Tuple

from envload import load_env

CROWDIN_API_BASE = "https://api.crowdin.com/api/v2"
DEFAULT_PROJECT_ID = "756721"

# Crowdin language directory / CSV header -> canonical LEVANTE locale code.
LANG_ID_TO_CODE = {
    "en": "en", "en-us": "en-US", "en-gb": "en-GB", "en-gh": "en-GH",
    "es-co": "es-CO", "es": "es-CO", "es-ar": "es-AR",
    "de": "de", "de-de": "de", "de-ch": "de-CH",
    "fr-ca": "fr-CA", "fr": "fr-CA", "nl": "nl",
    "pt-pt": "pt-PT", "pt-br": "pt-BR",
}


# --------------------------------------------------------------------------- #
# Crowdin REST (approved-only build -> zip), mirroring the dashboard.
# --------------------------------------------------------------------------- #
def _crowdin(path: str, token: str, method: str = "GET", body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{CROWDIN_API_BASE}{path}",
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def download_zip_bytes(approved_only: bool = True) -> bytes:
    token = os.environ.get("CROWDIN_API_TOKEN")
    if not token:
        raise RuntimeError(
            "CROWDIN_API_TOKEN is not set. Add it to levante-qa/.env "
            "(see https://crowdin.com → Account → API)."
        )
    project_id = os.environ.get("LEVANTE_TRANSLATIONS_PROJECT_ID", DEFAULT_PROJECT_ID)

    print(f"[crowdin] requesting {'approved-only' if approved_only else 'all'} build (project {project_id}) ...")
    build = _crowdin(
        f"/projects/{project_id}/translations/builds",
        token, method="POST", body={"exportApprovedOnly": approved_only},
    )
    build_id = build.get("data", {}).get("id")
    if not build_id:
        raise RuntimeError("No build id returned by Crowdin.")

    for _ in range(60):
        status_body = _crowdin(f"/projects/{project_id}/translations/builds/{build_id}", token)
        status = str(status_body.get("data", {}).get("status", "")).lower()
        if status == "finished":
            break
        if status in {"failed", "cancelled"}:
            raise RuntimeError(f"Crowdin build {status}.")
        time.sleep(1.5)
    else:
        raise RuntimeError("Crowdin build did not finish in time (busy); retry shortly.")

    dl = _crowdin(f"/projects/{project_id}/translations/builds/{build_id}/download", token)
    zip_url = dl.get("data", {}).get("url")
    if not zip_url:
        raise RuntimeError("No Crowdin zip download URL returned.")
    print("[crowdin] downloading build zip ...")
    with urllib.request.urlopen(zip_url, timeout=300) as resp:
        return resp.read()


# --------------------------------------------------------------------------- #
# Parsing (XLIFF trans-units + dashboard CSVs), mirroring the dashboard.
# --------------------------------------------------------------------------- #
def _norm_path(p: str) -> str:
    return str(p or "").replace("\\", "/")


def _strip_tags(text: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", str(text or "")))).strip()


def _extract_tag(block: str, tag: str) -> str:
    m = re.search(rf"<{tag}\b[^>]*>([\s\S]*?)</{tag}>", block or "", re.IGNORECASE)
    return _strip_tags(m.group(1)) if m else ""


def _attr(attr_text: str, key: str) -> str:
    m = re.search(rf'{key}\s*=\s*"([^"]*)"', attr_text or "", re.IGNORECASE)
    return m.group(1).strip() if m else ""


def _parse_xliff_units(xliff: str) -> List[dict]:
    units: List[dict] = []
    for m in re.finditer(r"<trans-unit\b([^>]*)>([\s\S]*?)</trans-unit>", xliff or "", re.IGNORECASE):
        attrs, body = m.group(1), m.group(2)
        units.append({
            "id": _attr(attrs, "id"),
            "resname": _attr(attrs, "resname") or _attr(attrs, "name"),
            "source": _extract_tag(body, "source"),
            "target": _extract_tag(body, "target"),
        })
    if units:
        return units
    for m in re.finditer(r"<unit\b([^>]*)>([\s\S]*?)</unit>", xliff or "", re.IGNORECASE):
        attrs, body = m.group(1), m.group(2)
        seg = re.search(r"<segment\b[^>]*>([\s\S]*?)</segment>", body, re.IGNORECASE)
        scope = seg.group(1) if seg else body
        units.append({
            "id": _attr(attrs, "id"),
            "resname": _attr(attrs, "resname") or _attr(attrs, "name"),
            "source": _extract_tag(scope, "source"),
            "target": _extract_tag(scope, "target"),
        })
    return units


def _lang_from_path(p: str) -> str:
    key = _norm_path(p).split("/")[0].strip().lower()
    return LANG_ID_TO_CODE.get(key, key if "-" in key else (key or "en"))


def _norm_lang_header(header: str) -> str:
    key = str(header or "").strip().lower()
    if not key:
        return ""
    return LANG_ID_TO_CODE.get(key, str(header).strip().replace("_", "-"))


def _is_lang_header(header: str) -> bool:
    token = _norm_lang_header(header)
    if not token:
        return False
    if token.lower() == "en":
        return True
    return bool(re.match(r"^[a-z]{2}(?:-[A-Za-z0-9]{2,4})?$", token, re.IGNORECASE))


_ID_RE = re.compile(r"identifier|item_id|item\s*id|^id$", re.IGNORECASE)


def _prettify(label: str) -> str:
    s = re.sub(r"\.[a-z0-9]+$", "", str(label or ""), flags=re.IGNORECASE)
    s = re.sub(r"[_-]+", " ", s)
    s = re.sub(r"\b(short|newkeys?)\b", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+", " ", s).strip()
    return (s[:1].upper() + s[1:]) if s else "General"


def _derive_meta(p: str) -> Tuple[str, str]:
    compact = re.sub(r"^[a-z]{2}(?:-[A-Za-z]{2,4})?/", "", _norm_path(p), flags=re.IGNORECASE)
    if compact.startswith("main/dashboard/"):
        return "Dashboard", "dashboard"
    m = re.search(r"(?:^|/)main/itembank_by_task/([^/]+)\.xli?ff$", compact, re.IGNORECASE)
    if m:
        return _prettify(m.group(1)), "itembank"
    m = re.search(r"(?:^|/)main/surveys/([^/]+)\.xli?ff$", compact, re.IGNORECASE)
    if m:
        return f"Survey: {_prettify(m.group(1))}", "survey"
    return "General", "general"


def _keep(name: str) -> bool:
    n = _norm_path(name).lower()
    is_xliff = n.endswith(".xlf") or n.endswith(".xliff")
    is_csv = n.endswith(".csv")
    if not is_xliff and not is_csv:
        return False
    if not n.startswith("main/") and "/main/" not in n:
        return False
    if "/main/itembank_by_task/" in n or "/main/surveys/" in n:
        return True
    if n.startswith("main/dashboard/") and is_csv:
        return True
    return "/main/dashboard/" in n


def parse_zip(zip_bytes: bytes) -> Tuple[List[dict], List[str]]:
    by_id: Dict[str, dict] = {}
    languages = {"en"}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            if info.is_dir() or not _keep(info.filename):
                continue
            normalized = _norm_path(info.filename)
            data = zf.read(info).decode("utf-8", errors="replace")

            if normalized.lower().startswith("main/dashboard/") and normalized.lower().endswith(".csv"):
                reader = list(csv.DictReader(io.StringIO(data)))
                headers = reader[0].keys() if reader else []
                lang_headers = [h for h in headers if h and not _ID_RE.search(h) and _is_lang_header(h)]
                for idx, row_obj in enumerate(reader):
                    row_id = _id_from_row(row_obj) or f"_dashboard_{idx + 1}"
                    stable_id = f"{normalized}::{row_id}"
                    row = by_id.setdefault(stable_id, _blank_row(stable_id, "Dashboard", "dashboard", normalized))
                    for header in lang_headers:
                        lang = _norm_lang_header(header)
                        val = _strip_tags(str(row_obj.get(header, "") or ""))
                        if not val:
                            continue
                        if lang.lower() == "en":
                            row["en"] = row["en"] or val
                        else:
                            languages.add(lang)
                            row[lang] = val
                continue

            lang = _lang_from_path(normalized)
            canonical = "/".join(normalized.split("/")[1:])
            task, content_type = _derive_meta(normalized)
            units = _parse_xliff_units(data)
            if not units:
                continue
            if lang:
                languages.add(lang)
            for idx, u in enumerate(units):
                local_key = (u["resname"] or u["id"] or "").strip() or f"idx-{idx + 1}"
                stable_id = f"{canonical}::{local_key}"
                row = by_id.setdefault(stable_id, _blank_row(stable_id, task, content_type, normalized))
                if u["source"] and not row["en"]:
                    row["en"] = u["source"]
                if lang and u["target"]:
                    row[lang] = u["target"]

    rows = list(by_id.values())
    lang_columns = sorted(l for l in languages if l and l != "en")
    return rows, lang_columns


def _blank_row(stable_id: str, labels: str, content_type: str, path: str) -> dict:
    return {"identifier": stable_id, "item_id": stable_id, "labels": labels,
            "contentType": content_type, "_path": path, "en": ""}


def _id_from_row(row: dict) -> str:
    for key in row.keys():
        if _ID_RE.search(str(key or "").strip()):
            return str(row.get(key, "") or "").strip()
    first = next(iter(row.keys()), None)
    return str(row.get(first, "") or "").strip() if first else ""


# --------------------------------------------------------------------------- #
# Public entry points
# --------------------------------------------------------------------------- #
def fetch_approved_rows(approved_only: bool = True) -> Tuple[List[dict], List[str]]:
    """Returns (rows, lang_columns). rows are dicts with the merged columns."""
    return parse_zip(download_zip_bytes(approved_only=approved_only))


def write_csv(rows: List[dict], lang_columns: List[str], out_path: Path) -> None:
    headers = ["identifier", "item_id", "labels", "contentType", "_path", "en", *lang_columns]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({h: row.get(h, "") for h in headers})


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Fetch approved translations from Crowdin.")
    p.add_argument("--output", default="output/crowdin-approved.csv")
    p.add_argument("--include-unapproved", action="store_true", help="Export all translations, not just approved.")
    p.add_argument("--content-type", default="", help="Filter rows: itembank | survey | dashboard | general.")
    args = p.parse_args()

    rows, lang_columns = fetch_approved_rows(approved_only=not args.include_unapproved)
    if args.content_type:
        rows = [r for r in rows if str(r.get("contentType", "")).lower() == args.content_type.lower()]
    out = Path(args.output)
    write_csv(rows, lang_columns, out)
    print(f"[done] {len(rows)} rows, languages: {', '.join(lang_columns) or '(none)'} -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
