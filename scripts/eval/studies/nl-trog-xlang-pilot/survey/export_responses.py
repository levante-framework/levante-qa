#!/usr/bin/env python3
"""Export Study A responses from the TranslationTracker VoiceConfig inbox.

Reads rows where Service == prolific-study-a, expands Notes JSON, and writes:
  responses/submissions.csv
  responses/ratings.csv  (joinable to ../provenance.csv on identifier)

Usage:
  AIRTABLE_PAT=... python3 export_responses.py
  # or relies on ~/levante/levante-airtable/.env
"""

from __future__ import annotations

import csv
import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "responses"
BASE = "appqXfvSPAfFS0Aj2"
TABLE = "tbljCaSdUAqIRJaZb"  # VoiceConfig


def load_pat() -> str:
    if os.environ.get("AIRTABLE_PAT"):
        return os.environ["AIRTABLE_PAT"].strip()
    env = Path("/home/david/levante/levante-airtable/.env")
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("AIRTABLE_PAT="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("AIRTABLE_PAT not found")


def fetch_all(pat: str) -> list[dict]:
    rows: list[dict] = []
    offset = None
    formula = "OR({Service}='prolific-study-a',{Locale}='study-a-nl-trog')"
    while True:
        url = (
            f"https://api.airtable.com/v0/{BASE}/{TABLE}"
            f"?filterByFormula={urllib.parse.quote(formula)}"
            f"&pageSize=100"
        )
        if offset:
            url += f"&offset={urllib.parse.quote(offset)}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {pat}"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        rows.extend(data.get("records") or [])
        offset = data.get("offset")
        if not offset:
            break
    return rows


def main() -> None:
    pat = load_pat()
    records = fetch_all(pat)
    OUT.mkdir(parents=True, exist_ok=True)

    submissions = []
    ratings = []
    for rec in records:
        fields = rec.get("fields") or {}
        raw = fields.get("Notes") or ""
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        sub = payload.get("submission") or {}
        submissions.append(
            {
                "airtable_record_id": rec.get("id"),
                "submission_id": sub.get("submission_id"),
                "prolific_pid": sub.get("prolific_pid"),
                "study_id": sub.get("study_id"),
                "session_id": sub.get("session_id"),
                "started_at": sub.get("started_at"),
                "completed_at": sub.get("completed_at"),
                "n_ratings": sub.get("n_ratings"),
                "attention_ok": sub.get("attention_ok"),
                "attention_detail": sub.get("attention_detail"),
                "completion_code": sub.get("completion_code"),
            }
        )
        for r in payload.get("ratings") or []:
            ratings.append(
                {
                    "submission_id": r.get("submission_id") or sub.get("submission_id"),
                    "prolific_pid": r.get("prolific_pid") or sub.get("prolific_pid"),
                    "identifier": r.get("identifier"),
                    "item_id": r.get("item_id"),
                    "source_en": r.get("source_en"),
                    "translation": r.get("translation"),
                    "adequacy": r.get("adequacy"),
                    "appropriateness": r.get("appropriateness"),
                    "notes": r.get("notes"),
                    "is_attention_check": r.get("is_attention_check"),
                    "completed_at": r.get("completed_at"),
                }
            )

    def write_csv(path: Path, rows: list[dict]) -> None:
        if not rows:
            path.write_text("", encoding="utf-8")
            return
        cols = list(rows[0].keys())
        with path.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)

    write_csv(OUT / "submissions.csv", submissions)
    write_csv(OUT / "ratings.csv", ratings)
    print(f"Exported {len(submissions)} submissions, {len(ratings)} ratings → {OUT}")


if __name__ == "__main__":
    main()
