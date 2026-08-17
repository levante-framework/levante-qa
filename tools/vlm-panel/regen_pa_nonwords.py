#!/usr/bin/env python3
"""TTS for roar-pa non-word clips (intros + ns stems). Experiment folder only."""
from __future__ import annotations

import argparse
import csv
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
QA_ROOT = HERE.parent.parent
ROAR_PA = QA_ROOT.parent / "roar-pa"
LT_ROOT = QA_ROOT.parent / "levante_translations"
EN_CLIPS = HERE / "out" / "pa_elevenlabs_en_us" / "clips"
OUT = HERE / "out" / "pa_elevenlabs_nonwords"

MODEL_ID = "eleven_v3"
OUTPUT_FORMAT = "mp3_44100_128"
INTROS = (
    "introduction_ns.mp3",
    "FS_practice_ns.mp3",
    "LS_practice_ns.mp3",
    "DEL_practice_ns.mp3",
)
LANGS = {
    "en": {"voice": "Lily Wolff", "voice_id": "qBDvhofpxp92JgXJxDjB", "el_lang": "en"},
    "es": {"voice": "Malena Tango", "voice_id": "1WXz8v08ntDcSTeVXMN2", "el_lang": "es"},
    "de": {"voice": "Julia", "voice_id": "qAVuy3NdMTW0CZ8uA7M9", "el_lang": "de"},
    "pt": {"voice": "Carla", "voice_id": "7eUAxNOneHxqfyRS77mW", "el_lang": "pt"},
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


def http_json(url: str, *, headers: dict, data: bytes | None = None, method: str = "GET") -> bytes:
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, context=CTX, timeout=120) as resp:
        return resp.read()


def collect(lang: str) -> list[dict]:
    corpus = ROAR_PA / "src" / "experiment" / "config" / "corpus" / lang
    items: dict[str, dict] = {}

    def add(name: str, url: str | None, role: str, stage: str) -> None:
        if not name.endswith(".mp3"):
            name = f"{name}.mp3"
        rec = items.setdefault(
            name, {"id": name, "lang": lang, "url": url, "role": role, "stages": set()}
        )
        rec["stages"].add(stage)
        if url and not rec.get("url"):
            rec["url"] = url
        if role == "intro":
            rec["role"] = "intro"

    base = None
    for fname in ("practice.csv", "test.csv"):
        path = corpus / fname
        if not path.is_file():
            continue
        stage = "practice" if "practice" in fname else "test"
        with path.open(encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
        for row in rows:
            for col in ("questUrl", "instrUrl"):
                url = (row.get(col) or "").strip()
                if url.lower().endswith(".mp3"):
                    name = Path(url.split("?")[0]).name
                    if name.lower().startswith("ns_"):
                        add(name, url, "ns", stage)
                        if base is None and "storage.googleapis.com" in url:
                            base = "/".join(url.split("/")[:-1]) + "/"
    for name in INTROS:
        add(name, f"{base}{name}" if base else None, "intro", "intro")
    out = []
    for rec in items.values():
        rec["stages"] = sorted(rec["stages"])
        out.append(rec)
    out.sort(key=lambda r: (r["role"], r["id"]))
    return out


def transcribe(path: Path, api_key: str, lang: str) -> str:
    boundary = "----paNonwordBoundary"
    data = path.read_bytes()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="model_id"\r\n\r\n'
        f"scribe_v1\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="language_code"\r\n\r\n'
        f"{lang}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        f"Content-Type: audio/mpeg\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    raw = http_json(
        "https://api.elevenlabs.io/v1/speech-to-text",
        headers={"xi-api-key": api_key, "Content-Type": f"multipart/form-data; boundary={boundary}"},
        data=body,
        method="POST",
    )
    parsed = json.loads(raw)
    return (parsed.get("text") or parsed.get("transcript") or "").strip()


def synthesize(text: str, voice_id: str, api_key: str, language_code: str) -> bytes:
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format={OUTPUT_FORMAT}"
    payload = json.dumps({"text": text, "model_id": MODEL_ID, "language_code": language_code}).encode()
    try:
        return http_json(
            url,
            headers={"xi-api-key": api_key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
            data=payload,
            method="POST",
        )
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")[:400]
        if "language" in err.lower() or e.code in (400, 422):
            payload2 = json.dumps({"text": text, "model_id": MODEL_ID}).encode()
            return http_json(
                url,
                headers={"xi-api-key": api_key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--langs", default="es,de,pt")
    args = parser.parse_args()
    load_dotenv(QA_ROOT / ".env")
    load_dotenv(LT_ROOT / ".env")
    langs = [x.strip() for x in args.langs.split(",") if x.strip()]
    items: list[dict] = []
    for lang in langs:
        chunk = collect(lang)
        items.extend(chunk)
        print(f"lang={lang} nonwords={len(chunk)}")
    if args.dry_run:
        (OUT / "manifest_dry_run.json").parent.mkdir(parents=True, exist_ok=True)
        (OUT / "manifest_dry_run.json").write_text(json.dumps(items, indent=2), encoding="utf-8")
        return 0
    elabs = env_key("ELEVEN_LABS_API_KEY", "ELEVENLABS_API_KEY", "ELEVEN_API_KEY")
    transcripts_path = OUT / "transcripts.json"
    transcripts = json.loads(transcripts_path.read_text()) if transcripts_path.is_file() else {}
    for i, rec in enumerate(items, 1):
        lang, name = rec["lang"], rec["id"]
        cfg = LANGS[lang]
        cur = download(rec["url"], OUT / "current" / lang / name)
        rec["current_path"] = str(cur)
        dest = OUT / "tts" / lang / name
        key = f"{lang}/{name}"
        if dest.is_file() and dest.stat().st_size > 200:
            rec["tts_path"] = str(dest)
            print(f"[{i}/{len(items)}] skip {key}")
            continue
        if lang == "en" and (EN_CLIPS / name).is_file():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes((EN_CLIPS / name).read_bytes())
            rec["tts_path"] = str(dest)
            rec["tts_source"] = "copied_en_experiment"
            print(f"[{i}/{len(items)}] copy-en {name}")
            continue
        if key in transcripts and transcripts[key].get("text"):
            text = transcripts[key]["text"]
        else:
            print(f"[{i}/{len(items)}] scribe {key}")
            text = transcribe(cur, elabs, cfg["el_lang"])
            transcripts[key] = {"text": text, "source": "scribe"}
            transcripts_path.parent.mkdir(parents=True, exist_ok=True)
            transcripts_path.write_text(json.dumps(transcripts, indent=2, ensure_ascii=False), encoding="utf-8")
            time.sleep(0.12)
        if not text.strip():
            print(f"[{i}/{len(items)}] NO TEXT {key}")
            continue
        print(f"[{i}/{len(items)}] tts {key}: {text[:70]!r}")
        audio = synthesize(text, cfg["voice_id"], elabs, cfg["el_lang"])
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(audio)
        rec["tts_path"] = str(dest)
        rec["text"] = text
        time.sleep(0.15)
    (OUT / "manifest.json").write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
