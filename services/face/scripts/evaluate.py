"""Accuracy and fairness evaluation.

Run before changing thresholds or models:

    python -m scripts.evaluate --manifest eval/manifest.csv --threshold 0.45

`manifest.csv` columns:
    path,           image file (consented test set only)
    identity,       subject id
    demographic,    self-reported group label used for the fairness report
    is_spoof        0/1 (optional; omitted means genuine-only evaluation)

The report prints false-accept and false-reject rates overall and per group.
The institution must run this on a consented set and keep the output with the
DPIA. Nothing here writes images anywhere.
"""

from __future__ import annotations

import argparse
import csv
import itertools
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

from app.engine import FaceEngine
from app.pipeline import l2_normalise
from app.settings import get_settings


def load_pairs(manifest: Path, limit: int) -> list[dict[str, str]]:
    with manifest.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    return rows[:limit] if limit else rows


def embed(engine: FaceEngine, path: Path) -> np.ndarray | None:
    image = cv2.imread(str(path))
    if image is None:
        return None
    faces = engine.app.get(image)
    if not faces:
        return None
    return l2_normalise(np.asarray(faces[0].normed_embedding, dtype=np.float32))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=0.45)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    settings = get_settings()
    engine = FaceEngine(Path(settings.model_dir), settings.det_size, settings.model_version)
    engine.load()
    if not engine.loaded:
        raise SystemExit("models are not available; cannot evaluate")

    rows = load_pairs(args.manifest, args.limit)
    embeddings: dict[str, np.ndarray] = {}
    groups: dict[str, str] = {}
    for row in rows:
        path = Path(row["path"])
        vector = embed(engine, path)
        if vector is not None:
            embeddings[row["path"]] = vector
            groups[row["path"]] = row["demographic"]

    genuine_scores: list[tuple[float, str]] = []
    impostor_scores: list[tuple[float, str]] = []
    by_identity: dict[str, list[str]] = defaultdict(list)
    for row in rows:
        if row["path"] in embeddings:
            by_identity[row["identity"]].append(row["path"])

    for paths in by_identity.values():
        for left, right in itertools.combinations(paths, 2):
            score = float(np.dot(embeddings[left], embeddings[right]))
            genuine_scores.append((score, groups[left]))

    all_paths = list(embeddings)
    for left, right in itertools.combinations(all_paths, 2):
        if groups[left] is None or left in by_identity.get(right, []):
            continue
        if _same_identity(left, right, rows):
            continue
        score = float(np.dot(embeddings[left], embeddings[right]))
        impostor_scores.append((score, groups[left]))

    def rates(scores: list[tuple[float, str]]) -> tuple[float, dict[str, float]]:
        if not scores:
            return 0.0, {}
        overall = sum(1 for score, _ in scores if score < args.threshold) / len(scores)
        per_group: dict[str, list[float]] = defaultdict(list)
        for score, group in scores:
            per_group[group].append(1.0 if score < args.threshold else 0.0)
        return overall, {group: sum(values) / len(values) for group, values in per_group.items()}

    frr, frr_by_group = rates(genuine_scores)
    far_by_threshold = {
        threshold: sum(1 for score, _ in impostor_scores if score >= threshold) / max(1, len(impostor_scores))
        for threshold in (0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6)
    }

    print("threshold", args.threshold)
    print("genuine pairs", len(genuine_scores), "impostor pairs", len(impostor_scores))
    print(f"false reject rate {frr:.4f}")
    print("false reject rate by group", {k: round(v, 4) for k, v in frr_by_group.items()})
    print("false accept rate by threshold", {k: round(v, 5) for k, v in far_by_threshold.items()})

    # The institution's bar is FAR below 0.1%.
    safe = [threshold for threshold, value in far_by_threshold.items() if value < 0.001]
    print("thresholds with FAR < 0.1%:", safe)
    if not safe:
        print("WARNING: no evaluated threshold keeps FAR below 0.1%; collect more impostor pairs")


def _same_identity(left: str, right: str, rows: list[dict[str, str]]) -> bool:
    identity = {row["path"]: row["identity"] for row in rows}
    return identity.get(left) == identity.get(right)


if __name__ == "__main__":
    main()
