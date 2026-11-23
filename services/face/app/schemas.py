"""Wire schemas shared with the API (packages/contracts/src/schemas/biometrics.ts)."""

from typing import Literal

from pydantic import BaseModel, Field

LivenessChallenge = Literal["blink", "turn_left", "turn_right", "none"]


class EnrollRequest(BaseModel):
    frames: list[str] = Field(min_length=1, max_length=5)
    challenge: LivenessChallenge = "none"


class VerifyRequest(BaseModel):
    frames: list[str] = Field(min_length=1, max_length=5)
    challenge: LivenessChallenge = "none"


class FaceResponse(BaseModel):
    modelVersion: str
    embedding: list[float] = Field(min_length=512, max_length=512)
    qualityScore: float
    qualityReasons: list[str]
    livenessScore: float
    livenessPassed: bool
    framesAccepted: int
    activeChallengePassed: bool | None
    processingMs: float


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    modelVersion: str
    modelsLoaded: bool


class ProblemDetail(BaseModel):
    type: str
    title: str
    status: int
    code: str
    detail: str
