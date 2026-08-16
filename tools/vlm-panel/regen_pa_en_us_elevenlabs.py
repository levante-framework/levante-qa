#!/usr/bin/env python3
"""Regenerate roar-pa en-US speech with the current Levante ElevenLabs voice.

Writes ONLY under tools/vlm-panel/out/pa_elevenlabs_en_us/.
Does not modify roar-pa assets, locales, Crowdin, or GCS.

Modeled on levante_translations/generate_itembank_audio.py:
  voice     Lily Wolff
  voice_id  qBDvhofpxp92JgXJxDjB
  model     eleven_v3
  format    mp3_44100_128

Usage:
  python3 tools/vlm-panel/regen_pa_en_us_elevenlabs.py --dry-run
  python3 tools/vlm-panel/regen_pa_en_us_elevenlabs.py
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
QA_ROOT = HERE.parent.parent
ROAR_PA = QA_ROOT.parent / "roar-pa"
LT_ROOT = QA_ROOT.parent / "levante_translations"
OUT = HERE / "out" / "pa_elevenlabs_en_us"
CLIPS = OUT / "clips"
HUMAN_CACHE = OUT / "human_cache"

VOICE = "Lily Wolff"
VOICE_ID = "qBDvhofpxp92JgXJxDjB"
MODEL_ID = "eleven_v3"
OUTPUT_FORMAT = "mp3_44100_128"
LANG = "en-US"

INTRO_NAMES = {
    "introduction_ns.mp3",
    "FS_practice_ns.mp3",
    "LS_practice_ns.mp3",
    "DEL_practice_ns.mp3",
}
SKIP_PREFIXES = ("reward", "click", "select")

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


def parse_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


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


def local_audio_index() -> dict[str, Path]:
    root = ROAR_PA / "src" / "assets" / "audios"
    out: dict[str, Path] = {}
    if not root.is_dir():
        return out
    for p in root.rglob("*.mp3"):
        name = p.name
        if "roar-pa-alana" in str(p) and name in out:
            continue
        out.setdefault(name, p)
    return out


def collect_items(index: dict[str, Path]) -> list[dict]:
    corpus_dir = ROAR_PA / "src" / "experiment" / "config" / "corpus" / "en"
    items: dict[str, dict] = {}

    def add(name: str, *, role: str, sub: str | None = None, stage: str | None = None, url: str | None = None):
        if not name.endswith(".mp3"):
            name = f"{name}.mp3" if name else name
        if not name or name.startswith(SKIP_PREFIXES):
            return
        rec = items.setdefault(
            name,
            {
                "id": name,
                "role": role,
                "subs": set(),
                "stages": set(),
                "url": url,
                "human_path": str(index[name]) if name in index else None,
            },
        )
        if sub:
            rec["subs"].add(sub)
        if stage:
            rec["stages"].add(stage)
        if url and not rec.get("url"):
            rec["url"] = url
        if role == "intro":
            rec["role"] = "intro"

    for fname in ("practice.csv", "test.csv", "practice-cat.csv", "test-cat.csv"):
        path = corpus_dir / fname
        if not path.is_file():
            continue
        stage = "practice" if "practice" in fname else "test"
        for row in parse_csv(path):
            sub = (row.get("trial_type") or "").upper()
            for col in ("questUrl", "instrUrl", "stimAudioUrl", "goalAudioUrl", "foilAudioUrl", "foil2AudioUrl"):
                url = (row.get(col) or "").strip()
                if not url.lower().endswith(".mp3"):
                    continue
                name = Path(url.split("?")[0]).name
                if name.lower().startswith("ns_"):
                    role = "ns"
                else:
                    role = "word"
                if col == "instrUrl":
                    role = "ns"
                add(name, role=role, sub=sub, stage=stage, url=url)
            for col in ("quest", "instr"):
                raw = (row.get(col) or "").strip()
                if raw.lower().startswith("ns_"):
                    name = raw if raw.endswith(".mp3") else f"{raw}.mp3"
                    add(name, role="ns", sub=sub, stage=stage)

    for name in INTRO_NAMES:
        add(name, role="intro", stage="intro")

    for name, path in index.items():
        low = name.lower()
        if any(low.startswith(s) for s in SKIP_PREFIXES):
            continue
        if "reward" in str(path):
            continue
        if name in items:
            continue
        if low.startswith("ns_"):
            add(name, role="ns")
        elif name in INTRO_NAMES or re.search(r"(ready|end|break|practice|introduction)_ns", low):
            add(name, role="intro" if name in INTRO_NAMES else "character")
        elif re.match(r"ch-", low):
            add(name, role="character")

    out = []
    for rec in items.values():
        rec["subs"] = sorted(rec["subs"])
        rec["stages"] = sorted(rec["stages"])
        out.append(rec)
    out.sort(key=lambda r: (r["role"], r["id"]))
    return out


def word_text(name: str) -> str:
    stem = Path(name).stem
    stem = re.sub(r"[()]", "", stem)
    stem = stem.replace("_", " ").replace("-", " ").strip()
    return stem


def transcribe(path: Path, api_key: str) -> str:
    """ElevenLabs Scribe — same account as TTS. Does not write back to roar-pa."""
    boundary = "----paElevenLabsBoundary"
    data = path.read_bytes()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="model_id"\r\n\r\n'
        f"scribe_v1\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="language_code"\r\n\r\n'
        f"en\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        f"Content-Type: audio/mpeg\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    raw = http_json(
        "https://api.elevenlabs.io/v1/speech-to-text",
        headers={
            "xi-api-key": api_key,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        data=body,
        method="POST",
    )
    parsed = json.loads(raw)
    return (parsed.get("text") or parsed.get("transcript") or "").strip()


def synthesize(text: str, api_key: str) -> bytes:
    payload = json.dumps({"text": text, "model_id": MODEL_ID}).encode()
    url = (
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
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
        raise RuntimeError(f"ElevenLabs {e.code}: {err}") from e


def ensure_human(rec: dict) -> Path | None:
    if rec.get("human_path") and Path(rec["human_path"]).is_file():
        return Path(rec["human_path"])
    url = rec.get("url")
    if not url:
        return None
    dest = HUMAN_CACHE / rec["id"]
    if dest.is_file() and dest.stat().st_size > 200:
        rec["human_path"] = str(dest)
        return dest
    HUMAN_CACHE.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, context=CTX, timeout=60) as resp:
        dest.write_bytes(resp.read())
    rec["human_path"] = str(dest)
    return dest


def typical_required(rows: list[dict]) -> dict:
    """Same recipe as the EN 4.8 min figure: intros + practice×7.6/6 + 42 test ns."""
    by_id = {r["id"]: r for r in rows}

    def dur(name: str) -> float:
        r = by_id.get(name) or {}
        return float(r.get("human_sec") or 0), float(r.get("tts_sec") or 0)

    intro_h = intro_t = 0.0
    for name in sorted(INTRO_NAMES):
        h, t = dur(name)
        intro_h += h
        intro_t += t

    prac = [r for r in rows if "practice" in r.get("stages", []) and r["role"] == "ns"]
    # unique practice ns (instr+quest); scale retries 7.6/6
    prac_h = sum(float(r.get("human_sec") or 0) for r in prac)
    prac_t = sum(float(r.get("tts_sec") or 0) for r in prac)
    scale = 7.6 / 6.0
    prac_h *= scale
    prac_t *= scale

    test_ns = [
        r
        for r in rows
        if r["role"] == "ns" and "test" in r.get("stages", []) and r["id"].lower().startswith("ns_")
    ]
    test_h = [float(r.get("human_sec") or 0) for r in test_ns if r.get("human_sec")]
    test_t = [float(r.get("tts_sec") or 0) for r in test_ns if r.get("tts_sec")]
    test_h.sort()
    test_t.sort()
    med = lambda xs: xs[len(xs) // 2] if xs else 0.0
    return {
        "intro_human_min": round(intro_h / 60, 2),
        "intro_tts_min": round(intro_t / 60, 2),
        "practice_human_min": round(prac_h / 60, 2),
        "practice_tts_min": round(prac_t / 60, 2),
        "test42_human_min": round(med(test_h) * 42 / 60, 2),
        "test42_tts_min": round(med(test_t) * 42 / 60, 2),
        "typical_human_min": round((intro_h + prac_h + med(test_h) * 42) / 60, 2),
        "typical_tts_min": round((intro_t + prac_t + med(test_t) * 42) / 60, 2),
        "n_practice_ns": len(prac),
        "n_test_ns": len(test_ns),
        "test_ns_median_human_sec": round(med(test_h), 2),
        "test_ns_median_tts_sec": round(med(test_t), 2),
    }


def write_report(rows: list[dict], typical: dict) -> None:
    ok = [r for r in rows if r.get("human_sec") and r.get("tts_sec")]
    sum_h = sum(r["human_sec"] for r in ok)
    sum_t = sum(r["tts_sec"] for r in ok)
    by_role: dict[str, list] = {}
    for r in ok:
        by_role.setdefault(r["role"], []).append(r)

    lines = [
        "# roar-pa en-US: human VO vs ElevenLabs Lily Wolff",
        "",
        "Experiment only. New clips live in `tools/vlm-panel/out/pa_elevenlabs_en_us/clips/`.",
        "Existing roar-pa assets, locales, and GCS files were not modified.",
        "",
        f"- Voice: **{VOICE}** (`{VOICE_ID}`)",
        f"- Model: `{MODEL_ID}` · format `{OUTPUT_FORMAT}` · lang `{LANG}`",
        f"- Clips compared: **{len(ok)}** / {len(rows)}",
        "",
        "## Typical required-audio recipe (EN 4.8 min definition)",
        "",
        "Intros that play + practice instr/quest × 7.6/6 retries + 42 test question stems.",
        "",
        f"| Piece | Human | ElevenLabs |",
        f"|-------|------:|-----------:|",
        f"| Intros | {typical['intro_human_min']:.2f} min | {typical['intro_tts_min']:.2f} min |",
        f"| Practice | {typical['practice_human_min']:.2f} min | {typical['practice_tts_min']:.2f} min |",
        f"| 42 test stems | {typical['test42_human_min']:.2f} min | {typical['test42_tts_min']:.2f} min |",
        f"| **Typical required** | **{typical['typical_human_min']:.2f} min** | **{typical['typical_tts_min']:.2f} min** |",
        "",
        f"Delta: **{typical['typical_tts_min'] - typical['typical_human_min']:+.2f} min** "
        f"({(typical['typical_tts_min'] / typical['typical_human_min'] - 1) * 100 if typical['typical_human_min'] else 0:+.0f}% vs human).",
        "",
        "## Full spoken bank (unique clips generated)",
        "",
        f"| Role | n | Human sum | ElevenLabs sum |",
        f"|------|--:|----------:|---------------:|",
    ]
    for role, rs in sorted(by_role.items()):
        lines.append(
            f"| {role} | {len(rs)} | {sum(r['human_sec'] for r in rs)/60:.2f} min | {sum(r['tts_sec'] for r in rs)/60:.2f} min |"
        )
    lines += [
        f"| **all** | {len(ok)} | **{sum_h/60:.2f} min** | **{sum_t/60:.2f} min** |",
        "",
        f"Bank delta: **{(sum_t - sum_h)/60:+.2f} min** ({(sum_t / sum_h - 1) * 100 if sum_h else 0:+.0f}%).",
        "",
        "Word stems use the corpus filename as text. `ns_*` / intro / character clips were transcribed from the human mp3 (ElevenLabs Scribe) then re-spoken — source strings were not edited.",
        "",
        "Artifacts: `manifest.json`, `transcripts.json`, `comparison.json`, `clips/`.",
    ]
    (OUT / "comparison.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (OUT / "comparison.json").write_text(
        json.dumps({"typical": typical, "n_compared": len(ok), "sum_human_sec": sum_h, "sum_tts_sec": sum_t}, indent=2),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    load_dotenv(QA_ROOT / ".env")
    load_dotenv(LT_ROOT / ".env")

    OUT.mkdir(parents=True, exist_ok=True)
    CLIPS.mkdir(parents=True, exist_ok=True)

    index = local_audio_index()
    items = collect_items(index)
    if args.limit:
        items = items[: args.limit]

    print(f"clips={len(items)} out={OUT} voice={VOICE} model={MODEL_ID}")
    if args.dry_run:
        (OUT / "manifest_dry_run.json").write_text(
            json.dumps([{k: v for k, v in r.items()} for r in items], indent=2),
            encoding="utf-8",
        )
        by = {}
        for r in items:
            by[r["role"]] = by.get(r["role"], 0) + 1
        print("roles", by)
        return 0

    elabs = env_key("ELEVEN_LABS_API_KEY", "ELEVENLABS_API_KEY", "ELEVEN_API_KEY")

    transcripts_path = OUT / "transcripts.json"
    transcripts = json.loads(transcripts_path.read_text()) if transcripts_path.is_file() else {}

    for i, rec in enumerate(items, 1):
        name = rec["id"]
        dest = CLIPS / name
        human = ensure_human(rec)
        if human and human.is_file():
            rec["human_sec"] = mp3_duration_sec(human.read_bytes())

        if rec["role"] == "word":
            rec["text"] = word_text(name)
            rec["text_source"] = "filename"
        else:
            if name in transcripts and transcripts[name].get("text"):
                rec["text"] = transcripts[name]["text"]
                rec["text_source"] = transcripts[name].get("source", "whisper")
            elif human:
                print(f"[{i}/{len(items)}] whisper {name}")
                rec["text"] = transcribe(human, elabs)
                rec["text_source"] = "scribe"
                transcripts[name] = {"text": rec["text"], "source": "whisper"}
                transcripts_path.write_text(json.dumps(transcripts, indent=2, ensure_ascii=False), encoding="utf-8")
                time.sleep(0.15)
            else:
                rec["text"] = ""
                rec["text_source"] = "missing"

        if dest.is_file() and dest.stat().st_size > 200:
            rec["tts_sec"] = mp3_duration_sec(dest.read_bytes())
            rec["tts_path"] = str(dest)
            print(f"[{i}/{len(items)}] skip-existing {name} tts={rec['tts_sec']}")
            continue

        text = (rec.get("text") or "").strip()
        if not text:
            print(f"[{i}/{len(items)}] NO TEXT {name}")
            continue
        print(f"[{i}/{len(items)}] tts {name} ({rec['text_source']}): {text[:80]!r}")
        audio = synthesize(text, elabs)
        dest.write_bytes(audio)
        rec["tts_sec"] = mp3_duration_sec(audio)
        rec["tts_path"] = str(dest)
        time.sleep(0.2)

    serializable = []
    for r in items:
        serializable.append({k: v for k, v in r.items()})
    (OUT / "manifest.json").write_text(json.dumps(serializable, indent=2, ensure_ascii=False), encoding="utf-8")
    typical = typical_required(items)
    write_report(items, typical)
    print(json.dumps(typical, indent=2))
    print(f"wrote {OUT / 'comparison.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
