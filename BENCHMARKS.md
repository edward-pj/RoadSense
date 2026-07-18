# Benchmarks

Measured with `tools/benchmark.py` (warmup 3, measure 50) and Qualcomm AI Hub
profile jobs (`tools/export_aihub.py`). **Always include the CPU baseline:**
"23 ms on NPU" is a number; "23 ms vs 140 ms CPU, 6.1×, at lower power" is an
argument.

## Inference latency

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
