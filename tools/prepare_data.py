"""Convert raw labelled IMU drive logs into the windowed training CSV.

Input: data/raw/road_<label>.csv files with columns
  host_iso,ax_g,ay_g,az_g,gx_dps,gy_dps,gz_dps,latitude,longitude,time,date,label
one row per ~10 Hz IMU sample, one label per file.

Output: data/roadsense_real.csv in the tools/train.py format —
  label, then 16x6 flattened samples (t0: ax,ay,az,gx,gy,gz, t1: ..., t15).
Labels: smooth=0, pothole=1, speed_breaker=2, rough_patch=3 (cracked -> rough_patch).

Cleaning: drops all-zero sensor-idle rows, splits streams on recording gaps
>0.5 s, and windows each contiguous segment. The recorder captured short
bursts per event, so segments of MIN_SEG..WINDOW samples are centre-padded
(edge replicate) to a full window — same shape the MCU produces around a
trigger peak. Minority classes get overlapping strides plus noise/gain
augmentation to partially rebalance the set.

Usage:
  python tools/prepare_data.py [--raw data/raw] [--out data/roadsense_real.csv]
"""

from __future__ import annotations

import argparse
import csv
import logging
from datetime import datetime
from pathlib import Path

import numpy as np

WINDOW, CHANNELS = 16, 6
GAP_SECONDS = 0.5
MIN_SEG = 8  # shortest burst worth padding into a full window

# file-label -> (class id, window stride, augment copies). Smaller stride =
# more overlap; augment copies are noise/gain-jittered duplicates — both used
# to boost under-represented classes.
LABEL_MAP = {
    "smooth": (0, 16, 0),
    "pothole": (1, 1, 8),
    "speedbreaker": (2, 4, 1),
    "cracked": (3, 2, 0),
}

log = logging.getLogger(__name__)


def load_raw(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Return (timestamps in seconds, samples (n, 6)) with idle rows dropped."""
    ts: list[float] = []
    rows: list[list[float]] = []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            sample = [float(r[k]) for k in ("ax_g", "ay_g", "az_g", "gx_dps", "gy_dps", "gz_dps")]
            if not any(sample[:3]):  # accel all zero = sensor idle, not a real reading
                continue
            ts.append(datetime.fromisoformat(r["host_iso"]).timestamp())
            rows.append(sample)
    return np.array(ts), np.array(rows, dtype=np.float32)


def pad_to_window(seg: np.ndarray) -> np.ndarray:
    """Centre a short burst in a full window, edge-replicating the boundary samples."""
    missing = WINDOW - len(seg)
    before = missing // 2
    return np.pad(seg, ((before, missing - before), (0, 0)), mode="edge")


def window_segments(ts: np.ndarray, samples: np.ndarray, stride: int) -> np.ndarray:
    """Split on recording gaps, then window each contiguous segment.

    Segments shorter than WINDOW but at least MIN_SEG samples become a single
    centre-padded window; longer segments are strided normally.
    """
    if len(ts) == 0:
        return np.empty((0, WINDOW, CHANNELS), dtype=np.float32)
    breaks = np.where(np.diff(ts) > GAP_SECONDS)[0] + 1
    windows = []
    for seg in np.split(samples, breaks):
        if MIN_SEG <= len(seg) < WINDOW:
            windows.append(pad_to_window(seg))
        else:
            for start in range(0, len(seg) - WINDOW + 1, stride):
                windows.append(seg[start:start + WINDOW])
    if not windows:
        return np.empty((0, WINDOW, CHANNELS), dtype=np.float32)
    return np.stack(windows)


def augment(wins: np.ndarray, copies: int, rng: np.random.Generator) -> np.ndarray:
    """Append noise/gain-jittered copies of each window (labelled augmentation)."""
    if copies == 0 or len(wins) == 0:
        return wins
    out = [wins]
    for _ in range(copies):
        gain = rng.uniform(0.85, 1.15, (len(wins), 1, 1)).astype(np.float32)
        noise = rng.normal(0, 0.02, wins.shape).astype(np.float32)
        out.append(wins * gain + noise)
    return np.concatenate(out)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, default=Path("data/raw"))
    ap.add_argument("--out", type=Path, default=Path("data/roadsense_real.csv"))
    args = ap.parse_args()

    rng = np.random.default_rng(7)
    all_x, all_y = [], []
    for name, (cls, stride, copies) in LABEL_MAP.items():
        path = args.raw / f"road_{name}.csv"
        ts, samples = load_raw(path)
        wins = window_segments(ts, samples, stride)
        n_real = len(wins)
        wins = augment(wins, copies, rng)
        log.info("%s: %d clean rows -> %d windows (stride %d, +%d augmented)",
                 path.name, len(samples), len(wins), stride, len(wins) - n_real)
        all_x.append(wins)
        all_y.append(np.full(len(wins), cls, dtype=np.int64))

    X = np.concatenate(all_x)
    y = np.concatenate(all_y)
    order = rng.permutation(len(X))
    X, y = X[order], y[order]

    out_data = np.column_stack((y, X.reshape(len(X), -1)))
    header = "label," + ",".join(f"f{i}" for i in range(WINDOW * CHANNELS))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    np.savetxt(args.out, out_data, delimiter=",", fmt="%g", header=header, comments="")
    counts = {int(k): int(v) for k, v in zip(*np.unique(y, return_counts=True))}
    log.info("wrote %d windows -> %s  class counts: %s", len(X), args.out, counts)


if __name__ == "__main__":
    main()
