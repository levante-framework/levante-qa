"""
LLM-as-a-judge using the MQM (Multidimensional Quality Metrics) framework.

Design choices that make this "SOTA" rather than a naive prompt:

* Direct source->target judgment (no back-translation middleman).
* The model emits ONLY a structured list of errors (category, severity, spans).
  The numeric score is computed deterministically in Python from those errors
  (GEMBA-MQM style) — LLMs are unreliable at the arithmetic of "subtract points",
  so we never ask them to do it. `score` and `errors` can therefore never
  disagree.
* API failures are surfaced as `ok=False` / `score=None`, never as a score of 0,
  so a network/quota error is not mistaken for a terrible translation.
* Calls the Gemini REST API via the stdlib (urllib), mirroring
  levante_translations/translation_grading/gemini_quality_evaluator.py. No
  Gemini SDK dependency (the `google-generativeai` SDK is end-of-life).
* Results are cached on disk (resume-safe) so re-runs don't re-spend budget.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Sequence

from cache import JsonDirCache

# Standard MQM severity weights (penalty points). Critical=25 follows the
# stricter MQM variant; adjust here if you prefer the 1/5/10 scheme.
SEVERITY_WEIGHTS = {"minor": 1, "major": 5, "critical": 25}
VALID_CATEGORIES = {"accuracy", "fluency", "terminology", "style"}

# Bump when the prompt/contract changes so stale cache entries are bypassed.
PROMPT_VERSION = "mqm-v1"

PROMPT_TEMPLATE = """You are an expert linguist grading a translation for an educational assessment used with young children (ages 3-8). The text must be accurate, natural, and age-appropriate.

Evaluate the translation from English into {target_locale} using the MQM error typology. Identify every error and classify each one:

category (exactly one of):
- accuracy   (mistranslation, addition, omission, wrong meaning)
- fluency    (grammar, spelling, punctuation, unnatural phrasing)
- terminology(wrong domain/term for the context)
- style      (wrong register/tone, not age-appropriate)

severity (exactly one of):
- minor      (noticeable, meaning preserved)
- major      (meaning changed or confusing)
- critical   (breaks the task, reverses meaning, or is inappropriate for children)

Source (English):
{source}

Translation ({target_locale}):
{target}

Respond with ONLY a JSON object, no prose, matching exactly:
{{
  "errors": [
    {{"category": "...", "severity": "...", "source_span": "...", "target_span": "...", "explanation": "..."}}
  ],
  "assessment": "one-sentence overall summary"
}}
If the translation is perfect, return an empty "errors" array."""


def score_from_errors(errors: Sequence[Dict[str, Any]]) -> int:
    """Deterministic MQM score: 100 minus the summed severity penalties, floored
    at 0. Unknown severities are treated as minor."""
    penalty = 0
    for err in errors:
        sev = str(err.get("severity", "")).strip().lower()
        penalty += SEVERITY_WEIGHTS.get(sev, SEVERITY_WEIGHTS["minor"])
    return max(0, 100 - penalty)


def _normalize_errors(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        cat = str(item.get("category", "")).strip().lower()
        sev = str(item.get("severity", "")).strip().lower()
        if cat not in VALID_CATEGORIES:
            cat = "accuracy"
        if sev not in SEVERITY_WEIGHTS:
            sev = "minor"
        out.append(
            {
                "category": cat,
                "severity": sev,
                "source_span": str(item.get("source_span", "") or ""),
                "target_span": str(item.get("target_span", "") or ""),
                "explanation": str(item.get("explanation", "") or ""),
            }
        )
    return out


class LlmMqmEvaluator:
    def __init__(
        self,
        model_name: str = "gemini-2.5-flash",
        fallback_model: str = "gemini-flash-latest",
        api_key: Optional[str] = None,
        cache_dir: str = "output/llm_cache",
        timeout: int = 90,
    ):
        key = api_key or os.environ.get("GEMINI_API_KEY")
        if not key:
            raise ValueError("GEMINI_API_KEY not set (env var or api_key argument).")
        self.api_key = key
        self.model_name = model_name
        self.fallback_model = fallback_model
        self.timeout = timeout
        self.cache = JsonDirCache(cache_dir)

    def _endpoint(self, model: str) -> str:
        return (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model}:generateContent?key={self.api_key}"
        )

    def _post(self, model: str, prompt: str) -> str:
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0,
                "responseMimeType": "application/json",
                # Disable "thinking" on 2.5 flash: faster/cheaper for this short
                # structured task (ignored by models that don't support it).
                "thinkingConfig": {"thinkingBudget": 0},
            },
        }
        req = urllib.request.Request(
            self._endpoint(model),
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["candidates"][0]["content"]["parts"][0]["text"]

    def _call_with_fallback(self, prompt: str) -> str:
        try:
            return self._post(self.model_name, prompt)
        except urllib.error.HTTPError as exc:
            retriable = exc.code in {400, 404, 429, 503}
            if self.fallback_model and self.fallback_model != self.model_name and retriable:
                return self._post(self.fallback_model, prompt)
            raise

    def evaluate_single(
        self,
        source: str,
        target: str,
        target_locale: str,
        max_retries: int = 3,
        use_cache: bool = True,
    ) -> Dict[str, Any]:
        key = JsonDirCache.make_key(
            PROMPT_VERSION, self.model_name, target_locale, source, target
        )
        if use_cache:
            cached = self.cache.get(key)
            if cached is not None:
                return cached

        prompt = PROMPT_TEMPLATE.format(
            target_locale=target_locale, source=source, target=target
        )

        last_err = ""
        for attempt in range(max_retries):
            try:
                raw = self._call_with_fallback(prompt)
                parsed = json.loads(raw)
                errors = _normalize_errors(parsed.get("errors"))
                result = {
                    "ok": True,
                    "score": score_from_errors(errors),
                    "errors": errors,
                    "assessment": str(parsed.get("assessment", "") or ""),
                    "error": None,
                }
                if use_cache:
                    self.cache.set(key, result)
                return result
            except json.JSONDecodeError as exc:
                last_err = f"JSON parse error: {exc}"
            except Exception as exc:  # network / HTTP / unexpected shape
                last_err = f"{type(exc).__name__}: {exc}"
            time.sleep(2 ** attempt)

        # Exhausted retries: report failure WITHOUT a misleading score. Not
        # cached, so a later run can retry the failed item.
        return {"ok": False, "score": None, "errors": [], "assessment": "", "error": last_err}

    def evaluate_batch(
        self, sources: List[str], targets: List[str], target_locale: str
    ) -> List[Dict[str, Any]]:
        return [
            self.evaluate_single(s, t, target_locale)
            for s, t in zip(sources, targets)
        ]
