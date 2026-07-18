# RoadSense Architecture

Five compute domains across four devices. No single device can do this job:
the timing needs an MCU, the fleet fusion needs a cloud, and the driver needs
a phone. This document describes what is **implemented today**, file by file.

## The 5 hops

```
┌──────────────────── ARDUINO UNO Q (one board, TWO brains) ────────────────┐
│ [HOP 1] STM32U585 MCU · Zephyr · unoq/sketch/sketch.ino                   │
│   IMU @ deterministic 100 Hz · 2 s ring buffer (200×6)                    │
│   trigger |az−1g| > 0.35 g, 1.5 s cooldown                                │
│   → 128-sample window centred on the peak (64 pre + 64 post)              │
│         ↓ Bridge RPC (the Bridge owns the serial link — never Serial1)    │
│ [HOP 2] QRB2210 MPU · Debian · unoq/python/main.py                        │
│   gate: INT8 model on Hexagon DSP v66 (models/gate_int8.dlc via SNPE)     │
│   fallback: deterministic variance+peak rule when the .dlc is absent      │
│   rejected windows never leave the board (privacy + bandwidth)            │
│         ↓ Wi-Fi WebSocket → ws://<x-elite>:8100/ws/ingest                 │
├─────────────────────── SNAPDRAGON X ELITE PC ─────────────────────────────┤
│ [HOP 3] pc/server.py + pc/detector.py + pc/features.py                    │
│   detector strategies (availability-selected at startup, Strategy pattern):│
│     1. OnnxDetector(QNN EP)  — Hexagon NPU v73, INT8                      │
│     2. OnnxDetector(CPU EP)  — dev machines                               │
│     3. RuleBasedDetector     — deterministic physics rules, always works  │
│   4 classes: smooth · pothole · speed_breaker · rough_patch               │
│   severity: speed-normalised 0–10, vehicle-calibrated                     │
│   EDGE-FIRST: event → local SQLite mirror FIRST, then cloud; offline      │
│   events queue and flush on reconnect (pc/server.py:_flush_loop)          │
│   hosts the hop-visualizer dashboard (pc/dashboard/index.html)            │
│         ↓ HTTPS POST /api/v1/events (~40-byte events, batched)            │
├────────────────────────────── CLOUD ──────────────────────────────────────┤
│ [HOP 4] cloud/app.py (routes) · cloud/hazards.py · cloud/rewards.py       │
│   H3 res-12 (~9 m cells) · ≥3 distinct devices → CONFIRMED                │
│   5 consecutive clean passes → RESOLVED (new report resets the counter)   │
│   coin ledger + missions (see below) · hotspot priority ranking           │
│         ↓ REST /api/v1/*                                                  │
├──────────────────────────── ONEPLUS 15 ───────────────────────────────────┤
│ [HOP 5] mobile/ (React Native + MapLibre) — IN PROGRESS                   │
│   driver map · fastest-vs-smoothest · coins/missions · votes · voice      │
│   stretch: same classifier on Hexagon NPU v81 via LiteRT                  │
└───────────────────────────────────────────────────────────────────────────┘
```

## Why each hop is necessary

- **MCU** — only chip with deterministic 100 Hz timing; Linux can't guarantee it.
- **MPU/DSP** — kills ~70% of noise at the source; raw signal never leaves the
  vehicle (privacy) and junk never burns Wi-Fi/battery. 1 TOPS forces the
  two-model split: the gate must be tiny.
- **X Elite** — 45 TOPS affords the real 4-class model + severity regression.
- **Cloud** — cross-vehicle fusion is impossible on any single device by definition.
- **Phone** — the only device with the driver.

## Design principles

### Strategy pattern everywhere inference happens
`pc/detector.py` defines `Detector.predict(window, speed, vehicle) -> Detection`.
Backends (QNN NPU / CPU ONNX / rule-based) are chosen **once at startup by
availability** (`get_detector()`); downstream code never branches on backend.
The UNO Q gate has the same shape: DSP model if the `.dlc` exists, rule
otherwise (`unoq/python/main.py:gate`). Future backends (LiteRT on the phone,
Edge Impulse `.eim` on the UNO Q) slot into the same interfaces.

### Edge-first / offline-first
The X Elite writes every event to its **local SQLite mirror before** trying
the cloud — same schema, same fusion code (`cloud/db.py`, `cloud/hazards.py`
run on both). Cloud-unreachable events queue in memory and a 5 s background
loop flushes them on reconnect. `GET /api/v1/hazards` on the PC serves the
mirror so the phone keeps working with zero internet.

### Idempotency end to end
Events are unique on `(device_id, seq)` — replaying an offline batch is a
no-op. Coin awards are unique on `(user, reason, ref)` — sync retries can
never double-pay. Mission bonuses pay exactly once (completion timestamp).

