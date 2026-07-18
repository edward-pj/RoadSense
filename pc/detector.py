"""Road-quality detector strategies (Strategy pattern).

Every strategy implements `predict(window) -> Detection`. The factory picks
the best available backend at startup — QNN on the Hexagon NPU, then CPU
ONNX Runtime, then the deterministic rule-based detector. Downstream code
(pc/server.py) never branches on which backend is live.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np

from . import features

log = logging.getLogger("roadsense.detector")

CLASSES = ("smooth", "pothole", "speed_breaker", "rough_patch")
MODEL_PATH = Path(__file__).resolve().parent.parent / "models" / "classifier_int8.onnx"


@dataclass(frozen=True)
class Detection:
    road_class: str
    confidence: float
    severity: float
    backend: str


class Detector(Protocol):
    """Single interface every inference backend implements."""

    backend: str

    def predict(self, window: np.ndarray, speed_kmh: float,
                vehicle_factor: float = 1.0) -> Detection: ...


class OnnxDetector:
    """ONNX Runtime detector; `providers` decides NPU (QNN EP) vs CPU."""

    def __init__(self, providers: list, backend: str) -> None:
        import onnxruntime as ort  # deferred: not installed everywhere

        self.backend = backend
        self._session = ort.InferenceSession(str(MODEL_PATH), providers=providers)
        self._input = self._session.get_inputs()[0].name

    def predict(self, window: np.ndarray, speed_kmh: float,
                vehicle_factor: float = 1.0) -> Detection:
        w = features.gravity_align(window)
        x = features.normalize_window(w)[np.newaxis].transpose(0, 2, 1)  # (1, 6, 128)
        logits, sev_raw = self._session.run(None, {self._input: x})
        probs = np.exp(logits[0]) / np.exp(logits[0]).sum()
        idx = int(np.argmax(probs))
        severity = features.severity_score(float(sev_raw[0][0]) * 2.0,
                                           speed_kmh, vehicle_factor)
        return Detection(CLASSES[idx], float(probs[idx]), severity, self.backend)


class RuleBasedDetector:
    """Deterministic fallback: FFT band shape + peak/jerk thresholds.

    Thresholds derive from the physics of each event type — a pothole is one
    sharp negative-then-positive spike (mid-band), a speed breaker is a slow
    hump (low band), a rough patch is sustained wideband texture.
    """

    backend = "rule_based"

    PEAK_EVENT_G = 0.35   # below this (and low variance) the road is smooth
    ROUGH_VAR = 0.02      # sustained variance floor for a rough patch
    CREST_TRANSIENT = 4.5  # localized spike (pothole) vs spread energy (rough)

    def predict(self, window: np.ndarray, speed_kmh: float,
                vehicle_factor: float = 1.0) -> Detection:
        w = features.gravity_align(window)
        f = features.feature_vector(w)
        severity = features.severity_score(f["peak_az"], speed_kmh, vehicle_factor)

        if f["peak_az"] < self.PEAK_EVENT_G and f["var_az"] < self.ROUGH_VAR:
            return Detection("smooth", 0.9, 0.0, self.backend)
        # Slow low-frequency hump with no sharp downward dip = speed breaker.
        if (f["band_low"] > f["band_mid"] and f["band_low"] > f["band_high"]
                and f["min_az"] > -self.PEAK_EVENT_G):
            return Detection("speed_breaker", 0.75, severity, self.backend)
        # One localized transient (high crest factor) = pothole;
        # energy spread across the whole window = rough patch.
        if f["crest"] >= self.CREST_TRANSIENT:
            return Detection("pothole", 0.8, severity, self.backend)
        return Detection("rough_patch", 0.7, severity, self.backend)


def get_detector() -> Detector:
    """Availability-based selection, decided once at startup.

    Order: QNN EP (Hexagon NPU) -> CPU ONNX -> rule-based. Never raises.
    """
    if MODEL_PATH.exists():
        try:
            det = OnnxDetector(
                [("QNNExecutionProvider", {"backend_path": "QnnHtp.dll"})],
                backend="qnn_npu")
            log.info("detector backend: QNN (Hexagon NPU)")
            return det
        except Exception as exc:
            log.warning("QNN unavailable (%s); trying CPU ONNX", exc)
        try:
            det = OnnxDetector(["CPUExecutionProvider"], backend="onnx_cpu")
            log.info("detector backend: ONNX CPU")
            return det
        except Exception as exc:
            log.warning("CPU ONNX unavailable (%s); using rule-based", exc)
    else:
        log.warning("model %s missing; using rule-based detector", MODEL_PATH)
    return RuleBasedDetector()
