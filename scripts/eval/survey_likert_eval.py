#!/usr/bin/env python3
"""
Survey answer-scale check: catches broken Likert / multiple-choice option sets that
back-translation and per-string metrics (COMET/E5) miss because they score each option
in isolation and never look at the option SET.

For every survey question's answer options (e.g. Never / Rarely / Sometimes / Often /
Always, or Poor … Excellent) it checks, per locale:

  - **duplicate_options** — two English-distinct options collapse to the SAME translation
    (destroys a rating scale or merges choices). Deterministic.
  - **partial_translation** — some options in the set are translated and others are blank
    (a half-translated scale the child/parent can't use). Deterministic.
  - **scale_order_issue** — for an *ordinal* scale, the translation reorders the steps or
    flips an option's polarity (e.g. "Always" rendered at the "Never" end, or "Agree"
    translated as "Disagree"). An LLM judge first decides whether the set is ordinal, then
    whether the order/polarity is preserved — so unordered category lists (mother/father,
    gender) are never penalised.

Scales come live from Crowdin (default) or a saved export. No images or item bank needed.

    python survey_likert_eval.py --locales es-AR,de
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from pathlib import Path
from typing import Dict, List, Optional

from cache import JsonDirCache
from envload import load_env
from vocab_vision_eval import load_translation_rows, render_pdf

PROMPT_VERSION = "survey-likert-v2"

# Crowdin xliff stems that hold survey answer scales. The four big instruments use
# `<page>.q.<question>.choice.<key>.text` keys; the child self-report scale lives in
# thoughts-feelings as child-survey-response1..4.
SURVEYS = OrderedDict([
    ("caregiver-child", "caregiverchildsurvey_SHORT"),
    ("caregiver-family", "caregiverfamilysurvey_SHORT"),
    ("teacher-classroom", "teacher_survey_classroom_source_NewKeys"),
    ("teacher-general", "teacher_survey_general_source_NewKeys"),
])

CHOICE_RE = re.compile(r"^(?P<group>.*)\.choice\.(?P<choice>[^.]+)\.text$")

LIKERT_PROMPT = """You are auditing a translated answer scale from a survey for children or
parents. Below are the answer options for ONE question, in their on-screen order: the
English source and the {locale} translation at each position.

{table}

Decide whether this is an ordered rating scale and, if so, whether the translation keeps
the same order and meaning at every position. Respond with ONLY a JSON object:
{{"is_ordinal": "yes" | "no",
  "order_preserved": "yes" | "no" | "uncertain",
  "polarity_ok": "yes" | "no" | "uncertain",
  "reason": "one short sentence"}}

is_ordinal = "yes" only for a graded rating scale (e.g. never<sometimes<always,
poor<...<excellent, strongly disagree<...<strongly agree). Use "no" for unordered
categories (mother/father, gender, subjects) AND for region-specific category lists such
as education levels or school grade systems — these are expected to be ADAPTED per country
and their differences are not translation errors.

For an ordinal scale, set order_preserved = "no" ONLY if the translated options genuinely
run in a different order/direction (e.g. the "always" end and the "never" end are swapped,
or a middle step is out of sequence). Set polarity_ok = "no" ONLY if an option clearly
means a different point of the scale than the English at that position (e.g. "always" where
"sometimes" belongs, or "disagree" translating "agree").

Do NOT flag: grammatical or spelling differences (singular vs plural, articles, accents);
options that carry explicit rank markers (numbers like (4),(3),(2),(1) or 1–5) when those
markers stay in order; or regional adaptations of education/grade systems."""

# Strict second pass: the first judge over-flags wording nuance, grammar and intensity, so
# only keep an order/polarity flag when a respondent would actually land on the WRONG step.
CONFIRM_PROMPT = """An automated check flagged this {locale} survey answer scale as possibly
REORDERED or POLARITY-REVERSED versus the English source. Be strict.

{table}

Confirm ONLY if a respondent reading the {locale} options would select a SUBSTANTIALLY
WRONG point on the scale — i.e. an option sits in the wrong order position, or means a
clearly different/opposite degree than the English at that position (e.g. "always" where
"sometimes" belongs, "disagree" for "agree", or two steps swapped).

