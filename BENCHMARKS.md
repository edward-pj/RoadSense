# Benchmarks

Measured with `tools/benchmark.py` (warmup 3, measure 50) and Qualcomm AI Hub
profile jobs (`tools/export_aihub.py`). **Always include the CPU baseline:**
"23 ms on NPU" is a number; "23 ms vs 140 ms CPU, 6.1×, at lower power" is an
argument.

## AI Hub hosted-hardware profiles (measured 2026-07-19)

INT8 models, real drive-data calibration (100 windows), profiled by Qualcomm
AI Hub on real hosted devices. Single AI Hub latency estimate per job
(min-latency methodology), not a local percentile distribution.

| Model | Artifact | Device | Chip | Inference | First load | Peak inference mem | Job |
|---|---|---|---|---|---|---|---|
| Gate | `models/gate_xelite.bin` | Snapdragon X Elite CRD | Hexagon NPU v73 | **0.146 ms** | 390 ms | 544 KB | [jgjwyxze5](https://workbench.aihub.qualcomm.com/jobs/jgjwyxze5/) |
| Classifier | `models/classifier_xelite.bin` | Snapdragon X Elite CRD | Hexagon NPU v73 | **0.139 ms** | 331 ms | 8 KB | [jpelx9evg](https://workbench.aihub.qualcomm.com/jobs/jpelx9evg/) |
| Classifier | `models/classifier_v81.tflite` | Snapdragon 8 Elite Gen 5 QRD | Hexagon NPU v81 | **0.044 ms** | 156 ms | ≤18 MB | [j5w1zo2mg](https://workbench.aihub.qualcomm.com/jobs/j5w1zo2mg/) |

At this model size (10k–60k params) NPU latency is dispatch-bound, not
compute-bound — both X Elite models profile ≈0.14 ms regardless of parameter
count. All are ~700× under the 100 ms frame budget at 10 Hz.

## Inference latency (local, tools/benchmark.py — warmup 3, measure 50)

| Model | Device | Chip | Backend | mean | p50 | p95 | p99 | Speedup vs CPU |
|---|---|---|---|---|---|---|---|---|
| Gate | UNO Q MPU | Hexagon DSP v66 | SNPE (INT8) | _ ms | _ | _ | _ | _× |
| Gate | UNO Q MPU | Cortex-A53 | CPU (FP32) | _ ms | _ | _ | _ | 1× |
| Classifier | X Elite | Hexagon NPU v73 | QNN (INT8) | _ ms | _ | _ | _ | _× |
| Classifier | X Elite | X Elite CPU | CPU (FP32) | _ ms | _ | _ | _ | 1× |
| Classifier | OnePlus 15 | Hexagon NPU v81 | LiteRT (INT8) | _ ms | _ | _ | _ | _× |

## End-to-end (glass to glass)

Jolt on the sensor → pin on the phone map. This is the number a judge feels.
The hop-visualizer dashboard (`http://<x-elite>:8100/`) displays it live.

| Path | Latency |
|---|---|
| MCU trigger → MPU gate verdict | _ ms |
| MPU → X Elite classification | _ ms |
| X Elite → cloud fused | _ ms |
| Full chain: jolt → phone pin | _ ms |

## NPU residency proof

`tools/verify_npu.py` output on the X Elite (screenshot in demo slides):

```
(paste output — must end with "NPU device found: True")
```

Verified via `ort.get_ep_devices()` — a model can load "successfully" and
silently run on CPU; the QNN EP does not appear in
`get_available_providers()` in onnxruntime-qnn 2.x even when working.

## Model accuracy (held-out set, different vehicle/day than training)

| | smooth | pothole | speed_breaker | rough_patch |
|---|---|---|---|---|
| **smooth** | _ | _ | _ | _ |
| **pothole** | _ | _ | _ | _ |
| **speed_breaker** | _ | _ | _ | _ |
| **rough_patch** | _ | _ | _ | _ |

## Power profile choices (deliberate, defensible)

- **UNO Q gate — power_saver**: always-on background sensing on a
  battery-powered node; burst would be free performance we don't need and
  power we can't spare.
- **X Elite classifier — balanced**: event-driven burst workload.
