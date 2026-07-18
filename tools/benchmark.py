"""Latency benchmarks for BENCHMARKS.md: NPU vs CPU baseline.

"23 ms on NPU" is a number; "23 ms on NPU vs 140 ms CPU, 6.1x" is an
argument. Warmup 3, measure 50, report mean/p50/p95/p99.

  python tools/benchmark.py --model models/classifier_int8.onnx --backend qnn
  python tools/benchmark.py --model models/classifier.onnx --backend cpu
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np

WARMUP, RUNS = 3, 50


def bench_onnx(model: Path, backend: str) -> np.ndarray:
    import onnxruntime as ort

    providers = ([("QNNExecutionProvider", {"backend_path": "QnnHtp.dll"})]
                 if backend == "qnn" else ["CPUExecutionProvider"])
    sess = ort.InferenceSession(str(model), providers=providers)
    name = sess.get_inputs()[0].name
    shape = [d if isinstance(d, int) else 1 for d in sess.get_inputs()[0].shape]
    x = np.random.default_rng(0).normal(0, 0.1, shape).astype(np.float32)

    for _ in range(WARMUP):
        sess.run(None, {name: x})
    times = []
    for _ in range(RUNS):
        t0 = time.perf_counter()
        sess.run(None, {name: x})
        times.append((time.perf_counter() - t0) * 1000)
    return np.asarray(times)


def bench_rule_based() -> np.ndarray:
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from pc.detector import RuleBasedDetector

    det = RuleBasedDetector()
    w = np.random.default_rng(0).normal(0, 0.05, (128, 6)).astype(np.float32)
    w[:, 2] += 1.0
    for _ in range(WARMUP):
        det.predict(w, 30.0)
    times = []
    for _ in range(RUNS):
        t0 = time.perf_counter()
        det.predict(w, 30.0)
        times.append((time.perf_counter() - t0) * 1000)
    return np.asarray(times)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", type=Path)
    ap.add_argument("--backend", choices=["qnn", "cpu", "rule"], default="cpu")
    args = ap.parse_args()

    t = bench_rule_based() if args.backend == "rule" else bench_onnx(args.model, args.backend)
    p50, p95, p99 = np.percentile(t, [50, 95, 99])
    print(f"backend={args.backend} runs={RUNS}")
    print(f"mean={t.mean():.2f}ms p50={p50:.2f} p95={p95:.2f} p99={p99:.2f}")
    print("-> paste into BENCHMARKS.md (include the CPU baseline row!)")