Do NOT confirm for: grammar or plural/singular (Jahr vs Jahre), accents/spelling, wording
that is merely stronger/weaker or vaguer, synonyms, or regional adaptation of
education/grade systems. Respond with ONLY: {{"confirmed": "yes" | "no", "reason": "one short sentence"}}"""


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


class SurveyLikertJudge:
    def __init__(self, model_name: str = "gemini-2.5-flash", fallback_model: str = "gemini-flash-latest",
                 cache_dir: str = "output/survey_likert_cache", timeout: int = 90):
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

    def _post(self, model: str, prompt: str) -> str:
        payload = {"contents": [{"parts": [{"text": prompt}]}],
                   "generationConfig": {"temperature": 0, "responseMimeType": "application/json",
                                        "thinkingConfig": {"thinkingBudget": 0}}}
        url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
               f"{model}:generateContent?key={self.api_key}")
        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["candidates"][0]["content"]["parts"][0]["text"]

    def _call(self, prompt: str) -> str:
        try:
            return self._post(self.model_name, prompt)
        except urllib.error.HTTPError as exc:
            if self.fallback_model and exc.code in {400, 404, 429, 503}:
                return self._post(self.fallback_model, prompt)
            raise

    def judge(self, en_opts: List[str], loc_opts: List[str], locale: str,
              max_retries: int = 3) -> Dict:
        key = JsonDirCache.make_key(PROMPT_VERSION, self.model_name, locale,
                                    "||".join(en_opts), "||".join(loc_opts))
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        table = "\n".join(f"{i+1}. EN = {e!r}   |   {locale} = {l!r}"
                          for i, (e, l) in enumerate(zip(en_opts, loc_opts)))
        prompt = LIKERT_PROMPT.format(locale=locale, table=table)
        last = ""
        for attempt in range(max_retries):
            try:
                p = json.loads(self._call(prompt))
                out = {"is_ordinal": str(p.get("is_ordinal", "")).strip().lower(),
                       "order_preserved": str(p.get("order_preserved", "")).strip().lower(),
                       "polarity_ok": str(p.get("polarity_ok", "")).strip().lower(),
                       "reason": str(p.get("reason", "") or ""), "error": None}
                self.cache.set(key, out)
                return out
            except json.JSONDecodeError as exc:
                last = f"JSON parse: {exc}"
            except Exception as exc:  # noqa: BLE001
                last = f"{type(exc).__name__}: {exc}"
            time.sleep(2 ** attempt)
        return {"is_ordinal": "", "order_preserved": "", "polarity_ok": "", "reason": "",
                "error": last}

    def confirm(self, en_opts: List[str], loc_opts: List[str], locale: str,
                max_retries: int = 3) -> Dict:
        key = JsonDirCache.make_key(PROMPT_VERSION, "confirm", self.model_name, locale,
                                    "||".join(en_opts), "||".join(loc_opts))
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        table = "\n".join(f"{i+1}. EN = {e!r}   |   {locale} = {l!r}"
                          for i, (e, l) in enumerate(zip(en_opts, loc_opts)))
        prompt = CONFIRM_PROMPT.format(locale=locale, table=table)
        last = ""
        for attempt in range(max_retries):
            try:
                p = json.loads(self._call(prompt))
                out = {"confirmed": str(p.get("confirmed", "")).strip().lower(),
                       "reason": str(p.get("reason", "") or "")}
                self.cache.set(key, out)
                return out
            except Exception as exc:  # noqa: BLE001
                last = f"{type(exc).__name__}: {exc}"
            time.sleep(2 ** attempt)
        return {"confirmed": "", "reason": last}


def extract_groups(rows: List[dict]) -> List[dict]:
    """Discover answer-option groups (ordered) from the survey xliffs in the export.
    Each group: {survey, group_key, title_en, choices=[{choice, en, vals:{locale:str}}]}."""
    locales_all = [k for k in rows[0].keys() if k not in
                   ("identifier", "item_id", "labels", "contentType", "_path", "en")]
    groups: List[dict] = []

    for survey, stem in SURVEYS.items():
        srows = [r for r in rows if stem in (r.get("identifier", "") + r.get("_path", ""))]
        key_en = {r["identifier"].split("::")[-1]: r for r in srows}
        by_group: "OrderedDict[str, list]" = OrderedDict()
        for r in srows:
            k = r["identifier"].split("::")[-1]
            m = CHOICE_RE.match(k)
            if m:
                by_group.setdefault(m.group("group"), []).append(r)
        for gkey, choice_rows in by_group.items():
            if len(choice_rows) < 2:
                continue
            title_row = key_en.get(gkey + ".title")
            choices = [{"choice": CHOICE_RE.match(r["identifier"].split("::")[-1]).group("choice"),
                        "ident": r.get("item_id") or r.get("identifier", ""),
                        "en": (r.get("en") or "").strip(),
                        "vals": {loc: (r.get(loc) or "").strip() for loc in locales_all}}
                       for r in choice_rows]
            groups.append({"survey": survey, "group_key": gkey.split(".")[-1],
                           "title_en": (title_row.get("en") if title_row else "") or "",
                           "choices": choices})

    # Child self-report rating scale (thoughts-feelings child-survey-responseN).
    resp = {}
    for r in rows:
        if "thoughts-feelings.xliff" not in r.get("identifier", ""):
            continue
        m = re.match(r"child-survey-response(\d+)$", r["identifier"].split("::")[-1])
        if m:
            resp[int(m.group(1))] = r
    if len(resp) >= 2:
        choices = [{"choice": f"response{i}",
                    "ident": resp[i].get("item_id") or resp[i].get("identifier", ""),
                    "en": (resp[i].get("en") or "").strip(),
                    "vals": {loc: (resp[i].get(loc) or "").strip() for loc in locales_all}}
                   for i in sorted(resp)]
        groups.append({"survey": "child-survey", "group_key": "rating-scale",
                       "title_en": "Child self-report rating scale", "choices": choices})
    return groups


def check_group(group: dict, locale: str, judge: Optional[SurveyLikertJudge]) -> List[dict]:
    """Deterministic structural checks + (for fully-translated 3+ option sets) the LLM
    ordinal order/polarity judge. Returns a row per detected issue."""
    choices = group["choices"]
    en_opts = [c["en"] for c in choices]
    loc_opts = [c["vals"].get(locale, "") for c in choices]
    # en-* variants leave a string blank to inherit the English source at runtime, so a
    # blank there is not a missing/partial translation — fill it with the source.
    if locale.lower().startswith("en"):
        loc_opts = [l or e for e, l in zip(en_opts, loc_opts)]
    n = len(choices)
    n_tr = sum(1 for v in loc_opts if v)
    base = {"survey": group["survey"], "group": group["group_key"],
            "title_en": group["title_en"], "locale": locale,
            "n_options": n, "en_scale": " | ".join(en_opts),
            "locale_scale": " | ".join(loc_opts)}
    if n_tr == 0:
        return []  # not translated for this locale -> not applicable
    issues: List[dict] = []
    if 0 < n_tr < n:
        miss = [en_opts[i] for i, v in enumerate(loc_opts) if not v]
        issues.append({**base, "issue": "partial_translation",
                       "detail": f"{n - n_tr}/{n} options untranslated: {miss}"})
    # Duplicate translations of English-distinct options.
    seen: Dict[str, str] = {}
    dupes = []
    for e, l in zip(en_opts, loc_opts):
        if not l:
            continue
        nl = _norm(l)
        if nl in seen and _norm(seen[nl]) != _norm(e):
            dupes.append(f"{seen[nl]!r} & {e!r} -> {l!r}")
        else:
            seen[nl] = e
    if dupes:
        issues.append({**base, "issue": "duplicate_options",
                       "detail": "; ".join(dupes)})
    # Ordinal order/polarity (only when fully translated and >=3 steps).
    if judge is not None and n_tr == n and n >= 3:
        v = judge.judge(en_opts, loc_opts, locale)
        if v["is_ordinal"] == "yes" and (v["order_preserved"] == "no" or v["polarity_ok"] == "no"):
            g = judge.confirm(en_opts, loc_opts, locale)
            if g["confirmed"] == "yes":
                issues.append({**base, "issue": "scale_order_issue",
                               "detail": g["reason"] or v["reason"]})
    return issues


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Survey Likert/answer-scale order, polarity & integrity check.")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--from-crowdin", action="store_true",
                     help="(Default) Pull approved translations live from Crowdin.")
    src.add_argument("--translations-csv", default=None,
                     help="Use a saved Crowdin export CSV instead of pulling live.")
    p.add_argument("--locales", default="es-AR", help="Comma-separated locales (column names).")
    p.add_argument("--no-llm", action="store_true",
                   help="Only run the deterministic checks (duplicates / partial); skip the ordinal judge.")
    p.add_argument("--output-dir", default="output")
    p.add_argument("--no-pdf", action="store_true", help="Skip rendering the report PDF.")
    args = p.parse_args()

    rows = load_translation_rows(args)
    groups = extract_groups(rows)
    locales = [l.strip() for l in args.locales.split(",") if l.strip()]
    print(f"[survey] {len(groups)} answer-option groups across {len(SURVEYS) + 1} survey(s).")

    judge = None if args.no_llm else SurveyLikertJudge()
    all_rows: List[dict] = []
    from tqdm import tqdm
    for g in tqdm(groups, desc="survey"):
        for loc in locales:
            all_rows.extend(check_group(g, loc, judge))

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    field_order = ["survey", "group", "title_en", "locale", "issue", "detail",
                   "n_options", "en_scale", "locale_scale"]
    import csv
    with (out_dir / "survey-likert-all.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=field_order, extrasaction="ignore")
        w.writeheader()
        w.writerows(all_rows)
    report = out_dir / "survey-likert-report.md"
    write_markdown_report(all_rows, report, locales, len(groups))
    pdf = out_dir / "survey-likert-report.pdf"
    pdf_ok = render_pdf(report, pdf, title="Survey Answer-Scale (Likert) Report") if not args.no_pdf else False

    import collections
    by_issue = collections.Counter(r["issue"] for r in all_rows)
    print(f"\n[done] {len(groups)} groups × {len(locales)} locale(s): "
          f"{len(all_rows)} issue(s) -> {dict(by_issue)}")
    print(f"       CSV -> {out_dir / 'survey-likert-all.csv'}")
    print(f"       report -> {report}")
    if pdf_ok:
        print(f"       pdf -> {pdf}")
    return 0


ISSUE_TITLES = OrderedDict([
    ("scale_order_issue", "Scale order / polarity issues (ordinal scales)"),
    ("duplicate_options", "Duplicate option translations (collapsed choices)"),
    ("partial_translation", "Partially-translated option sets"),
])


def write_markdown_report(all_rows: List[dict], path: Path, locales: List[str], n_groups: int) -> None:
    def cell(s: str) -> str:
        return (s or "").replace("|", "\\|").replace("\n", " ").strip()

    lines = ["# Survey answer-scale (Likert) report", ""]
    lines.append(f"- Locales checked: {', '.join(locales)}")
    lines.append(f"- Answer-option groups: {n_groups}  ·  issues found: {len(all_rows)}")
    lines.append("")
    lines.append("Catches broken answer SETS that per-string metrics miss: options whose "
                 "translations **collapse** (two distinct English choices → one string), "
                 "**half-translated** scales, and **ordinal scales reordered or flipped** in "
                 "polarity. Unordered category lists are not penalised for order.")
    lines.append("")
    for issue, title in ISSUE_TITLES.items():
        rs = [r for r in all_rows if r["issue"] == issue]
        lines.append(f"## {title} — {len(rs)}")
        lines.append("")
        if not rs:
            lines.append("_None._")
            lines.append("")
            continue
        lines.append("| survey | question | locale | English scale | translated scale | detail |")
        lines.append("|---|---|---|---|---|---|")
        for r in sorted(rs, key=lambda x: (x["survey"], x["group"], x["locale"])):
            q = r["title_en"] or r["group"]
            lines.append(f"| {cell(r['survey'])} | {cell(q)[:60]} | {r['locale']} | "
                         f"{cell(r['en_scale'])} | {cell(r['locale_scale'])} | {cell(r['detail'])} |")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
