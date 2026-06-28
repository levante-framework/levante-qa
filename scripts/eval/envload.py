"""
Tiny .env loader (no dependency), so the eval scripts pick up GEMINI_API_KEY and
CROWDIN_API_TOKEN from levante-qa/.env the same way the Node tooling uses dotenv.

Searches upward from this file for the first `.env` and loads KEY=VALUE lines
into os.environ WITHOUT overwriting variables already set in the environment.
"""

from __future__ import annotations

import os
from pathlib import Path


def load_env(start: Path | None = None) -> None:
    here = (start or Path(__file__)).resolve()
    for directory in [here, *here.parents]:
        candidate = directory / ".env"
        if candidate.is_file():
            _apply(candidate)
            return


def _apply(path: Path) -> None:
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        pass
