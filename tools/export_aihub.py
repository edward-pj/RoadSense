"""Qualcomm AI Hub pipeline: INT8 quantize -> compile -> profile -> download.

One command per target:
  python tools/export_aihub.py --target xelite   # QNN context binary, NPU v73
  python tools/export_aihub.py --target phone    # LiteRT .tflite, NPU v81
  python tools/export_aihub.py --list-devices    # find exact device labels

Prereqs (once):
  pip install qai-hub
  qai-hub configure --api_token <token from app.aihub.qualcomm.com>

AI Hub jobs queue on SHARED real hardware — during the hackathon everyone
hits it at once, so run this as early as possible and commit the artifacts.
Read the op-coverage output of every compile job: >= 80% of ops on NPU is
healthy; below that, restructure the model (boring ops only).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

MODELS = Path(__file__).resolve().parent.parent / "models"
CALIB = Path(__file__).resolve().parent.parent / "data" / "calibration" / "windows.npy"

# Override with --device after checking `qai-hub list-devices` — labels drift.
TARGETS = {
    "xelite": {
        "device": "Snapdragon X Elite CRD",
        "runtime_flag": "--target_runtime qnn_context_binary",
        "artifact": "classifier_xelite.bin",
    },
    "phone": {
        "device": "Snapdragon 8 Elite QRD",
        "runtime_flag": "--target_runtime tflite",
        "artifact": "classifier_v81.tflite",
    },
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=TARGETS, help="deployment target")
    ap.add_argument("--model", type=Path, default=MODELS / "classifier.onnx")
    ap.add_argument("--device", help="exact AI Hub device label override")
    ap.add_argument("--skip-quantize", action="store_true",
                    help="model is already INT8")
    ap.add_argument("--list-devices", action="store_true")
    args = ap.parse_args()

    import qai_hub as hub  # deferred so --help works without the SDK

    if args.list_devices:
        for d in hub.get_devices():
            print(f"  {d.name}  ({', '.join(d.attributes)})")
        return 0
    if not args.target:
        ap.error("--target is required (or use --list-devices)")
    if not args.model.exists():
        print(f"missing {args.model} — run tools/train.py first", file=sys.stderr)
        return 1

    cfg = TARGETS[args.target]
    device = hub.Device(args.device or cfg["device"])
    model_path = args.model

    # ---- 1. INT8 quantization with REAL calibration windows -----------------
    # Calibrating on random noise silently destroys accuracy; windows.npy is
    # sampled from the training distribution by tools/train.py.
    if not args.skip_quantize:
        if not CALIB.exists():
            print(f"missing {CALIB} — run tools/train.py first", file=sys.stderr)
            return 1
        calib = np.load(CALIB).astype(np.float32)
        print(f"quantize: {model_path.name} with {len(calib)} calibration windows")
        qjob = hub.submit_quantize_job(
            model=str(model_path),
            calibration_data={"window": [w[np.newaxis] for w in calib]},
            weights_dtype=hub.QuantizeDtype.INT8,
            activations_dtype=hub.QuantizeDtype.INT8,
        )
        quantized = qjob.get_target_model()
        assert quantized is not None, f"quantize failed: {qjob.url}"
        print(f"quantized ok: {qjob.url}")
    else:
        quantized = str(model_path)

    # ---- 2. Compile for the target runtime ----------------------------------
    print(f"compile: target={args.target} device='{device.name}'")
    cjob = hub.submit_compile_job(
        model=quantized, device=device, options=cfg["runtime_flag"],
        input_specs={"window": (1, 6, 128)},
    )
    compiled = cjob.get_target_model()
    assert compiled is not None, f"compile failed: {cjob.url}"
    print(f"compiled ok: {cjob.url}")
    print(">>> OPEN THE JOB URL AND READ THE OP-COVERAGE OUTPUT (want >=80% on NPU)")

    # ---- 3. Profile on real hardware -> numbers for BENCHMARKS.md -----------
    pjob = hub.submit_profile_job(model=compiled, device=device)
    profile = pjob.download_profile()
    stats = profile.get("execution_summary", {})
    print("profile:", pjob.url)
    for key in ("estimated_inference_time", "first_load_time",
                "inference_memory_peak_range"):
        if key in stats:
            print(f"  {key}: {stats[key]}")

    # ---- 4. Download the deployable artifact --------------------------------
    MODELS.mkdir(exist_ok=True)
    out = MODELS / cfg["artifact"]
    compiled.download(str(out))
    print(f"artifact -> {out}  (commit this)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
