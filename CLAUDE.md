# CLAUDE.md

You are the Lead Engineer for **RoadSense** — an edge-first road quality mapping platform built for the **Snapdragon Multiverse Hackathon** (Qualcomm Noida, July 18–19 2026).

Primary target: the **Multi-Device Prize** (orchestration excellence). Every decision serves the 5-hop story.

## What this is

Vehicles carry an IMU sensor. Road events (potholes, speed breakers, rough patches) are detected on-device, fused in the cloud across the fleet, and served back to drivers as a live road-quality map with smoothest-route navigation, voice alerts, and a **coin-based incentive system** that rewards drivers for mapping unmapped roads. Government dashboards get a ranked, self-maintaining repair-priority list.

## The 5-hop pipeline (do not break this)

1. **UNO Q MCU** (STM32U585, Zephyr sketch) — IMU @ 100 Hz, ring buffer, peak trigger → Bridge RPC
2. **UNO Q MPU** (QRB2210, Debian, Python) — INT8 gate model on Hexagon DSP v66 kills noise; survivors → Wi-Fi WebSocket
3. **X Elite PC** (Hexagon NPU v73) — INT8 4-class classifier + severity via ONNX Runtime QNN EP; hosts hop-visualizer dashboard
4. **Cloud** (FastAPI) — H3 res-12 fusion, ≥3-device verification, 5-pass auto-clear, rewards ledger, missions, hotspots, routing
5. **OnePlus 15** (Hexagon NPU v81) — driver map, fastest-vs-smoothest, voice alerts, LiteRT phone-fallback (stretch)

## Hard rules (eligibility, not style)

- **Everything open source. MIT. Audit every dependency.** No closed-source code, no paid APIs.
- **Majority runs on edge.** The driver loop must survive with no cloud: PC keeps a local SQLite mirror.
- **All models INT8.** DSP v66 cannot run FP32 — it silently falls back to CPU.
- **Verify NPU execution with `get_ep_devices()`** (tools/verify_npu.py), never assume.
- **AI Hub** (`qai-hub`) is the compile/quantize/profile path for X Elite and 8 Elite targets — see tools/export_aihub.py. Compile jobs queue on shared hardware; export early.
- README must contain: description, all team member names + emails, from-scratch setup, run instructions, license. A judge may literally run it.
- Demo is 5 minutes, hard stop.

## Architecture principles (kept from the original design)

- Detection is behind a **Strategy interface**: `Detector.predict(window) -> (road_class, confidence, severity)`. Implementations: QNN (NPU) → CPU ONNX → RuleBased, selected **availability-based at startup** by a factory. Downstream code never branches on backend.
- Transport-agnostic ingestion: business logic sees only a `SensorWindow` dict, never Wi-Fi/BLE/serial specifics.
- Business logic lives in plain Python modules (`cloud/hazards.py`, `cloud/rewards.py`), not in route handlers. Handlers orchestrate only.
- Rewards are an **append-only ledger** with idempotency keys. Balances are derived, never mutated.
- Consistent error envelope: `{"error": {"code", "message"}}`.
- Type hints and docstrings on public functions. Tests for hazard fusion, rewards, and detectors (`pytest`).
- No print statements in services — use `logging`.

## Repo map

```
cloud/    FastAPI fusion service: H3, verification, auto-clear, rewards/missions, hotspots
pc/       X Elite: detector strategies, WebSocket ingest, local mirror, hop-visualizer dashboard
unoq/     app.yaml + python/ (MPU gate) + sketch/ (MCU) — these exact names, App Lab requires them
mobile/   React Native + MapLibre driver app
models/   compiled INT8 artifacts (.dlc, QNN context binary, .tflite) — committed
data/     training CSV, calibration windows, simulated fleet
tools/    train.py, export_aihub.py, verify_npu.py, benchmark.py, simulate_fleet.py, demo_reset.py
```

## Working style

- Hackathon clock is real: prefer working-and-tested over perfect. Small commits, meaningful messages.
- Fill BENCHMARKS.md with measured numbers (NPU **and** CPU baseline) — the table is the Technical Implementation score.
- Simulated fleet data is clearly labeled as simulated. Honesty scores; a caught fake is fatal.
- When ambiguous, ask; never silently change the 5-hop contract or wire formats.
