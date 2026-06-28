"""
Multilingual sentence-embedding signals.

Two complementary, millisecond-cheap checks (the fast first line of defense
before the heavier COMET / LLM passes):

1. Direct cross-lingual similarity: cosine(source, target). Catches catastrophic
   failures (untranslated, empty, or unrelated text). Note raw cross-lingual
   cosine is only weakly discriminative on its own (even unrelated sentence pairs
   sit around 0.7-0.8), which is exactly why we also compute (2).

2. Same-item centroid similarity: for an item translated into several languages,
   embed all the *other* languages, take their centroid, and measure how far the
   target sits from it — mirroring `same_item_centroid_sim` in
   levante_translations/translation_grading/embedding_baseline.py. An item that
   every other language renders consistently but one language renders oddly shows
   up as a low centroid similarity even when its raw source cosine looks fine.

Default model: `intfloat/multilingual-e5-large` (SOTA multilingual embeddings).
E5 expects an instruction prefix; for symmetric similarity the model card
recommends "query: " on BOTH sides (asymmetric query:/passage: framing is for
retrieval and slightly distorts a symmetric comparison).
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence

import numpy as np

try:
    import torch
    from sentence_transformers import SentenceTransformer
except ImportError:  # pragma: no cover - import guard
    torch = None
    SentenceTransformer = None


class EmbeddingEvaluator:
    def __init__(
        self,
        model_name: str = "intfloat/multilingual-e5-large",
        batch_size: int = 32,
    ):
        if SentenceTransformer is None:
            raise ImportError(
                "sentence-transformers is not installed. `pip install -r requirements.txt`."
            )
        device = "cuda" if (torch is not None and torch.cuda.is_available()) else "cpu"
        print(f"[embed] loading {model_name} on {device} ...")
        self.model = SentenceTransformer(model_name, device=device)
        self.batch_size = batch_size
        self.is_e5 = "e5" in model_name.lower()

    def _prefix(self, texts: Sequence[str]) -> List[str]:
        if self.is_e5:
            return [f"query: {t}" for t in texts]
        return list(texts)

    def _encode(self, texts: Sequence[str]) -> np.ndarray:
        return self.model.encode(
            self._prefix(texts),
            batch_size=self.batch_size,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )

    def evaluate_batch(self, sources: List[str], targets: List[str]) -> List[float]:
        """Direct cosine(source, target). Inputs are L2-normalized, so the cosine
        is just the row-wise dot product."""
        if len(sources) != len(targets):
            raise ValueError("sources and targets must have the same length")
        if not sources:
            return []
        print(f"[embed] direct similarity on {len(sources)} pairs ...")
        src = self._encode(sources)
        tgt = self._encode(targets)
        return np.sum(src * tgt, axis=1).astype(float).tolist()

    def centroid_scores(
        self,
        rows: Sequence[Dict[str, str]],
        target_lang: str,
        other_langs: Sequence[str],
    ) -> List[Optional[float]]:
        """
        For each row (a dict of lang -> text), cosine between the target-language
        text and the centroid of the *other* languages present for that item.
        Returns None for a row when the target is missing or no other-language
        text is available to form a centroid.
        """
        # Embed every distinct text once, then assemble per-row.
        unique: Dict[str, int] = {}
        for row in rows:
            for lang in (target_lang, *other_langs):
                txt = (row.get(lang) or "").strip()
                if txt and txt not in unique:
                    unique[txt] = len(unique)
        if not unique:
            return [None] * len(rows)
        texts = list(unique.keys())
        vectors = self._encode(texts)

        out: List[Optional[float]] = []
        for row in rows:
            tgt_txt = (row.get(target_lang) or "").strip()
            if not tgt_txt:
                out.append(None)
                continue
            other_vecs = [
                vectors[unique[(row.get(l) or "").strip()]]
                for l in other_langs
                if (row.get(l) or "").strip()
            ]
            if not other_vecs:
                out.append(None)
                continue
            centroid = np.mean(np.stack(other_vecs), axis=0)
            norm = np.linalg.norm(centroid)
            if norm == 0:
                out.append(None)
                continue
            centroid = centroid / norm
            out.append(float(np.dot(vectors[unique[tgt_txt]], centroid)))
        return out

    def evaluate_single(self, source: str, target: str) -> float:
        return self.evaluate_batch([source], [target])[0]
