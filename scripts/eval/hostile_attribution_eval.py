#!/usr/bin/env python3
"""
Hostile-attribution construct check: this social-reasoning task only measures what it should
if the translated ANSWER OPTIONS keep their scoring structure. Per-string metrics (COMET/E5)
score each option alone and can't see that, e.g., the "aggressive" choice is still the
aggressive one or that the intent anchors aren't swapped.

Each of the 3 scenes presents an ambiguous provocation, then asks two questions:
  - an **attribution question** — "on purpose or by accident?" (keyed answer: *on purpose*);
  - an **action question** — pick one of three responses, one of which is the keyed
    *aggressive/retaliatory* choice (e.g. "push the boy in the mud"), the others
    prosocial/constructive or passive/avoidant.

So, per locale, it checks:
  - **intent_anchor_issue** — the two intent options no longer distinctly/correctly mean
    "on purpose" (deliberate) vs "by accident" (unintentional), or are swapped.
  - **action_valence_issue** — a response option's social valence changed in translation
    (especially: the keyed aggressive option is no longer clearly aggressive, or another
    option became aggressive), which would corrupt the hostile-attribution score.
  - **duplicate_options / partial_translation** — options collapsed to one string or a
    half-translated option set (deterministic).

An LLM judge does the valence/intent reasoning; a strict confirmation gate then drops
wording/grammar nuisance flags (same precision pattern as the TROG / survey checks).

Structure (which option is keyed, option order, scene grouping) comes from the live item
bank; option text comes from Crowdin. Both keyed by the same ids.

    python hostile_attribution_eval.py --locales es-AR,de
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import urllib.error
from collections import OrderedDict
from pathlib import Path
from typing import Dict, List, Optional

from cache import JsonDirCache
from envload import load_env
from survey_likert_eval import SurveyLikertJudge, _norm
from vocab_vision_eval import load_translation_rows, render_pdf

PROMPT_VERSION = "hostile-attr-v1"
XLIFF_STEM = "hostile-attribution.xliff"


def ha_corpus_url(bucket: str = "levante-assets-dev") -> str:
    return (f"https://storage.googleapis.com/{bucket}/corpus/"
            "hostile-attribution/hostile-attribution-item-bank.csv")


INTENT_PROMPT = """A children's social-reasoning task describes an ambiguous event, then asks
whether it was deliberate or accidental. Context (English): {context}

The two answer options are shown as English source and {locale} translation:
1. EN = {en0!r}   |   {locale} = {loc0!r}
2. EN = {en1!r}   |   {locale} = {loc1!r}

Do the two {locale} options correctly and DISTINCTLY express the same two intents as English
— one clearly "on purpose / deliberate", the other clearly "by accident / unintentional" —
each matching its own position (not swapped, not merged, neither vague)? Respond with ONLY:
{{"ok": "yes" | "no", "reason": "one short sentence"}}"""

ACTION_PROMPT = """A children's social-reasoning task describes an ambiguous provocation, then
asks the child to pick what they would do. Each option reflects a social RESPONSE STYLE:
aggressive/retaliatory, prosocial/constructive, or passive/avoidant. Context (English):
{context}

Options as English source and {locale} translation (option {keyed} is the scored
AGGRESSIVE/retaliatory choice):
{table}

Does each {locale} option preserve the SAME response style as its English counterpart — in
particular, option {keyed} stays CLEARLY aggressive/retaliatory and NO other option becomes
aggressive? Respond with ONLY:
{{"ok": "yes" | "no", "reason": "one short sentence"}}"""

CONFIRM_INTENT_PROMPT = """An automated check flagged this {locale} pair of intent options as
possibly wrong or swapped versus English. Be strict.

1. EN = {en0!r}   |   {locale} = {loc0!r}
2. EN = {en1!r}   |   {locale} = {loc1!r}

