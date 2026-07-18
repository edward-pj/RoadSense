"""Deterministic tests for feature extraction and the rule-based detector.

Synthetic windows mirror the physics used in tools/train.py: pothole = sharp
dip+rebound, speed breaker = slow hump, rough patch = sustained vibration.
"""

from __future__ import annotations

import numpy as np
import pytest

from pc import features
from pc.detector import CLASSES, RuleBasedDetector


def _base_window(rng: np.random.Generator) -> np.ndarray:
    w = rng.normal(0, 0.01, (128, 6)).astype(np.float32)
    w[:, 2] += 1.0  # gravity
    return w


@pytest.fixture()
def rng() -> np.random.Generator:
    return np.random.default_rng(11)


def _pothole(rng: np.random.Generator) -> np.ndarray:
    w = _base_window(rng)
    w[60:68, 2] -= 0.8 * np.hanning(8)
    w[66:74, 2] += 0.5 * np.hanning(8)
    return w


def _speed_breaker(rng: np.random.Generator) -> np.ndarray:
    w = _base_window(rng)
    t = np.arange(128)
    w[:, 2] += 0.45 * np.exp(-((t - 64) ** 2) / 300)
    return w


def _rough(rng: np.random.Generator) -> np.ndarray:
    w = _base_window(rng)
    w[:, 2] += rng.normal(0, 0.18, 128).astype(np.float32)
    return w


def test_smooth_window_is_smooth(rng: np.random.Generator) -> None:
    det = RuleBasedDetector().predict(_base_window(rng), 30.0)
    assert det.road_class == "smooth"
    assert det.severity == 0.0


def test_pothole_detected(rng: np.random.Generator) -> None:
    det = RuleBasedDetector().predict(_pothole(rng), 30.0)
    assert det.road_class == "pothole"
    assert det.severity > 0


def test_speed_breaker_detected(rng: np.random.Generator) -> None:
    det = RuleBasedDetector().predict(_speed_breaker(rng), 30.0)
    assert det.road_class == "speed_breaker"


def test_rough_patch_detected(rng: np.random.Generator) -> None:
    det = RuleBasedDetector().predict(_rough(rng), 30.0)
    assert det.road_class == "rough_patch"


def test_severity_is_speed_normalised() -> None:
    slow = features.severity_score(0.8, 20.0)
    fast = features.severity_score(0.8, 80.0)
    assert slow > fast  # same bump at higher speed -> lower road defect score


def test_vehicle_factor_scales_severity() -> None:
    bike = features.severity_score(0.8, 30.0, vehicle_factor=0.7)
    suv = features.severity_score(0.8, 30.0, vehicle_factor=1.3)
    assert suv > bike


def test_gravity_align_recovers_rotated_mount(rng: np.random.Generator) -> None:
    """A pothole must classify identically with the sensor mounted sideways."""
    w = _pothole(rng)
    theta = np.deg2rad(90)
    rot = np.array([[1, 0, 0],
                    [0, np.cos(theta), -np.sin(theta)],
                    [0, np.sin(theta), np.cos(theta)]], dtype=np.float32)
    rotated = w.copy()
    rotated[:, :3] = w[:, :3] @ rot.T
    rotated[:, 3:] = w[:, 3:] @ rot.T
    det = RuleBasedDetector().predict(rotated, 30.0)
    assert det.road_class == "pothole"


def test_bad_window_shape_raises() -> None:
    with pytest.raises(ValueError):
        features.normalize_window(np.zeros((64, 6), dtype=np.float32))


def test_classes_tuple_matches_training() -> None:
    assert CLASSES == ("smooth", "pothole", "speed_breaker", "rough_patch")