### Handlers orchestrate, modules decide
FastAPI route handlers in `cloud/app.py` and `pc/server.py` contain no
business logic — it all lives in `cloud/hazards.py`, `cloud/rewards.py`,
`pc/features.py`, `pc/detector.py`, each unit-tested without a server.

## Fusion rules (cloud/hazards.py)

| Rule | Value | Where |
|---|---|---|
| H3 resolution | 12 (~9 m cells) | `H3_RESOLUTION` |
| Confirmation | ≥3 **distinct** devices report same cell+class | `CONFIRM_DEVICES` |
| Auto-clear | 5 consecutive clean passes over a CONFIRMED cell | `AUTOCLEAR_PASSES` |
| Counter reset | any new report zeroes `clean_passes` | `_report_hazard` |
| Hotspot priority | mean severity × log1p(reports) × (1 + age_days/14) | `hotspots()` |

## Detection physics (pc/features.py, pc/detector.py)

- Window: 128 samples × 6 channels @ 100 Hz, gravity-aligned first
  (`gravity_align` rotates axes from the mean gravity vector, so mounting
  orientation doesn't matter — unit-tested with a 90° rotated pothole).
- FFT bands use **mean energy per bin** (a raw sum lets the widest band win
  on bin count alone).
- Rules: low-band-dominant hump with no sharp dip → speed breaker; high
  crest factor (localized transient) → pothole; sustained variance → rough
  patch.
- Severity: `peak / (v/30 km/h)^1.5`, clipped to 0–10, × vehicle factor
  (2-wheeler 0.7, hatchback 1.0, SUV 1.3). Same bump at higher speed scores
  lower — otherwise every highway looks broken.

## Coin economy (cloud/rewards.py)

Append-only ledger; balance = SUM(ledger). Awards: 10 for first-ever mapping
of an H3 cell, 5 to every distinct reporter on confirmation, 2 for a manual
vote matching the outcome, 15–200 mission bonuses (`MISSIONS` config).
This is the incentive loop that solves crowd-mapping's cold-start problem.

## API surface (`/api/v1/`, Swagger at `/docs`)

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/devices` | register device → user + vehicle type |
| `POST /api/v1/events` | batch ingest of classified events (idempotent) |
| `GET  /api/v1/hazards` | map pins (PENDING/CONFIRMED, `?include_resolved`) |
| `POST /api/v1/hazards/{id}/vote` | Waze-style confirm/deny |
| `GET  /api/v1/rewards/{user}` | coin balance + ledger history |
| `GET  /api/v1/missions/{user}` | mission progress |
| `GET  /api/v1/authority/hotspots` | ranked repair-priority list |

Errors use a consistent envelope: `{"error": {"code", "message"}}`.

## Model pipeline (tools/)

1. `train.py` — PyTorch 1D-CNN (boring ops only: Conv1D/BN/ReLU/Dense —
   full Hexagon op coverage; LSTM/attention risk silent CPU fallback).
   Gate ~10k params, classifier ~60k (4-class + severity heads). Exports
   static-shape ONNX opset 17 + 100 real-distribution calibration windows.
2. `export_aihub.py` — Qualcomm AI Hub: INT8 quantize (real calibration
   data — random-noise calibration silently destroys accuracy) → compile
   (QNN context binary for X Elite / tflite for 8 Elite) → profile on real
   hardware → download artifact into `models/`. **Read the op-coverage
   output; ≥80% on NPU or restructure.**
3. `verify_npu.py` — proves NPU residency via `get_ep_devices()` (the QNN
   EP does *not* appear in `get_available_providers()` in 2.x even when
   working). Screenshot the `True`.
4. `benchmark.py` — warmup 3 / measure 50, mean+p50/p95/p99, NPU **and**
   CPU baseline → BENCHMARKS.md.

## Testing

17 deterministic tests, no server or hardware needed:
- `cloud/tests/test_fusion.py` — ingest idempotency, new-cell coin,
  3-device confirmation payout, solo-device cannot confirm, auto-clear,
  counter reset, ledger idempotency, one-time mission bonus, voting.
- `pc/tests/test_detector.py` — per-class detection on synthetic physics
  windows, speed normalization, vehicle factors, rotated-mount invariance,
  input validation.

## Status

| Component | State |
|---|---|
| Cloud fusion + rewards + missions + hotspots | ✅ built, tested |
| PC hop: strategies, ingest, offline mirror, dashboard | ✅ built, tested (rule/CPU paths) |
| UNO Q sketch + MPU gate | ✅ written — verify Bridge API against Blink on-site |
| tools: train / AI Hub / verify / bench / fleet / reset | ✅ written — AI Hub runs need account + queue time |
| models/ artifacts | ⬜ pending `train.py` + `export_aihub.py` runs |
| mobile/ driver app | ⬜ in progress |
| BENCHMARKS.md numbers | ⬜ filled on real hardware |
