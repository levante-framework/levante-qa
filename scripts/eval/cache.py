"""
Resume-safe disk cache for expensive, rate-limited calls (the Gemini LLM judge).

One JSON file per cache key under a directory, so a crashed/cancelled run loses
nothing and re-running skips everything already computed without re-spending API
budget. Mirrors the caching philosophy already used in
levante_translations/translation_grading/gemini_quality_evaluator.py.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Optional


class JsonDirCache:
    def __init__(self, cache_dir: str | Path):
        self.dir = Path(cache_dir)
        self.dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def make_key(*parts: Any) -> str:
        blob = json.dumps(parts, ensure_ascii=False, sort_keys=True, default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def _path(self, key: str) -> Path:
        return self.dir / f"{key}.json"

    def get(self, key: str) -> Optional[Any]:
        path = self._path(key)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def set(self, key: str, value: Any) -> None:
        # Atomic-ish write: temp file then replace, so a kill mid-write can't
        # leave a half-written cache entry that later parses as garbage.
        path = self._path(key)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
