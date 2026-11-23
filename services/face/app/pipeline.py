"""Face pipeline: decode -> detect -> quality -> liveness -> embedding.

Pure functions over numpy arrays where possible so the rules can be tested
without loading models. Image buffers are wiped before the response leaves.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from .settings import Settings


class FrameRejectedError(ValueError):
    """A frame could not be decoded or violated a hard limit."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass
class FrameReport:
    quality_score: float
    reasons: list[str] = field(default_factory=list)
    liveness_score: float = 1.0
    face_count: int = 0
    inter_eye_px: float = 0.0
    yaw: float = 0.0
    pitch: float = 0.0
    ear: float | None = None
    embedding: np.ndarray | None = None


def decode_frame(payload: str, settings: Settings) -> np.ndarray:
    """Decode a base64 JPEG/WebP frame, enforcing size limits before decoding."""
    if "," in payload[:64]:
        payload = payload.split(",", 1)[1]
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as error:
        raise FrameRejectedError("invalid_frame", "frame is not valid base64") from error

    if len(raw) > settings.max_frame_bytes:
        raise FrameRejectedError("frame_too_large", "frame exceeds the size limit")

    # Reject anything that is not an image before handing it to OpenCV.
    if not (raw.startswith(b"\xff\xd8") or raw[:4] == b"RIFF" or raw[:4] == b"\x89PNG"):
        raise FrameRejectedError("unsupported_format", "frame must be JPEG, WebP or PNG")

    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise FrameRejectedError("invalid_frame", "frame could not be decoded")

    height, width = image.shape[:2]
    longest = max(height, width)
    if longest > settings.max_image_side:
        scale = settings.max_image_side / longest
        image = cv2.resize(image, (int(width * scale), int(height * scale)))
    return image


def brightness(image: np.ndarray) -> float:
    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return float(np.mean(grey))


def laplacian_variance(image: np.ndarray) -> float:
    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(grey, cv2.CV_64F).var())


def eye_aspect_ratio(landmarks: np.ndarray) -> float:
    """EAR over a 106-point InsightFace landmark set.

    The indices come from the 2d106 layout: left eye 35-41, right eye 89-95.
    A blink drops the ratio well below the open-eye baseline used by
    ``active_challenge_passed``.
    """
    left = landmarks[35:42]
    right = landmarks[89:96]
    return float((_single_eye(left) + _single_eye(right)) / 2.0)


def _single_eye(points: np.ndarray) -> float:
    vertical = np.linalg.norm(points[1] - points[5]) + np.linalg.norm(points[2] - points[4])
    horizontal = 2.0 * np.linalg.norm(points[0] - points[3])
    if horizontal == 0:
        return 0.0
    return float(vertical / horizontal)


def score_quality(
    image: np.ndarray,
    face_count: int,
    inter_eye_px: float,
    yaw: float,
    pitch: float,
    settings: Settings,
) -> tuple[float, list[str]]:
    """Return 0–1 quality and the specific reasons for a low score."""
    reasons: list[str] = []
    score = 1.0

    if face_count == 0:
        return 0.0, ["no_face"]
    if face_count > 1:
        reasons.append("multiple_faces")
        score -= 0.5

    blur = laplacian_variance(image)
    if blur < settings.blur_threshold:
        reasons.append("too_blurry")
        score -= 0.35

    light = brightness(image)
    if light < settings.min_brightness:
        reasons.append("too_dark")
        score -= 0.3
    elif light > settings.max_brightness:
        reasons.append("too_bright")
        score -= 0.25

    if inter_eye_px < settings.min_face_px:
        reasons.append("face_too_small")
        score -= 0.4

    if abs(yaw) > settings.max_yaw_degrees:
        reasons.append("yaw_too_large")
        score -= 0.25
    if abs(pitch) > settings.max_pitch_degrees:
        reasons.append("pitch_too_large")
        score -= 0.25

    return max(0.0, min(1.0, score)), reasons


def active_challenge_passed(challenge: str, ears: list[float], yaws: list[float]) -> bool | None:
    """Verify the challenge from the frame sequence.

    blink: at least one frame has a materially lower eye aspect ratio than the
    median. head turn: the yaw range across frames exceeds 12 degrees in the
    requested direction.
    """
    if challenge == "none" or not ears:
        return None
    if challenge == "blink":
        baseline = float(np.median(ears))
        if baseline <= 0:
            return False
        return any(ear < baseline * 0.65 for ear in ears)
    if challenge in {"turn_left", "turn_right"}:
        if len(yaws) < 2:
            return False
        span = max(yaws) - min(yaws)
        if span < 12.0:
            return False
        delta = yaws[-1] - yaws[0]
        return delta < 0 if challenge == "turn_left" else delta > 0
    return None


def passive_liveness_scores(engine: Any, faces: list[Any], frames: list[np.ndarray]) -> list[float]:
    """Anti-spoofing per frame; falls back to a conservative constant.

    Without the ONNX anti-spoof model the service must not pretend to know: it
    returns 0.5 and the API's liveness threshold rejects it, so a missing model
    fails closed rather than open.
    """
    if engine.antispoof is None:
        return [0.5 for _ in frames]
    scores: list[float] = []
    for face, frame in zip(faces, frames, strict=False):
        box = face.bbox.astype(int)
        crop = frame[max(0, box[1]) : box[3], max(0, box[0]) : box[2]]
        if crop.size == 0:
            scores.append(0.0)
            continue
        resized = cv2.resize(crop, (128, 128)).astype(np.float32) / 255.0
        tensor = np.transpose(resized, (2, 0, 1))[None, ...]
        inputs = {engine.antispoof.get_inputs()[0].name: tensor}
        output = engine.antispoof.run(None, inputs)[0]
        scores.append(float(np.asarray(output).reshape(-1)[1]))
    return scores


def l2_normalise(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    if norm == 0:
        raise FrameRejectedError("invalid_embedding", "empty embedding")
    return vector / norm


def wipe(*arrays: np.ndarray | None) -> None:
    """Overwrite image buffers before responding. Best-effort, cheap."""
    for array in arrays:
        if array is None:
            continue
        if array.flags.writeable:
            array.fill(0)
