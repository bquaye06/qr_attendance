"""Settings for the face service. Every value comes from the environment."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration.

    The service holds no database credentials and no student data by design: it
    only needs the shared secret the API signs its calls with.
    """

    model_config = SettingsConfigDict(env_prefix="FACE_", env_file=".env", extra="ignore")

    service_secret: str = "dev-only-change-me-please"
    """HMAC secret shared with the API. Requests without a valid token are rejected."""

    token_skew_seconds: int = 60

    model_dir: str = "models"
    model_version: str = "insightface-buffalo_l-arcface-r100"
    det_size: int = 640
    embedding_dim: int = 512

    min_face_px: int = 112
    """Minimum inter-eye distance in pixels after scaling."""

    max_yaw_degrees: float = 25.0
    max_pitch_degrees: float = 25.0

    blur_threshold: float = 60.0
    """Variance of Laplacian below this is 'too blurry'."""

    min_brightness: float = 45.0
    max_brightness: float = 215.0

    liveness_threshold: float = 0.8
    require_active_challenge: bool = True

    max_frames: int = 5
    max_frame_bytes: int = 1_000_000
    max_image_side: int = 1280

    log_level: str = "info"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
