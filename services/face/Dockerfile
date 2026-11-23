# CPU image. For GPU, swap the base image and add onnxruntime-gpu.
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY models.lock ./models.lock
COPY scripts ./scripts

# Models are mounted read-only at runtime; they are never baked into the image.
VOLUME ["/srv/models"]

RUN useradd --create-home --uid 10001 attend
USER attend

EXPOSE 8000
HEALTHCHECK --interval=20s --timeout=3s --start-period=30s \
  CMD curl -fsS http://localhost:8000/healthz || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
