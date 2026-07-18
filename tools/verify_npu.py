"""Prove the model actually runs on the Hexagon NPU — never assume.

A model can load "successfully" and silently run on CPU; that's the #1
silent failure. Note: with onnxruntime-qnn 2.x the QNN EP does NOT appear
in get_available_providers() even when working — get_ep_devices() is the
truth. Screenshot the True for the judges.

Run on the X Elite (native ARM64 Python):  python tools/verify_npu.py
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    try:
        import onnxruntime as ort
    except ImportError:
        print("onnxruntime not installed — pip install onnxruntime-qnn", file=sys.stderr)
        return 1

    print(f"onnxruntime {ort.__version__}")

    try:
        import onnxruntime_qnn as q
        os.add_dll_directory(os.path.dirname(q.__file__))
        ort.register_execution_provider_library(
            "QNNExecutionProvider", q.get_library_path())
    except ImportError:
        print("onnxruntime_qnn package not present (plain onnxruntime build)")

    try:
        devices = ort.get_ep_devices()
    except AttributeError:
        print("this onnxruntime has no get_ep_devices(); "
              "falling back to get_available_providers() (less reliable):")
        print(" ", ort.get_available_providers())
        return 2

    npu = [d for d in devices
           if d.ep_name == "QNNExecutionProvider"
           and str(d.device.type).endswith("NPU")]
    for d in devices:
        print(f"  ep={d.ep_name}  device={d.device.type}")
    print(f"\nNPU device found: {bool(npu)}")
    return 0 if npu else 3


if __name__ == "__main__":
    sys.exit(main())
