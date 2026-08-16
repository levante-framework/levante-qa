#!/usr/bin/env python3
"""Regenerate roar-pa isolated word stems with human-like padding.

Writes ONLY under tools/vlm-panel/out/pa_elevenlabs_words_tight/.
Does not modify roar-pa, Crowdin, GCS, or pa_elevenlabs_en_us/.

Voices match levante_translations/utilities/config.py defaults:
  en  Lily Wolff      qBDvhofpxp92JgXJxDjB
  es  Malena Tango    1WXz8v08ntDcSTeVXMN2
  de  Julia           (resolved from ElevenLabs library)
  pt  Carla           7eUAxNOneHxqfyRS77mW

After TTS, ffmpeg trims to ~50 ms lead / 140 ms trail (EN human word medians).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import ssl
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
QA_ROOT = HERE.parent.parent
ROAR_PA = QA_ROOT.parent / "roar-pa"
LT_ROOT = QA_ROOT.parent / "levante_translations"
PREV_EN = HERE / "out" / "pa_elevenlabs_en_us" / "clips"
OUT = HERE / "out" / "pa_elevenlabs_words_tight"

MODEL_ID = "eleven_v3"
OUTPUT_FORMAT = "mp3_44100_128"
LEAD_S = 0.05
TRAIL_S = 0.14
SILENCE_DB = -35

LANGS = {
    "en": {
        "label": "en-US",
        "voice": "Lily Wolff",
        "voice_id": "qBDvhofpxp92JgXJxDjB",
        "el_lang": "en",
    },
    "es": {
        "label": "es",
        "voice": "Malena Tango",
        "voice_id": "1WXz8v08ntDcSTeVXMN2",
        "el_lang": "es",
    },
    "de": {
        "label": "de",
        "voice": "Julia",
        "voice_id": "",
        "el_lang": "de",
    },
    "pt": {
        "label": "pt",
        "voice": "Carla",
        "voice_id": "7eUAxNOneHxqfyRS77mW",
        "el_lang": "pt",
    },
}

CTX = ssl.create_default_context()


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key, val = key.strip(), val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


def env_key(*names: str) -> str:
    for n in names:
        v = (os.environ.get(n) or "").strip()
        if v:
            return v
    raise RuntimeError(f"Missing API key ({' / '.join(names)})")


def mp3_duration_sec(data: bytes) -> float | None:
    try:
        offset = 0
        if data[:3] == b"ID3":
            size = (
                (data[6] & 0x7F) << 21
                | (data[7] & 0x7F) << 14
                | (data[8] & 0x7F) << 7
                | (data[9] & 0x7F)
            )
            offset = 10 + size
        window = data[offset : offset + 220]
        idx = window.find(b"Xing")
        if idx < 0:
            idx = window.find(b"Info")
        if idx >= 0:
            base = offset + idx
            flags = int.from_bytes(data[base + 4 : base + 8], "big")
            if flags & 1:
                frames = int.from_bytes(data[base + 8 : base + 12], "big")
                hdr = int.from_bytes(data[offset : offset + 4], "big")
                sr = [44100, 48000, 32000, 0][(hdr >> 10) & 3]
                if sr:
                    return frames * 1152 / sr
        hdr = int.from_bytes(data[offset : offset + 4], "big")
        br_table = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
        br = br_table[(hdr >> 12) & 0xF] * 1000
        if br:
            return ((len(data) - offset) * 8) / br
    except Exception:
        return None
    return None


def http_json(url: str, *, headers: dict, data: bytes | None = None, method: str = "GET") -> bytes:
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, context=CTX, timeout=120) as resp:
        return resp.read()


def word_text(name: str) -> str:
    stem = Path(name).stem
    stem = re.sub(r"[()]", "", stem)
    return stem.replace("_", " ").replace("-", " ").strip()


def collect_words(lang: str) -> list[dict]:
    corpus = ROAR_PA / "src" / "experiment" / "config" / "corpus" / lang
    items: dict[str, dict] = {}
    for fname in ("practice.csv", "test.csv", "practice-cat.csv", "test-cat.csv"):
        path = corpus / fname
        if not path.is_file():
            continue
        with path.open(encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
        for row in rows:
            for col in ("stimAudioUrl", "goalAudioUrl", "foilAudioUrl", "foil2AudioUrl"):
                url = (row.get(col) or "").strip()
                if not url.lower().endswith(".mp3"):
                    continue
                name = Path(url.split("?")[0]).name
                low = name.lower()
                if low.startswith(("ns_", "reward", "click", "select")):
                    continue
                rec = items.setdefault(
                    name,
                    {"id": name, "lang": lang, "url": url, "text": word_text(name)},
                )
                if url and not rec.get("url"):
                    rec["url"] = url
    return sorted(items.values(), key=lambda r: r["id"].lower())


def resolve_voice_id(api_key: str, name: str, fallback: str) -> str:
    if fallback:
        return fallback
    raw = http_json(
        "https://api.elevenlabs.io/v1/voices",
        headers={"xi-api-key": api_key},
    )
    voices = json.loads(raw).get("voices") or []
    exact = [v for v in voices if (v.get("name") or "") == name]
    if exact:
        return exact[0]["voice_id"]
    loose = [v for v in voices if name.lower() in (v.get("name") or "").lower()]
    if loose:
        return loose[0]["voice_id"]
    raise RuntimeError(f"No ElevenLabs voice named {name!r}")


def synthesize(text: str, voice_id: str, api_key: str, language_code: str) -> bytes:
    payload = json.dumps(
        {
            "text": text,
            "model_id": MODEL_ID,
            "language_code": language_code,
        }
    ).encode()
    url = (
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
        f"?output_format={OUTPUT_FORMAT}"
    )
    try:
        return http_json(
            url,
            headers={
                "xi-api-key": api_key,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
            data=payload,
            method="POST",
        )
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")[:400]
        # v3 sometimes rejects language_code; retry without it
        if "language" in err.lower() or e.code in (400, 422):
            payload2 = json.dumps({"text": text, "model_id": MODEL_ID}).encode()
            return http_json(
                url,
                headers={
                    "xi-api-key": api_key,
                    "Content-Type": "application/json",
                    "Accept": "audio/mpeg",
                },
                data=payload2,
                method="POST",
            )
        raise RuntimeError(f"ElevenLabs {e.code}: {err}") from e


def download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file() and dest.stat().st_size > 200:
        return dest
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, context=CTX, timeout=60) as resp:
        dest.write_bytes(resp.read())
    return dest


def _ffmpeg_trim(src: Path, dest: Path, threshold_db: int) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    af = (
        f"silenceremove=stop_periods=1:stop_silence={TRAIL_S}:"
        f"stop_threshold={threshold_db}dB"
    )
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-af",
            af,
            "-ar",
            "44100",
            "-b:a",
            "128k",
            str(dest),
        ],
        check=True,
    )


def trim_mp3(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    # End-only: TTS already has ~50 ms lead; start-trim ate /f/ /s/ /h/ onsets.
    _ffmpeg_trim(src, dest, SILENCE_DB)
    dur = mp3_duration_sec(dest.read_bytes()) if dest.is_file() else None
    if dur is None or dur < 0.30:
        _ffmpeg_trim(src, dest, -50)
        dur = mp3_duration_sec(dest.read_bytes()) if dest.is_file() else None
    if dur is None or dur < 0.30 or dest.stat().st_size < 200:
        dest.write_bytes(src.read_bytes())


def stats(xs: list[float]) -> dict:
    if not xs:
        return {"n": 0, "sum": 0.0, "median": 0.0, "mean": 0.0}
    s = sorted(xs)
    return {
        "n": len(s),
        "sum": round(sum(s), 3),
        "median": round(s[len(s) // 2], 3),
        "mean": round(sum(s) / len(s), 3),
    }


def write_report(rows: list[dict]) -> None:
    lines = [
        "# roar-pa isolated words: current vs tight ElevenLabs",
        "",
        "Experiment only. New clips live in `tools/vlm-panel/out/pa_elevenlabs_words_tight/`.",
        "Existing roar-pa / GCS / prior experiment files were not modified.",
        "",
        f"- Model: `{MODEL_ID}` · format `{OUTPUT_FORMAT}`",
        f"- Tight pad: keep TTS lead; trim tail to {int(TRAIL_S*1000)} ms "
        f"(`ffmpeg silenceremove` end-only @ {SILENCE_DB} dB; matches EN human trail)",
        "",
        "## Per language (unique word stems)",
        "",
        "| Lang | Voice | n | Current median | Raw TTS median | Tight TTS median | Current sum | Tight sum |",
        "|------|-------|--:|---------------:|---------------:|-----------------:|------------:|----------:|",
    ]
    by_lang: dict[str, list] = {}
    for r in rows:
        by_lang.setdefault(r["lang"], []).append(r)
    summary = {}
    for lang in ("en", "es", "de", "pt"):
        rs = by_lang.get(lang, [])
        cur = stats([r["current_sec"] for r in rs if r.get("current_sec")])
        raw = stats([r["raw_sec"] for r in rs if r.get("raw_sec")])
        tight = stats([r["tight_sec"] for r in rs if r.get("tight_sec")])
        voice = LANGS[lang]["voice"]
        lines.append(
            f"| {lang} | {voice} | {len(rs)} | {cur['median']:.2f} s | {raw['median']:.2f} s | "
            f"{tight['median']:.2f} s | {cur['sum']/60:.2f} min | {tight['sum']/60:.2f} min |"
        )
        summary[lang] = {"current": cur, "raw": raw, "tight": tight, "voice": voice}
    lines += [
        "",
        "EN current = human VO. ES / DE / PT current = files already on GCS (not overwritten).",
        "Raw TTS is the untrimmed ElevenLabs file; tight is the same take with human-like pad.",
        "",
        "Artifacts: `manifest.json`, `comparison.json`, `current_cache/`, `raw/`, `tight/`.",
    ]
    (OUT / "comparison.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (OUT / "comparison.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--retrim-only", action="store_true")
    parser.add_argument("--langs", default="en,es,de,pt")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    load_dotenv(QA_ROOT / ".env")
    load_dotenv(LT_ROOT / ".env")

    langs = [x.strip() for x in args.langs.split(",") if x.strip()]
    for lang in langs:
        if lang not in LANGS:
            raise SystemExit(f"unknown lang {lang}")

    OUT.mkdir(parents=True, exist_ok=True)
    items: list[dict] = []
    for lang in langs:
        chunk = collect_words(lang)
        if args.limit:
            chunk = chunk[: args.limit]
        items.extend(chunk)
        print(f"lang={lang} words={len(chunk)} voice={LANGS[lang]['voice']}")

    if args.dry_run:
        (OUT / "manifest_dry_run.json").write_text(
            json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        return 0

    if args.retrim_only:
        n = 0
        for rec in items:
            raw = OUT / "raw" / rec["lang"] / rec["id"]
            tight = OUT / "tight" / rec["lang"] / rec["id"]
            if not raw.is_file():
                print(f"missing raw {rec['lang']}/{rec['id']}")
                continue
            trim_mp3(raw, tight)
            n += 1
            if n % 50 == 0:
                print(f"retrim {n}/{len(items)}")
        # refresh durations from existing cache + new tight
        refreshed = []
        prev_path = OUT / "manifest.json"
        prev = { (r["lang"], r["id"]): r for r in json.loads(prev_path.read_text()) } if prev_path.is_file() else {}
        for rec in items:
            old = prev.get((rec["lang"], rec["id"]), {})
            rec.update({k: old[k] for k in old if k not in rec})
            tight = OUT / "tight" / rec["lang"] / rec["id"]
            raw = OUT / "raw" / rec["lang"] / rec["id"]
            cur = OUT / "current_cache" / rec["lang"] / rec["id"]
            if tight.is_file():
                rec["tight_sec"] = mp3_duration_sec(tight.read_bytes())
                rec["tight_path"] = str(tight)
            if raw.is_file():
                rec["raw_sec"] = mp3_duration_sec(raw.read_bytes())
            if cur.is_file():
                rec["current_sec"] = mp3_duration_sec(cur.read_bytes())
            refreshed.append(rec)
        (OUT / "manifest.json").write_text(
            json.dumps(refreshed, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        write_report(refreshed)
        print(f"retrimmed {n} wrote {OUT / 'comparison.md'}")
        return 0

    elabs = env_key("ELEVEN_LABS_API_KEY", "ELEVENLABS_API_KEY", "ELEVEN_API_KEY")
    for lang in langs:
        LANGS[lang]["voice_id"] = resolve_voice_id(
            elabs, LANGS[lang]["voice"], LANGS[lang]["voice_id"]
        )
        print(f"resolved {lang} {LANGS[lang]['voice']} {LANGS[lang]['voice_id']}")

    for i, rec in enumerate(items, 1):
        lang = rec["lang"]
        name = rec["id"]
        cfg = LANGS[lang]
        rec["voice"] = cfg["voice"]
        rec["voice_id"] = cfg["voice_id"]
        rec["text_source"] = "filename"

        current = download(rec["url"], OUT / "current_cache" / lang / name)
        rec["current_path"] = str(current)
        rec["current_sec"] = mp3_duration_sec(current.read_bytes())

        raw = OUT / "raw" / lang / name
        tight = OUT / "tight" / lang / name
        prev = PREV_EN / name
        if raw.is_file() and raw.stat().st_size > 200:
            rec["raw_sec"] = mp3_duration_sec(raw.read_bytes())
        elif lang == "en" and prev.is_file() and prev.stat().st_size > 200:
            raw.parent.mkdir(parents=True, exist_ok=True)
            raw.write_bytes(prev.read_bytes())
            rec["raw_sec"] = mp3_duration_sec(raw.read_bytes())
            rec["raw_source"] = "copied_from_pa_elevenlabs_en_us"
            print(f"[{i}/{len(items)}] copy-en-raw {lang}/{name}")
        else:
            print(f"[{i}/{len(items)}] tts {lang}/{name}: {rec['text']!r}")
            audio = synthesize(rec["text"], cfg["voice_id"], elabs, cfg["el_lang"])
            raw.parent.mkdir(parents=True, exist_ok=True)
            raw.write_bytes(audio)
            rec["raw_sec"] = mp3_duration_sec(audio)
            rec["raw_source"] = "elevenlabs"
            time.sleep(0.15)

        if tight.is_file() and tight.stat().st_size > 200:
            rec["tight_sec"] = mp3_duration_sec(tight.read_bytes())
        else:
            trim_mp3(raw, tight)
            rec["tight_sec"] = mp3_duration_sec(tight.read_bytes())
        rec["raw_path"] = str(raw)
        rec["tight_path"] = str(tight)
        if i % 25 == 0 or i == len(items):
            print(
                f"[{i}/{len(items)}] {lang}/{name} current={rec.get('current_sec')} "
                f"raw={rec.get('raw_sec')} tight={rec.get('tight_sec')}"
            )

    (OUT / "manifest.json").write_text(
        json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    write_report(items)
    print(f"wrote {OUT / 'comparison.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
