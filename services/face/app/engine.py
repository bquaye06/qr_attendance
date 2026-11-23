"""Model loading.

Models load once at startup through ONNX Runtime and are pinned by SHA-256 in
``models.lock``; the running model version is reported on every response so the
API can migrate templates when the model changes.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class ModelUnavailableError(RuntimeError):
    """Raised when the detector/recogniser could not be loaded."""


def verify_model_files(model_dir: Path, lock_path: Path) -> list[str]:
    """Return the names of files whose checksum does not match models.lock."""
    if not lock_path.exists():
        return []
    problems: list[str] = []
    for line in lock_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        digest, _, name = line.partition("  ")
        path = model_dir / name.strip()
        if not path.exists():
            problems.append(f"{name}: missing")
            continue
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != digest:
            problems.append(f"{name}: checksum mismatch")
    return problems


class FaceEngine:
    """Thin wrapper around InsightFace that never keeps images after a request."""

    def __init__(self, model_dir: Path, det_size: int, model_version: str) -> None:
        self.model_dir = model_dir
        self.det_size = det_size
        self.model_version = model_version
        self._app: Any | None = None
        self._antispoof: Any | None = None

    def load(self) -> None:
        try:
            from insightface.app import FaceAnalysis  # imported lazily: heavy dependency

            app = FaceAnalysis(
                name="buffalo_l",
                root=str(self.model_dir.parent),
                allowed_modules=["detection", "recognition", "landmark_2d_106"],
                providers=["CPUExecutionProvider"],
            )
            app.prepare(ctx_id=-1, det_size=(self.det_size, self.det_size))
            self._app = app
        except Exception as error:  # noqa: BLE001 - startup must report, not crash-loop
            logger.error("face models failed to load: %s", error)
            self._app = None
            return

        antispoof_path = self.model_dir / "antispoof.onnx"
        if antispoof_path.exists():
            try:
                import onnxruntime

                self._antispoof = onnxruntime.InferenceSession(
                    str(antispoof_path), providers=["CPUExecutionProvider"]
                )
            except Exception as error:  # noqa: BLE001
                logger.warning("anti-spoofing model unavailable: %s", error)
                self._antispoof = None

    @property
    def loaded(self) -> bool:
        return self._app is not None

    @property
    def app(self) -> Any:
        if self._app is None:
            raise ModelUnavailableError("face models are not loaded")
        return self._app

    @property
    def antispoof(self) -> Any | None:
        return self._antispoof
