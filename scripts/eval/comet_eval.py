"""
COMET-QE: reference-free neural Quality Estimation.

Unlike back-translation, a QE model reads the English source and the target
translation *directly* and predicts a quality score correlated with human
judgments (no lossy round-trip through a second MT system). This is the current
industry standard for automatic MT evaluation (WMT shared tasks).

Default model: `Unbabel/wmt22-cometkiwi-da`.

  IMPORTANT — this is a GATED, non-commercial (CC-BY-NC-SA-4.0) model. Before the
  first run you must, once:
    1. Accept the license at https://huggingface.co/Unbabel/wmt22-cometkiwi-da
    2. Authenticate:  huggingface-cli login   (or set HUGGING_FACE_HUB_TOKEN)
  Otherwise `download_model(...)` fails with a 401/403. An ungated alternative
  for smoke tests is the reference-based `Unbabel/wmt22-comet-da` (needs a
  reference) — for QE stick with cometkiwi.
"""

from __future__ import annotations

from typing import List, Optional

try:
    import torch
    from comet import download_model, load_from_checkpoint
except ImportError:  # pragma: no cover - import guard
    torch = None
    download_model = None
    load_from_checkpoint = None


class CometQEEvaluator:
    def __init__(
        self,
        model_name: str = "Unbabel/wmt22-cometkiwi-da",
        batch_size: int = 16,
        gpus: Optional[int] = None,
    ):
        if load_from_checkpoint is None:
            raise ImportError(
                "unbabel-comet is not installed. `pip install -r requirements.txt`."
            )
        print(f"[comet] loading {model_name} ...")
        checkpoint_path = download_model(model_name)
        self.model = load_from_checkpoint(checkpoint_path)
        self.batch_size = batch_size
        # COMET's predict() drives device placement via the `gpus` arg; default
        # to using a GPU when one is visible.
        if gpus is None:
            gpus = 1 if (torch is not None and torch.cuda.is_available()) else 0
        self.gpus = gpus

    def evaluate_batch(self, sources: List[str], targets: List[str]) -> List[float]:
        """Return one QE score per pair (typically 0..1, higher = better)."""
        if len(sources) != len(targets):
            raise ValueError("sources and targets must have the same length")
        if not sources:
            return []
        data = [{"src": s, "mt": t} for s, t in zip(sources, targets)]
        print(f"[comet] scoring {len(data)} pairs (gpus={self.gpus}) ...")
        output = self.model.predict(data, batch_size=self.batch_size, gpus=self.gpus)
        return [float(s) for s in output.scores]

    def evaluate_single(self, source: str, target: str) -> float:
        return self.evaluate_batch([source], [target])[0]
