"""Pipeline tests that do not need the ONNX models.

Run with: pytest services/face/tests
"""

from __future__ import annotations

import base64

import numpy as np
import pytest

from app.pipeline import (
    FrameRejectedError,
    active_challenge_passed,
    brightness,
    decode_frame,
    l2_normalise,
    laplacian_variance,
    score_quality,
    wipe,
)
from app.settings import Settings


@pytest.fixture()
def settings() -> Settings:
    return Settings()


def encode(array: np.ndarray, quality: int = 90) -> str:
    import cv2

    ok, buffer = cv2.imencode(".jpg", array, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    assert ok
    return base64.b64encode(buffer.tobytes()).decode()


def test_decodes_a_jpeg(settings: Settings) -> None:
    image = np.full((320, 240, 3), 128, dtype=np.uint8)
    decoded = decode_frame(encode(image), settings)
    assert decoded.shape[2] == 3
    assert decoded.shape[0] > 0


def test_rejects_non_image_payloads(settings: Settings) -> None:
    with pytest.raises(FrameRejectedError) as error:
        decode_frame(base64.b64encode(b"not an image").decode(), settings)
    assert error.value.code == "unsupported_format"


def test_rejects_invalid_base64(settings: Settings) -> None:
    with pytest.raises(FrameRejectedError):
        decode_frame("!!!!", settings)


def test_rejects_oversized_frames(settings: Settings) -> None:
    payload = base64.b64encode(b"\xff\xd8" + b"0" * (settings.max_frame_bytes + 10)).decode()
    with pytest.raises(FrameRejectedError) as error:
        decode_frame(payload, settings)
    assert error.value.code == "frame_too_large"


def test_quality_flags_dark_and_small_faces(settings: Settings) -> None:
    dark = np.zeros((300, 300, 3), dtype=np.uint8)
    score, reasons = score_quality(dark, face_count=1, inter_eye_px=40, yaw=0, pitch=0, settings=settings)
    assert score < 0.7
    assert "too_dark" in reasons
    assert "face_too_small" in reasons


def test_quality_rejects_multiple_faces(settings: Settings) -> None:
    image = np.full((300, 300, 3), 140, dtype=np.uint8)
    _, reasons = score_quality(image, face_count=2, inter_eye_px=200, yaw=0, pitch=0, settings=settings)
    assert "multiple_faces" in reasons


def test_quality_penalises_pose(settings: Settings) -> None:
    image = np.full((400, 400, 3), 140, dtype=np.uint8)
    _, reasons = score_quality(image, face_count=1, inter_eye_px=200, yaw=40, pitch=0, settings=settings)
    assert "yaw_too_large" in reasons


def test_blur_detection_separates_sharp_and_blurred() -> None:
    checker = np.indices((200, 200)).sum(axis=0) % 2 * 255
    sharp = np.repeat(checker[:, :, None], 3, axis=2).astype(np.uint8)
    blurred = np.full((200, 200, 3), 128, dtype=np.uint8)
    assert laplacian_variance(sharp) > laplacian_variance(blurred)
    assert brightness(blurred) == pytest.approx(128, abs=1)


def test_blink_challenge_requires_an_eye_closure() -> None:
    assert active_challenge_passed("blink", [0.30, 0.31, 0.12], [0.0, 0.0, 0.0]) is True
    assert active_challenge_passed("blink", [0.30, 0.31, 0.29], [0.0, 0.0, 0.0]) is False


def test_head_turn_challenge_requires_direction() -> None:
    assert active_challenge_passed("turn_left", [0.3, 0.3], [-20.0, 5.0]) is True
    assert active_challenge_passed("turn_left", [0.3, 0.3], [5.0, 20.0]) is False
    assert active_challenge_passed("turn_right", [0.3, 0.3], [5.0, 20.0]) is True
    assert active_challenge_passed("none", [], []) is None


def test_templates_are_unit_length() -> None:
    vector = np.array([3.0, 4.0], dtype=np.float32)
    assert float(np.linalg.norm(l2_normalise(vector))) == pytest.approx(1.0)


def test_buffers_are_wiped() -> None:
    image = np.full((10, 10, 3), 255, dtype=np.uint8)
    wipe(image)
    assert int(image.max()) == 0
