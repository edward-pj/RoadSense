"""Feature extraction shared by every detector strategy.

A window is a (128, 6) float32 array: accel xyz (g) + gyro xyz (dps) @ 100 Hz,
centred on the trigger peak. Features are deterministic so the rule-based
fallback and unit tests behave identically everywhere.
"""

from __future__ import annotations

import numpy as np

WINDOW_SAMPLES = 128
CHANNELS = 6
SAMPLE_RATE_HZ = 100.0
GRAVITY = 1.0  # accel is in g


def normalize_window(window: np.ndarray) -> np.ndarray:
    """Subtract gravity from z, cast to float32. Shape must be (128, 6)."""
    if window.shape != (WINDOW_SAMPLES, CHANNELS):
        raise ValueError(f"expected {(WINDOW_SAMPLES, CHANNELS)}, got {window.shape}")
    w = window.astype(np.float32).copy()
    w[:, 2] -= GRAVITY
    return w


def gravity_align(window: np.ndarray) -> np.ndarray:
    """Rotate axes so mean acceleration points down z — makes detection
    robust to how the sensor is taped on (mount-orientation calibration)."""
    g = window[:, :3].mean(axis=0)
    norm = np.linalg.norm(g)
    if norm < 1e-6:
        return window
    z = g / norm
    x = np.cross([0.0, 1.0, 0.0], z)
    if np.linalg.norm(x) < 1e-6:
        x = np.cross([1.0, 0.0, 0.0], z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    rot = np.stack([x, y, z])
    out = window.copy()
    out[:, :3] = window[:, :3] @ rot.T
    out[:, 3:] = window[:, 3:] @ rot.T
    return out


def feature_vector(window: np.ndarray) -> dict[str, float]:
    """Scalar features used by the rule-based detector and severity scoring."""
    w = normalize_window(window)
    az = w[:, 2]
    jerk = np.diff(az) * SAMPLE_RATE_HZ
    fft = np.abs(np.fft.rfft(az))
    freqs = np.fft.rfftfreq(len(az), d=1.0 / SAMPLE_RATE_HZ)
    # Mean energy per bin, NOT sum — bands have unequal widths and a raw sum
    # lets the widest band win on bin count alone.
    band = lambda lo, hi: float(fft[(freqs >= lo) & (freqs < hi)].mean())
    rms = float(np.sqrt(np.mean(az ** 2))) or 1e-9
    return {
        "peak_az": float(np.max(np.abs(az))),
        "min_az": float(np.min(az)),
        "var_az": float(np.var(az)),
        "peak_jerk": float(np.max(np.abs(jerk))),
        "crest": float(np.max(np.abs(az))) / rms,  # transient vs sustained
        "rms_gyro": float(np.sqrt(np.mean(w[:, 3:] ** 2))),
        "band_low": band(0.5, 4),    # long undulation -> speed breaker
        "band_mid": band(4, 15),     # sharp impact -> pothole
        "band_high": band(15, 50),   # sustained texture -> rough patch
    }


def severity_score(peak_az_g: float, speed_kmh: float,
                   vehicle_factor: float = 1.0) -> float:
    """Speed-normalised 0-10 severity.

    The same pothole hits harder at speed, so raw peak is divided by
    (v / v_ref)^alpha; vehicle_factor calibrates suspension stiffness
    (2-wheeler 0.7, hatchback 1.0, SUV 1.3).
    """
    v_ref, alpha = 30.0, 1.5
    v = max(speed_kmh, 5.0)  # floor avoids blow-up when crawling
    norm = peak_az_g / ((v / v_ref) ** alpha)
    return float(np.clip(norm * vehicle_factor * 4.0, 0.0, 10.0))
