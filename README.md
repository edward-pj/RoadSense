# RoadSense

**Edge-first road quality mapping across 5 Snapdragon compute domains.**

Vehicles carry an IMU sensor on an Arduino UNO Q. Road events — potholes,
speed breakers, rough patches — are detected on-device (MCU trigger → INT8
gate model on the Hexagon DSP → INT8 classifier on the Snapdragon X Elite
NPU), fused across the fleet in the cloud (H3 clustering, ≥3-device crowd
verification, auto-clear), and served back to drivers as a live road-quality
map with smoothest-route navigation, voice alerts, and a **coin-based
incentive system** that pays drivers for mapping unmapped roads. Government
dashboards get a ranked, self-maintaining repair-priority list.

Built for the **Snapdragon Multiverse Hackathon** (Qualcomm Noida, July
18–19 2026). Think Google Maps (navigation) + Waze (crowd verification) +
Sweatcoin (driver incentives), running majority-on-edge.

## Team

<!-- HARD ELIGIBILITY RULE: fill in every member's name + email before submission -->
| Name | Email |
|---|---|
| _fill in_ | _fill in_ |

## The 5-hop pipeline

```
UNO Q MCU (STM32U585, Zephyr)     100 Hz IMU, ring buffer, peak trigger
        ↓ Bridge RPC
UNO Q MPU (QRB2210, Hexagon DSP v66)   INT8 gate model kills ~70% of noise
        ↓ Wi-Fi WebSocket
X Elite PC (Hexagon NPU v73)      INT8 4-class classifier + severity (QNN EP)
        ↓ HTTPS (~40-byte events)
Cloud (FastAPI)                   H3 fusion · verification · rewards · hotspots
        ↓ REST
OnePlus 15 (Hexagon NPU v81)      driver map · routes · coins · voice alerts
```

Full design: [ARCHITECTURE.md](ARCHITECTURE.md). Measured latency: [BENCHMARKS.md](BENCHMARKS.md).

## Repository layout

```
cloud/    FastAPI fusion service: H3 res-12 clustering, ≥3-device verification,
          5-pass auto-clear, append-only coin ledger, missions, hotspots
pc/       X Elite hop: detector strategies (QNN NPU → CPU ONNX → rule-based),
          WebSocket ingest, offline-first local mirror
unoq/     App Lab app: sketch/ (MCU, 100 Hz sampling + trigger) and
          python/ (MPU, gate model + Wi-Fi forwarder) — exact names required
models/   compiled INT8 artifacts (committed after AI Hub export)
data/     training CSV, INT8 calibration windows, simulated fleet
tools/    train, AI Hub export, NPU verification, benchmarks, fleet seeding,
          demo reset
```

## Setup from scratch

Requires Python 3.12+.

```bash
git clone <this-repo> && cd roadsense
python3 -m venv .venv && source .venv/bin/activate
pip install -r cloud/requirements.txt -r pc/requirements.txt
```

### Secrets (`.env`)

The driver app's voice alerts and UI-string translation use **Sarvam AI**. Put
the key in a repo-root `.env` (git-ignored; loaded via `python-dotenv`):

```
SARVAM_API_KEY=sk_...
```

It stays **server-side** — the static mobile page reaches Sarvam only through
the backend proxies `POST /api/v1/tts` and `POST /api/v1/translate`. Without a
key, the app still works: UI text uses the committed pre-baked translations and
the voice alert falls back to the browser's on-device speech.

Re-generate the pre-baked UI translations after editing English copy:
```bash
python tools/translate_ui.py       # Sarvam Translate -> mobile/i18n/app.<lang>.json
```

### 1. Run the cloud fusion service

```bash
uvicorn cloud.app:app --host 0.0.0.0 --port 8000
# Swagger docs: http://localhost:8000/docs
```

### 2. Seed the simulated fleet (clearly labeled simulated — device ids `sim-*`)

```bash
python tools/simulate_fleet.py --cloud http://localhost:8000 --resolve-demo
```

### 3. Run the X Elite hop

```bash
ROADSENSE_CLOUD=http://localhost:8000 uvicorn pc.server:app --port 8100
```

On the actual Snapdragon X Elite, additionally:
```bash
pip install onnxruntime-qnn        # native ARM64 Python, not emulated x86
python tools/verify_npu.py         # must print "NPU device found: True"
```

### 4. Access the Frontends & Dashboards

With the servers running, the three frontends are served statically:

* **Telemetry Data Dashboard (PC Hop 3)**: Open **`http://localhost:8100/`**
  * Visualizes the live 5-hop Snapdragon execution pipeline and real-time IMU waveforms.
* **Driver Phone App Simulator (Phone Hop 5)**: Open **`http://localhost:8100/mobile/`**
  * Shows driver navigation (Fastest vs. Smoothest routes), coin/incentive ledger, and plays English/Hindi TTS voice alerts for approaching road hazards.
* **Municipal Authority Dashboard (Cloud Hop 4)**: Open **`http://localhost:8000/`**
  * Displays H3 resolution-12 spatial hotspots, repair backlog prioritization, and fleet statistics.

### 5. Run the UNO Q app

Open `unoq/` in Arduino App Lab and run — the runtime picks up `app.yaml`,
`sketch/sketch.ino` (MCU) and `python/main.py` (MPU). Set
`ROADSENSE_PC_WS=ws://<x-elite-ip>:8100/ws/ingest`.

### 6. Train + export models (pre-event; AI Hub jobs queue on shared hardware)

```bash
pip install torch qai-hub
python tools/train.py --synthetic          # or --data data/roadsense_v1.csv
qai-hub configure --api_token <token>      # from app.aihub.qualcomm.com
python tools/export_aihub.py --target xelite   # INT8 quantize → compile → profile
python tools/export_aihub.py --target phone
```

### Tests

```bash
python -m pytest cloud/tests/ pc/tests/    # 17 tests: fusion, rewards, detectors
```

### Demo reset (between judges)

```bash
python tools/demo_reset.py                 # wipe state + reseed fleet
```

## Coin economy

| Action | Coins |
|---|---|
| First vehicle ever to map an H3 cell | 10 |
| Each reporter when a hazard is crowd-confirmed (≥3 devices) | 5 |
| Manual vote matching the confirmed outcome | 2 |
| Mission bonuses (map 5 / map 25 cells, confirm 3 hazards, first report) | 15–200 |

Awards are an append-only ledger with idempotency keys — offline-sync
replays can never double-pay. Balances are derived, never mutated.

## Notes

- The simulated fleet (`tools/simulate_fleet.py`) is synthetic and labeled
  as such; live rig events merge with it under real device ids.
- The driver loop is edge-first: the X Elite keeps a local SQLite mirror and
  queues events while the cloud is unreachable, flushing on reconnect.
- All inference is INT8 (the Hexagon DSP v66 cannot run FP32 at all).

## License

[MIT](LICENSE). All dependencies are open source (FastAPI, uvicorn, h3,
NumPy, httpx, pydantic, ONNX Runtime, MapLibre, pytest).