Confirm ONLY if a child would actually misread the intent — i.e. an option means the opposite
intent, the two are swapped, or one no longer clearly means deliberate vs accidental. Do NOT
confirm for grammar, politeness, synonyms or minor wording. Respond with ONLY:
{{"confirmed": "yes" | "no", "reason": "one short sentence"}}"""

CONFIRM_ACTION_PROMPT = """An automated check flagged this {locale} response set as possibly
changing an option's social valence versus English. Be strict.

{table}
(Option {keyed} is the scored AGGRESSIVE/retaliatory choice.)

Confirm ONLY if the response STYLE actually changed — i.e. the keyed option is no longer
clearly aggressive/retaliatory, or a non-keyed option became aggressive. Do NOT confirm for
grammar, intensity, register, synonyms or minor wording. Respond with ONLY:
{{"confirmed": "yes" | "no", "reason": "one short sentence"}}"""


class HostileAttributionJudge:
    """Thin wrapper reusing the survey judge's Gemini/text plumbing + cache."""

    def __init__(self, cache_dir: str = "output/hostile_attribution_cache"):
        self._g = SurveyLikertJudge(cache_dir=cache_dir)

    def _ask(self, prompt: str, fields: tuple, max_retries: int = 3) -> Dict:
        key = JsonDirCache.make_key(PROMPT_VERSION, prompt)
        cached = self._g.cache.get(key)
        if cached is not None:
            return cached
        last = ""
        for attempt in range(max_retries):
            try:
                p = json.loads(self._g._call(prompt))
                out = {f: str(p.get(f, "") or "").strip().lower() if f != "reason"
                       else str(p.get("reason", "") or "") for f in fields}
                self._g.cache.set(key, out)
                return out
            except json.JSONDecodeError as exc:
                last = f"JSON parse: {exc}"
            except Exception as exc:  # noqa: BLE001
                last = f"{type(exc).__name__}: {exc}"
            time.sleep(2 ** attempt)
        return {f: "" for f in fields} | {"reason": last}

    def intent(self, ctx, en, loc, locale) -> Dict:
        return self._ask(INTENT_PROMPT.format(context=ctx, locale=locale, en0=en[0], en1=en[1],
                                              loc0=loc[0], loc1=loc[1]), ("ok", "reason"))

    def confirm_intent(self, en, loc, locale) -> Dict:
        return self._ask(CONFIRM_INTENT_PROMPT.format(locale=locale, en0=en[0], en1=en[1],
                                                      loc0=loc[0], loc1=loc[1]), ("confirmed", "reason"))

    def action(self, ctx, table, keyed, locale) -> Dict:
        return self._ask(ACTION_PROMPT.format(context=ctx, locale=locale, table=table, keyed=keyed),
                         ("ok", "reason"))

    def confirm_action(self, table, keyed, locale) -> Dict:
        return self._ask(CONFIRM_ACTION_PROMPT.format(locale=locale, table=table, keyed=keyed),
                         ("confirmed", "reason"))


def load_scenes(corpus_csv: str) -> List[dict]:
    """Parse the item bank into scenes: ordered intent/action option ids + keyed answer +
    narration ids, grouped by block_index."""
    if corpus_csv.startswith("http"):
        import urllib.request
        with urllib.request.urlopen(corpus_csv, timeout=60) as resp:
            text = resp.read().decode("utf-8-sig")
        rows = list(csv.DictReader(text.splitlines()))
    else:
        rows = list(csv.DictReader(open(corpus_csv, encoding="utf-8-sig")))
    by_block: "OrderedDict[str, dict]" = OrderedDict()
    for r in rows:
        if r.get("task") != "hostile-attribution":
            continue
        b = r.get("block_index", "")
        sc = by_block.setdefault(b, {"block": b, "narration": [], "q1": None, "q2": None})
        tt = r.get("trial_type", "")
        if tt == "instructions" and (r.get("item_id", "").startswith("hostile-attribution-scene")):
            sc["narration"].append(r["item_id"])
        elif tt == "attribution_question":
            sc["q1"] = {"id": r["item_id"], "prompt_id": r["item_id"],
                        "alts": [a for a in r["response_alternatives"].split(",") if a],
                        "answer": r["answer"]}
        elif tt == "action_question":
            sc["q2"] = {"id": r["item_id"], "prompt_id": r["item_id"],
                        "alts": [a for a in r["response_alternatives"].split(",") if a],
                        "answer": r["answer"]}
    return [s for s in by_block.values() if s["q1"] or s["q2"]]


