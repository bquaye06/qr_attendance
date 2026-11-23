"""FastAPI application for the face service.

Stateless by design:
  * no database, no storage, no logging of images or embeddings
  * only the API can call it, proven with a short-lived HMAC service token
  * responses carry scores and a 512-d embedding; the API decides attendance
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

from .engine import FaceEngine, verify_model_files
from .pipeline import (
    FrameRejectedError,
    active_challenge_passed,
    decode_frame,
    eye_aspect_ratio,
    l2_normalise,
    passive_liveness_scores,
    score_quality,
    wipe,
)
from .schemas import EnrollRequest, FaceResponse, HealthResponse, VerifyRequest
from .settings import get_settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("attend.face")

REQUEST_COUNT = Counter("face_requests_total", "Requests by endpoint and outcome", ["endpoint", "outcome"])
LATENCY = Histogram("face_request_seconds", "Request latency", ["endpoint"])

settings = get_settings()
engine = FaceEngine(Path(settings.model_dir), settings.det_size, settings.model_version)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    problems = verify_model_files(Path(settings.model_dir), Path("models.lock"))
    if problems:
        logger.warning("model checksum problems: %s", problems)
    engine.load()
    logger.info("face service ready (models_loaded=%s, version=%s)", engine.loaded, engine.model_version)
    yield


app = FastAPI(title="Attend face service", version="0.1.0", lifespan=lifespan)


def verify_service_token(header: str | None) -> None:
    """Reject anything that is not the API.

    Format: ``t=<unix seconds>.<hex hmac-sha256 of the timestamp>``.
    """
    if not header:
        raise HTTPException(status_code=401, detail="missing service token")
    match = header.split("=", 1)
    if len(match) != 2 or "." not in match[1]:
        raise HTTPException(status_code=401, detail="malformed service token")
    timestamp, _, signature = match[1].partition(".")
    try:
        issued_at = int(timestamp)
    except ValueError as error:
        raise HTTPException(status_code=401, detail="malformed service token") from error
    if abs(int(time.time()) - issued_at) > settings.token_skew_seconds:
        raise HTTPException(status_code=401, detail="service token expired")
    expected = hmac.new(
        settings.service_secret.encode(), timestamp.encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=401, detail="bad service token")


def _process(frames_b64: list[str], challenge: str) -> FaceResponse:
    started = time.perf_counter()
    if not 1 <= len(frames_b64) <= settings.max_frames:
        raise HTTPException(status_code=422, detail=f"1–{settings.max_frames} frames required")

    images: list[np.ndarray] = []
    try:
        for payload in frames_b64:
            images.append(decode_frame(payload, settings))

        reports = []
        embeddings: list[np.ndarray] = []
        ears: list[float] = []
        yaws: list[float] = []

        for image in images:
            faces = engine.app.get(image)
            quality, reasons = score_quality(
                image,
                face_count=len(faces),
                inter_eye_px=float(np.linalg.norm(faces[0].kps[0] - faces[0].kps[1])) if faces else 0.0,
                yaw=float(faces[0].pose[1]) if faces and faces[0].pose is not None else 0.0,
                pitch=float(faces[0].pose[0]) if faces and faces[0].pose is not None else 0.0,
                settings=settings,
            )
            reports.append((quality, reasons))
            if faces:
                face = faces[0]
                embeddings.append(l2_normalise(np.asarray(face.normed_embedding, dtype=np.float32)))
                if face.landmark_2d_106 is not None:
                    ears.append(eye_aspect_ratio(np.asarray(face.landmark_2d_106, dtype=np.float32)))
                if face.pose is not None:
                    yaws.append(float(face.pose[1]))

        good = [report for report in reports if report[0] >= 0.4]
        if not embeddings or not good:
            worst = reports[0][1] if reports else ["no_face"]
            REQUEST_COUNT.labels(endpoint="verify", outcome="rejected").inc()
            raise HTTPException(
                status_code=422,
                detail={"code": worst[0] if worst else "no_face", "reasons": worst},
            )

        passive = passive_liveness_scores(engine, [engine.app.get(images[0])[0]] if images else [], images)
        liveness_score = float(np.mean([score for score in passive])) if passive else 0.0
        challenge_passed = active_challenge_passed(challenge, ears, yaws)
        liveness_passed = liveness_score >= settings.liveness_threshold and (
            challenge_passed is not False if settings.require_active_challenge else True
        )

        averaged = np.mean(np.stack(embeddings), axis=0)
        embedding = l2_normalise(averaged)

        quality_score = float(np.mean([report[0] for report in reports]))
        reasons = sorted({reason for report in reports for reason in report[1]})

        elapsed_ms = (time.perf_counter() - started) * 1000
        LATENCY.labels(endpoint="process").observe(elapsed_ms / 1000)
        REQUEST_COUNT.labels(endpoint="process", outcome="ok").inc()

        return FaceResponse(
            modelVersion=engine.model_version,
            embedding=[float(value) for value in embedding.tolist()],
            qualityScore=quality_score,
            qualityReasons=reasons,
            livenessScore=liveness_score,
            livenessPassed=liveness_passed,
            framesAccepted=len(embeddings),
            activeChallengePassed=challenge_passed,
            processingMs=round(elapsed_ms, 1),
        )
    finally:
        wipe(*images)


@app.post("/v1/enroll", response_model=FaceResponse)
async def enroll(
    payload: EnrollRequest, request: Request, x_service_token: str | None = Header(default=None)
) -> FaceResponse:
    verify_service_token(x_service_token)
    try:
        return _process(payload.frames, payload.challenge)
    except FrameRejectedError as error:
        REQUEST_COUNT.labels(endpoint="enroll", outcome="rejected").inc()
        raise HTTPException(status_code=422, detail={"code": error.code, "detail": error.detail}) from error


@app.post("/v1/verify", response_model=FaceResponse)
async def verify(
    payload: VerifyRequest, request: Request, x_service_token: str | None = Header(default=None)
) -> FaceResponse:
    verify_service_token(x_service_token)
    try:
        return _process(payload.frames, payload.challenge)
    except FrameRejectedError as error:
        REQUEST_COUNT.labels(endpoint="verify", outcome="rejected").inc()
        raise HTTPException(status_code=422, detail={"code": error.code, "detail": error.detail}) from error


@app.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    return HealthResponse(status="ok", modelVersion=engine.model_version, modelsLoaded=engine.loaded)


@app.get("/readyz", response_model=HealthResponse)
async def readyz() -> JSONResponse:
    payload = HealthResponse(
        status="ok" if engine.loaded else "degraded",
        modelVersion=engine.model_version,
        modelsLoaded=engine.loaded,
    )
    return JSONResponse(status_code=200 if engine.loaded else 503, content=payload.model_dump())


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)
