#!/usr/bin/env python3
"""
Tiered advisory review queue for approved translations.

Turns the validated stack into a ranked work list the translation team can act on,
spending API budget only where it matters:

  Tier 1 (cheap, runs on EVERYTHING): E5 direct cosine + COMET-QE -> adequacy flag.
  Tier 2 (MQM, runs only on the flagged tail, capped): -> appropriateness flag.

Flag thresholds come from scoring-config.json (see calibrate_thresholds.py). Each
row gets a tier:
  likely_bad : both adequacy and appropriateness flagged
  review     : exactly one axis flagged
  ok         : neither

Output is sorted worst-first. Tier 2 only sees Tier-1-flagged items, so an
appropriateness-only problem in an otherwise faithful translation can be missed;
raise --mqm-sample to also MQM a random slice of the un-flagged rows if you want
broader appropriateness coverage.

    python review_queue.py --locales es-AR --max-mqm 300   # live Crowdin (default)
    python review_queue.py --input-csv output/crowdin-approved.csv --locales es-AR,de \
        --tier1-only           # saved snapshot; free pass, adequacy ranking only
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from pathlib import Path
from typing import Dict, List, Optional

from envload import load_env

FIXED_COLS = {"identifier", "item_id", "labels", "contentType", "_path", "en"}
OUT_COLS = ["tier", "priority", "item_id", "locale", "contentType", "source_en", "translation",
            "e5_direct", "comet", "adequacy_flag", "vision_match", "mqm_score", "mqm_major",
            "appropriateness_flag", "reasons"]


def load_rows(args) -> tuple[List[dict], List[str]]:
    # Default: pull approved translations live from Crowdin. A saved CSV is used only
    # when --input-csv is given explicitly.
    if not args.input_csv:
        print("[queue] pulling approved translations live from Crowdin (--from-crowdin default)")
        from crowdin_source import fetch_approved_rows
        return fetch_approved_rows(approved_only=not args.include_unapproved)
    path = Path(args.input_csv)
    if not path.is_file():
        sys.exit(f"--input-csv not found: {path}")
    print(f"[queue] reading saved Crowdin export: {path}")
    with path.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    langs = sorted({h for r in rows for h in r.keys()} - FIXED_COLS) if rows else []
    return rows, [l for l in langs if l]


def main() -> int:
    load_env()
    p = argparse.ArgumentParser(description="Tiered advisory translation review queue.")
    # WORDS (translations) source. Default = live Crowdin.
    src = p.add_mutually_exclusive_group()
    src.add_argument("--from-crowdin", action="store_true",
                     help="(Default) Pull approved translations live from Crowdin. The live "
                          "pull happens unless --input-csv is given.")
    src.add_argument("--input-csv",
                     help="Use a saved Crowdin export CSV instead of pulling live, "
                          "e.g. output/crowdin-approved.csv.")
    p.add_argument("--include-unapproved", action="store_true")
    p.add_argument("--locales", required=True, help="Comma-separated target locales.")
    p.add_argument("--config", default="output/scoring-config.json")
    p.add_argument("--tier1-only", action="store_true", help="Skip MQM (free adequacy pass).")
    p.add_argument("--no-vocab-vision", action="store_true",
                   help="Don't use the word-vs-image vision check for vocab (fall back to COMET/E5).")
    p.add_argument("--image-source", choices=["gcs", "local"], default="gcs",
                   help="Vocab answer images: deployed GCS bucket (default) or local dir.")
    p.add_argument("--gcs-bucket", default="levante-assets-dev")
    p.add_argument("--gcs-prefix", default="visual/vocab/")
    p.add_argument("--vocab-image-dir",
                   default="../../../core-task-assets/vocab/original,../../../core-task-assets/vocab/images",
                   help="Comma-separated local image dir(s) for --image-source local.")
    p.add_argument("--corpus-csv",
                   default="../../../crowdin-projects/corpora/vocab-test/shared/corpora/vocab-item-bank.csv",
                   help="Vocab item-bank with the IRT `d` difficulty column.")
    p.add_argument("--hard-difficulty", type=float, default=1.0,
                   help="Vocab items with IRT d >= this aren't flagged just for being hard.")
    p.add_argument("--no-trog-vision", action="store_true",
                   help="Don't use the sentence-vs-pictures vision check for TROG.")
    p.add_argument("--trog-gcs-prefix", default="visual/trog/")
    p.add_argument("--trog-image-dir", default="../../../core-task-assets/TROG/original",
                   help="Comma-separated local image dir(s) for --image-source local (TROG).")
    p.add_argument("--trog-corpus-csv", default=None,
                   help="Override the TROG item bank source (local path or URL). Default: pull "
                        "live from gs://<gcs-bucket>/corpus/trog/trog-item-bank.csv.")
    p.add_argument("--no-tom-vision", action="store_true",
                   help="Don't use the story-vs-pictures vision check for Theory-of-Mind (Stories).")
    p.add_argument("--tom-gcs-prefix", default="visual/theory-of-mind/")
    p.add_argument("--tom-image-dir", default="../../../core-task-assets/theory-of-mind/original",
                   help="Comma-separated local image dir(s) for --image-source local (ToM).")
    p.add_argument("--tom-corpus-csv", default=None,
                   help="Override the ToM item bank source (local path or URL). Default: pull "
                        "live from gs://<gcs-bucket>/corpus/theory-of-mind/theory-of-mind-item-bank.csv.")
    p.add_argument("--no-samediff-vision", action="store_true",
                   help="Don't use the instruction-vs-cards vision check for Same-Different.")
    p.add_argument("--samediff-gcs-prefix", default="visual/same-different-selection/")
    p.add_argument("--samediff-image-dir", default="../../../core-task-assets/same-different-selection/original",
                   help="Comma-separated local image dir(s) for --image-source local (SDS).")
    p.add_argument("--samediff-corpus-csv", default=None,
                   help="Override the SDS item bank source (local path or URL). Default: pull live "
                        "from gs://<gcs-bucket>/corpus/same-different-selection/same-different-selection-item-bank.csv.")
    p.add_argument("--no-survey-likert", action="store_true",
                   help="Don't run the survey answer-scale (Likert order/polarity/integrity) check.")
    p.add_argument("--survey-likert-no-llm", action="store_true",
                   help="Survey check: deterministic only (duplicate/partial); skip the ordinal LLM judge.")
    p.add_argument("--no-hostile-attribution", action="store_true",
                   help="Don't run the hostile-attribution intent/valence construct check.")
    p.add_argument("--hostile-no-llm", action="store_true",
                   help="Hostile-attribution: deterministic only; skip the intent/valence LLM judge.")
    p.add_argument("--hostile-corpus-csv", default=None,
                   help="Override the hostile-attribution item bank source (default: live GCS).")
    p.add_argument("--max-mqm", type=int, default=300, help="Cap MQM calls (Tier 2 budget).")
    p.add_argument("--mqm-sample", type=int, default=0,
                   help="Also MQM this many random non-flagged rows (appropriateness coverage).")
    p.add_argument("--limit", type=int, default=0, help="Cap candidates (debug).")
    p.add_argument("--seed", type=int, default=20260627)
    p.add_argument("--output", default="output/review-queue.csv")
    args = p.parse_args()

    cfg = json.loads(Path(args.config).read_text(encoding="utf-8")) if Path(args.config).is_file() else {}
    t_e5 = (cfg.get("adequacy", {}).get("e5_direct_sim") or {}).get("threshold")
    t_comet = (cfg.get("adequacy", {}).get("comet_qe") or {}).get("threshold")
    t_mqm = (cfg.get("appropriateness", {}).get("mqm_score") or {}).get("threshold")
    if t_e5 is None or t_comet is None:
        sys.exit(f"No adequacy thresholds in {args.config}; run calibrate_thresholds.py first.")

    locales = [l.strip() for l in args.locales.split(",") if l.strip()]
    rows, _ = load_rows(args)
    cands: List[dict] = []
    for row in rows:
        src_en = (row.get("en") or "").strip()
        if not src_en:
            continue
        for loc in locales:
            tgt = (row.get(loc) or "").strip()
            if tgt:
                cands.append({"item_id": row.get("item_id", ""), "locale": loc,
                              "contentType": row.get("contentType", ""), "source_en": src_en,
                              "translation": tgt})
    if args.limit:
        cands = cands[:args.limit]
    if not cands:
        sys.exit("No candidates for the requested locales.")
    print(f"[queue] {len(cands)} candidate segments.")

    # Tier 1: cheap adequacy on everything.
    from embedding_eval import EmbeddingEvaluator
    emb = EmbeddingEvaluator()
    e5 = [float(x) for x in emb.evaluate_batch([c["source_en"] for c in cands], [c["translation"] for c in cands])]
    from comet_eval import CometQEEvaluator
    comet = [float(x) for x in CometQEEvaluator().evaluate_batch([c["source_en"] for c in cands], [c["translation"] for c in cands])]
    for c, a, b in zip(cands, e5, comet):
        c["e5_direct"] = round(a, 4)
        c["comet"] = round(b, 4)
        c["adequacy_flag"] = 1 if (a < t_e5 or b < t_comet) else 0
        c["vision_match"] = ""
        c["is_vocab"] = False
        c["is_trog"] = False
        c["is_tom"] = False
        c["is_samediff"] = False
        c["is_survey"] = False
        c["is_hostile"] = False
        c["mqm_score"] = ""
        c["mqm_major"] = ""
        c["appropriateness_flag"] = ""

    # Vocab vision: single words are image-backed and COMET/E5 over-flag them, so
    # for vocab the adequacy verdict comes from "does the word name the picture?".
    if not args.no_vocab_vision:
        from vocab_vision_eval import (VocabVisionEvaluator, ImageResolver,
                                       load_difficulty, load_distractors, normalize_en, _vid)
        resolver = ImageResolver(args.image_source, local_dirs=args.vocab_image_dir,
                                 bucket=args.gcs_bucket, prefix=args.gcs_prefix)
        difficulty = load_difficulty(args.corpus_csv)
        distractors = load_distractors(args.corpus_csv)
        print(f"[queue] vocab images: {len(resolver)} from {resolver.label}")
        vocab = []
        for c in cands:
            vid = _vid(c["item_id"])
            en_word = normalize_en(c["source_en"])
            img = resolver.resolve(en_word) if en_word else None
            if vid and img:
                c["is_vocab"] = True
                c["_en_word"] = en_word
                c["_image"] = img
                d = difficulty.get(vid)
                c["_is_hard"] = d is not None and d >= args.hard_difficulty
                c["_distractors"] = distractors.get(vid)
                vocab.append(c)
        if vocab:
            print(f"[queue] vocab vision: word-vs-image on {len(vocab)} vocab items.")
            from tqdm import tqdm
            vev = VocabVisionEvaluator()
            for c in tqdm(vocab, desc="vision"):
                res = vev.evaluate(c["_en_word"], c["translation"], c["locale"], c["_image"],
                                   is_hard=c["_is_hard"], distractors=c["_distractors"])
                c["vision_match"] = res["match"]
                # vision REPLACES COMET/E5 for vocab: flag only a true word/image mismatch.
                c["adequacy_flag"] = 1 if res["match"] == "no" else 0

    # TROG vision: sentence-comprehension items are picture-backed minimal-pair choices,
    # so adequacy = "does the translated sentence still pick the keyed picture?" (4-AFC +
    # an English control + a single-image confirmation gate). Like vocab, this REPLACES
    # COMET/E5 for these items.
    if not args.no_trog_vision:
        from trog_vision_eval import (TrogVisionEvaluator, load_trog_items,
                                      trog_corpus_url, resolve_layout, classify, _tid,
                                      apply_cross_locale_guard)
        from vocab_vision_eval import ImageResolver
        tresolver = ImageResolver(args.image_source, local_dirs=args.trog_image_dir,
                                  bucket=args.gcs_bucket, prefix=args.trog_gcs_prefix,
                                  cache_dir="output/gcs_trog_cache")
        trog_corpus = args.trog_corpus_csv or trog_corpus_url(args.gcs_bucket)
        titems = {it["item_id"]: it for it in load_trog_items(trog_corpus)}
        print(f"[queue] trog images: {len(tresolver)} from {tresolver.label}")
        print(f"[queue] trog item bank: {trog_corpus}")
        layout_cache: Dict[str, object] = {}
        trog = []
        for c in cands:
            it = titems.get(_tid(c["item_id"]) or "")
            if not it:
                continue
            layout = resolve_layout(tresolver, it, layout_cache)
            if layout is None:
                continue
            c["is_trog"] = True
            c["_trog_item"] = it
            c["_trog_layout"] = layout
            trog.append(c)
        if trog:
            print(f"[queue] trog vision: sentence-vs-pictures on {len(trog)} items.")
            from tqdm import tqdm
            tev = TrogVisionEvaluator()
            trows = []
            for c in tqdm(trog, desc="trog-vision"):
                r = classify(tev, c["_trog_item"], c["_trog_layout"],
                             c["source_en"], c["translation"], c["locale"])
                c["_trog_r"] = r
                trows.append(r)
            apply_cross_locale_guard(trows)
            for c in trog:
                r = c["_trog_r"]
                c["vision_match"] = "no" if r["tag"] == "translation_issue" else (
                    "yes" if r["correct"] else "")
                c["_trog_gate_reason"] = r["gate_reason"]
                c["adequacy_flag"] = 1 if r["tag"] == "translation_issue" else 0

    # ToM (Stories) vision: question items are picture-backed; adequacy = "given the
    # translated story + question, does it still pick the keyed answer picture?" (AFC +
    # English control + cross-locale guard). Replaces COMET/E5 for the question segments.
    if not args.no_tom_vision:
        from tom_vision_eval import (load_tom_items, tom_corpus_url, classify as tom_classify,
                                     apply_reliability_gate)
        from trog_vision_eval import TrogVisionEvaluator, resolve_layout, apply_cross_locale_guard
        from tom_vision_eval import PROMPT_TOM, PROMPT_VERSION_TOM
        from vocab_vision_eval import ImageResolver
        moresolver = ImageResolver(args.image_source, local_dirs=args.tom_image_dir,
                                   bucket=args.gcs_bucket, prefix=args.tom_gcs_prefix,
                                   cache_dir="output/gcs_tom_cache")
        tom_corpus = args.tom_corpus_csv or tom_corpus_url(args.gcs_bucket)
        toitems = {it["item_id"]: it for it in load_tom_items(tom_corpus)}
        tom_tmap = {}
        for row in rows:
            ident = row.get("identifier", "") or row.get("item_id", "")
            if "stories.xliff" in (ident + row.get("_path", "")):
                tom_tmap[ident.split("::")[-1]] = row
        print(f"[queue] tom images: {len(moresolver)} from {moresolver.label}")
        print(f"[queue] tom item bank: {tom_corpus}")
        tlayout_cache: Dict[str, object] = {}
        tom = []
        for c in cands:
            it = toitems.get(c["item_id"].split("::")[-1])
            if not it:
                continue
            layout = resolve_layout(moresolver, it, tlayout_cache)
            if layout is None:
                continue
            c["is_tom"] = True
            c["_tom_item"] = it
            c["_tom_layout"] = layout
            tom.append(c)
        if tom:
            print(f"[queue] tom vision: story-vs-pictures on {len(tom)} questions.")
            from tqdm import tqdm
            moev = TrogVisionEvaluator(cache_dir="output/tom_vision_cache",
                                       prompt_template=PROMPT_TOM, prompt_version=PROMPT_VERSION_TOM)
            mrows = []
            for c in tom:
                r = tom_classify(moev, c["_tom_item"], c["_tom_layout"], tom_tmap, c["locale"])
                c["_tom_r"] = r
                if r is not None:
                    mrows.append(r)
            apply_reliability_gate(mrows)
            apply_cross_locale_guard(mrows)
            for c in tom:
                r = c["_tom_r"]
                if r is None:
                    c["is_tom"] = False
                    continue
                c["vision_match"] = "no" if r["tag"] == "translation_issue" else (
                    "yes" if r["correct"] else "")
                c["adequacy_flag"] = 1 if r["tag"] == "translation_issue" else 0

    # Same-Different vision: single-select trials are picture-backed minimal-pair cards, so
    # adequacy = "does the translated instruction still pick the keyed card?" (4-AFC +
    # English control + confirmation gate). The SDS corpus ids don't match Crowdin, so
    # items are matched to candidates by English instruction text. Replaces COMET/E5.
    if not args.no_samediff_vision:
        from samediff_vision_eval import (load_sd_items, sd_corpus_url, make_evaluator,
                                          resolve_layout as sd_resolve_layout)
        from trog_vision_eval import classify as trog_classify, apply_cross_locale_guard
        from vocab_vision_eval import ImageResolver, _norm_key
        sdresolver = ImageResolver(args.image_source, local_dirs=args.samediff_image_dir,
                                   bucket=args.gcs_bucket, prefix=args.samediff_gcs_prefix,
                                   cache_dir="output/gcs_samediff_cache")
        sd_corpus = args.samediff_corpus_csv or sd_corpus_url(args.gcs_bucket)
        sd_by_en = {_norm_key(it["en_item"]): it for it in load_sd_items(sd_corpus)}
        print(f"[queue] samediff images: {len(sdresolver)} from {sdresolver.label}")
        print(f"[queue] samediff item bank: {sd_corpus}")
        sdlayout_cache: Dict[str, object] = {}
        sd = []
        for c in cands:
            it = sd_by_en.get(_norm_key(c["source_en"]))
            if not it:
                continue
            layout = sd_resolve_layout(sdresolver, it, sdlayout_cache)
            if layout is None:
                continue
            c["is_samediff"] = True
            c["_sd_item"] = it
            c["_sd_layout"] = layout
            sd.append(c)
        if sd:
            print(f"[queue] samediff vision: instruction-vs-cards on {len(sd)} items.")
            from tqdm import tqdm
            sdev = make_evaluator()
            srows = []
            for c in tqdm(sd, desc="samediff-vision"):
                r = trog_classify(sdev, c["_sd_item"], c["_sd_layout"],
                                  c["_sd_item"]["en_item"], c["translation"], c["locale"])
                c["_sd_r"] = r
                srows.append(r)
            apply_cross_locale_guard(srows)
            for c in sd:
                r = c["_sd_r"]
                c["vision_match"] = "no" if r["tag"] == "translation_issue" else (
                    "yes" if r["correct"] else "")
                c["adequacy_flag"] = 1 if r["tag"] == "translation_issue" else 0

    # Survey answer-scale (Likert) check: COMET/E5 score each option in isolation and miss
    # broken option SETS, so this flags scales whose translations collapse (two options ->
    # one string), are half-translated, or are reordered/polarity-flipped (LLM judge +
    # confirmation gate). Group-level; matched to candidate options by English text + locale.
    if not args.no_survey_likert:
        from survey_likert_eval import extract_groups, check_group, SurveyLikertJudge
        from tqdm import tqdm
        groups = extract_groups(rows)
        judge = None if args.survey_likert_no_llm else SurveyLikertJudge()
        flagged_ids: Dict[tuple, str] = {}
        n_iss = 0
        for g in tqdm(groups, desc="survey-likert"):
            for loc in locales:
                for iss in check_group(g, loc, judge):
                    n_iss += 1
                    # Flag the exact option rows of THIS broken group instance (by identifier),
                    # so a scale shared across sibling questions flags only the broken one.
                    for ch in g["choices"]:
                        flagged_ids[(ch["ident"], loc)] = iss["issue"]
        for c in cands:
            if flagged_ids.get((c["item_id"], c["locale"])):
                c["is_survey"] = True
                c["adequacy_flag"] = 1
                c["vision_match"] = "no"
        print(f"[queue] survey-likert: {n_iss} scale issue(s); flagged "
              f"{sum(1 for c in cands if c.get('is_survey'))} option segment(s).")

    # Hostile-attribution: a social-reasoning task whose score depends on the answer SET —
    # intent anchors (on purpose vs by accident) and the keyed aggressive action must survive
    # translation. COMET/E5 can't see that; this flags the exact option rows of any scene
    # whose intent/valence structure broke (LLM judge + confirmation gate). Crowdin ids match
    # the item-bank ids, so flagging is by identifier.
    if not args.no_hostile_attribution:
        from hostile_attribution_eval import (load_scenes, ha_corpus_url, check_scene,
                                              HostileAttributionJudge)
        from tqdm import tqdm
        ha_tmap = {r["identifier"].split("::")[-1]: r for r in rows
                   if "hostile-attribution.xliff" in r.get("identifier", "")}
        if ha_tmap:
            ha_corpus = args.hostile_corpus_csv or ha_corpus_url(args.gcs_bucket)
            scenes = load_scenes(ha_corpus)
            hjudge = None if args.hostile_no_llm else HostileAttributionJudge()
            flagged_ha: Dict[tuple, str] = {}
            n_ha = 0
            for s in tqdm(scenes, desc="hostile-attr"):
                for loc in locales:
                    for iss in check_scene(s, ha_tmap, loc, hjudge):
                        n_ha += 1
                        for oid in iss["ids"].split(","):
                            flagged_ha[(oid, loc)] = iss["issue"]
            for c in cands:
                # item-bank ids are bare (hostile-attribution-scene1-q2-ans3); candidate
                # item_id is the full xliff identifier, so match on its suffix.
                if flagged_ha.get((c["item_id"].split("::")[-1], c["locale"])):
                    c["is_hostile"] = True
                    c["adequacy_flag"] = 1
                    c["vision_match"] = "no"
            print(f"[queue] hostile-attribution: {n_ha} issue(s); flagged "
                  f"{sum(1 for c in cands if c.get('is_hostile'))} option segment(s).")

    # Tier 2: MQM on the flagged tail (+ optional random sample), capped.
    if not args.tier1_only and t_mqm is not None:
        rng = random.Random(args.seed)
        flagged = [c for c in cands if c["adequacy_flag"] == 1]
        flagged.sort(key=lambda c: min(c["e5_direct"], c["comet"]))  # worst adequacy first
        to_mqm = flagged[:args.max_mqm]
        if args.mqm_sample:
            pool = [c for c in cands if c["adequacy_flag"] == 0]
            to_mqm += rng.sample(pool, min(args.mqm_sample, len(pool)))
        print(f"[queue] Tier 2: MQM on {len(to_mqm)} rows (cap {args.max_mqm}).")
        from llm_mqm_eval import LlmMqmEvaluator
        from tqdm import tqdm
        ev = LlmMqmEvaluator()
        for c in tqdm(to_mqm, desc="MQM"):
            res = ev.evaluate_single(c["source_en"], c["translation"], c["locale"])
            if not res["ok"]:
                continue
            major = sum(1 for e in res["errors"] if e["severity"] in ("major", "critical"))
            c["mqm_score"] = round(float(res["score"]), 2)
            c["mqm_major"] = major
            c["appropriateness_flag"] = 1 if (res["score"] < t_mqm or major >= 1) else 0

    # Tier + priority + reasons.
    for c in cands:
        adq = c["adequacy_flag"] == 1
        app = c["appropriateness_flag"] == 1
        c["tier"] = "likely_bad" if (adq and app) else ("review" if (adq or app) else "ok")
        reasons = []
        if c.get("is_vocab"):
            if c["vision_match"] == "no":
                reasons.append("vision_word_image_mismatch")
        elif c.get("is_trog"):
            if c["vision_match"] == "no":
                reasons.append("vision_sentence_picture_mismatch")
        elif c.get("is_tom"):
            if c["vision_match"] == "no":
                reasons.append("vision_story_picture_mismatch")
        elif c.get("is_samediff"):
            if c["vision_match"] == "no":
                reasons.append("vision_instruction_card_mismatch")
        else:
            if c["e5_direct"] < t_e5:
                reasons.append("low_e5")
            if c["comet"] < t_comet:
                reasons.append("low_comet")
        if c.get("is_survey"):
            reasons.append("survey_scale_issue")
        if c.get("is_hostile"):
            reasons.append("hostile_attribution_issue")
        if app:
            reasons.append("mqm_appropriateness")
        c["reasons"] = ";".join(reasons)
        # worse adequacy = higher priority; appropriateness adds weight.
        adq_sev = 2 - (min(c["e5_direct"], c["comet"]))  # ~ higher when scores low
        c["priority"] = round(adq_sev + (1.0 if app else 0.0) + (0.5 if adq else 0.0), 4)

    rank = {"likely_bad": 0, "review": 1, "ok": 2}
    cands.sort(key=lambda c: (rank[c["tier"]], -c["priority"]))

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=OUT_COLS, extrasaction="ignore")
        w.writeheader()
        w.writerows(cands)

    tiers = {"likely_bad": 0, "review": 0, "ok": 0}
    for c in cands:
        tiers[c["tier"]] += 1
    print(f"[done] {len(cands)} rows -> {out}")
    print(f"       likely_bad={tiers['likely_bad']}, review={tiers['review']}, ok={tiers['ok']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