def _txt(tmap: Dict[str, dict], _id: str, locale: str, en_fallback: bool) -> str:
    row = tmap.get(_id, {})
    v = (row.get(locale) or "").strip()
    if not v and en_fallback:
        v = (row.get("en") or "").strip()
    return v


def _context(tmap, scene, q) -> str:
    parts = [(tmap.get(i, {}).get("en") or "").strip() for i in scene["narration"]]
    parts.append((tmap.get(q["prompt_id"], {}).get("en") or "").strip())
    return " ".join(p for p in parts if p)


def _dup_partial(en_opts, loc_opts, base) -> List[dict]:
    issues = []
    n, n_tr = len(loc_opts), sum(1 for v in loc_opts if v)
    if n_tr == 0:
        return []
    if 0 < n_tr < n:
        miss = [en_opts[i] for i, v in enumerate(loc_opts) if not v]
        issues.append({**base, "issue": "partial_translation",
                       "detail": f"{n - n_tr}/{n} options untranslated: {miss}"})
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
        issues.append({**base, "issue": "duplicate_options", "detail": "; ".join(dupes)})
    return issues


def check_scene(scene: dict, tmap: Dict[str, dict], locale: str,
                judge: Optional[HostileAttributionJudge]) -> List[dict]:
    en_fb = locale.lower().startswith("en")
    issues: List[dict] = []
    scene_no = scene["block"]

    if scene["q1"]:
        q = scene["q1"]
        en = [(tmap.get(a, {}).get("en") or "").strip() for a in q["alts"]]
        loc = [_txt(tmap, a, locale, en_fb) for a in q["alts"]]
        base = {"scene": scene_no, "question": "attribution (intent)", "locale": locale,
                "en_options": " | ".join(en), "locale_options": " | ".join(loc),
                "ids": ",".join(q["alts"])}
        issues += _dup_partial(en, loc, base)
        if judge is not None and all(loc):
            v = judge.intent(_context(tmap, scene, q), en, loc, locale)
            if v["ok"] == "no":
                g = judge.confirm_intent(en, loc, locale)
                if g["confirmed"] == "yes":
                    issues.append({**base, "issue": "intent_anchor_issue",
                                   "detail": g["reason"] or v["reason"]})

    if scene["q2"]:
        q = scene["q2"]
        en = [(tmap.get(a, {}).get("en") or "").strip() for a in q["alts"]]
        loc = [_txt(tmap, a, locale, en_fb) for a in q["alts"]]
        keyed = q["alts"].index(q["answer"]) + 1 if q["answer"] in q["alts"] else 0
        base = {"scene": scene_no, "question": "action (valence)", "locale": locale,
                "en_options": " | ".join(en), "locale_options": " | ".join(loc),
                "ids": ",".join(q["alts"])}
        issues += _dup_partial(en, loc, base)
        if judge is not None and all(loc) and keyed:
            table = "\n".join(f"{i+1}. EN = {e!r}   |   {locale} = {l!r}"
                              for i, (e, l) in enumerate(zip(en, loc)))
            v = judge.action(_context(tmap, scene, q), table, keyed, locale)
            if v["ok"] == "no":
                g = judge.confirm_action(table, keyed, locale)
                if g["confirmed"] == "yes":
                    issues.append({**base, "issue": "action_valence_issue",
                                   "detail": g["reason"] or v["reason"]})
    return issues


ISSUE_TITLES = OrderedDict([
    ("action_valence_issue", "Action response-valence changed (corrupts scoring)"),
    ("intent_anchor_issue", "Intent anchors wrong / swapped"),
    ("duplicate_options", "Duplicate option translations (collapsed choices)"),
    ("partial_translation", "Partially-translated option sets"),
])


def write_markdown_report(all_rows, path: Path, locales, n_scenes) -> None:
    def cell(s):
        return (s or "").replace("|", "\\|").replace("\n", " ").strip()

    lines = ["# Hostile-attribution construct report", "",
             f"- Locales checked: {', '.join(locales)}",
             f"- Scenes: {n_scenes}  ·  issues found: {len(all_rows)}", "",
             "Checks that the translated answer SETS keep the task's scoring structure: the "
             "intent anchors stay correct/distinct (*on purpose* vs *by accident*) and each "
             "action option keeps its social valence (the keyed *aggressive* option stays "
             "aggressive). An LLM judge + strict confirmation gate keep precision high.", ""]
    for issue, title in ISSUE_TITLES.items():
        rs = [r for r in all_rows if r["issue"] == issue]
        lines.append(f"## {title} — {len(rs)}")
        lines.append("")
        if not rs:
            lines.append("_None._")
            lines.append("")
            continue
        lines.append("| scene | question | locale | English options | translated options | detail |")
        lines.append("|---|---|---|---|---|---|")
        for r in sorted(rs, key=lambda x: (x["scene"], x["question"], x["locale"])):
            lines.append(f"| {cell(r['scene'])} | {cell(r['question'])} | {r['locale']} | "
                         f"{cell(r['en_options'])} | {cell(r['locale_options'])} | {cell(r['detail'])} |")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Hostile-attribution intent/valence construct check.")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--from-crowdin", action="store_true",
                     help="(Default) Pull approved translations live from Crowdin.")
    src.add_argument("--translations-csv", default=None, help="Use a saved Crowdin export CSV.")
    p.add_argument("--locales", default="es-AR", help="Comma-separated locales (column names).")
    p.add_argument("--gcs-bucket", default="levante-assets-dev")
    p.add_argument("--corpus-csv", default=None,
                   help="Override the item bank source (local path or URL). Default: live GCS.")
    p.add_argument("--no-llm", action="store_true",
                   help="Deterministic only (duplicate/partial); skip the intent/valence judge.")
    p.add_argument("--output-dir", default="output")
    p.add_argument("--no-pdf", action="store_true")
    args = p.parse_args()

    rows = load_translation_rows(args)
    tmap = {r["identifier"].split("::")[-1]: r for r in rows if XLIFF_STEM in r.get("identifier", "")}
    corpus = args.corpus_csv or ha_corpus_url(args.gcs_bucket)
    scenes = load_scenes(corpus)
    locales = [l.strip() for l in args.locales.split(",") if l.strip()]
    print(f"[hostile] {len(scenes)} scenes; {len(tmap)} translated strings; item bank: {corpus}")

    judge = None if args.no_llm else HostileAttributionJudge()
    all_rows: List[dict] = []
    from tqdm import tqdm
    for s in tqdm(scenes, desc="hostile-attr"):
        for loc in locales:
            all_rows.extend(check_scene(s, tmap, loc, judge))

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    field_order = ["scene", "question", "locale", "issue", "detail",
                   "en_options", "locale_options", "ids"]
    with (out_dir / "hostile-attribution-all.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=field_order, extrasaction="ignore")
        w.writeheader()
        w.writerows(all_rows)
    report = out_dir / "hostile-attribution-report.md"
    write_markdown_report(all_rows, report, locales, len(scenes))
    pdf = out_dir / "hostile-attribution-report.pdf"
    pdf_ok = render_pdf(report, pdf, title="Hostile-Attribution Construct Report") if not args.no_pdf else False

    import collections
    by_issue = collections.Counter(r["issue"] for r in all_rows)
    print(f"\n[done] {len(scenes)} scenes × {len(locales)} locale(s): "
          f"{len(all_rows)} issue(s) -> {dict(by_issue)}")
    print(f"       CSV -> {out_dir / 'hostile-attribution-all.csv'}")
    print(f"       report -> {report}")
    if pdf_ok:
        print(f"       pdf -> {pdf}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
