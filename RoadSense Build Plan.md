# RoadSense — Detailed Build Plan
### Snapdragon Multiverse Hackathon, Qualcomm Noida | July 18–19, 2026
### Primary target: **Multi-Device Prize** (100 pts, Orchestration Excellence). Secondary: Top Award.

---

## 0. The Hard Constraints (memorise these)

| Fact | Implication |
|---|---|
| Devices handed out **9:00 AM Sat**, hack starts **1:00 PM Sat** | You get **4 free hours** of setup time that don't count against the 24h. Use them fully. |
| Submission deadline **1:00 PM Sun** | Real build window = 24h exactly. Demos 1–4 PM. |
| Demo = **5 minutes, timed, hard stop** | Script and rehearse it. You cannot explain 5 hops in 5 min unless rehearsed. |
| **No closed-source code at all** | Audit every dependency. No paid third-party APIs. |
| README + open-source license + runnable-from-scratch | Eligibility gate, not a bonus. Write it *first*, not last. |
| **Majority must run on edge** | Cloud = fusion + report text only. Driver loop must work cloud-free. |
| "Commercially ready… deployable on app store" | The APK must look like a real product. |
| Each team wins **only one prize** | Don't split focus. Build for Multi-Device. |

### Hardware you will be given
- **AI PC:** Surface Laptop 7 13", Snapdragon X Elite, 32GB RAM, 512GB SSD → Hexagon NPU **v73, 45 TOPS, INT8**
- **Mobile:** OnePlus 15, Snapdragon 8 Elite Gen 5 (SM8850) → Hexagon NPU **v81**
- **Arduino UNO Q:** dual-brain — **QRB2210 MPU** (quad A53, Debian Linux, Hexagon **DSP v66, 1.0 TOPS, INT8 ONLY**) + **STM32U585 MCU** (Cortex-M33, Zephyr, runs sketches). Wi-Fi 5, BT 5.1, Qwiic connector, UNO headers.
- **Cloud:** Qualcomm AI Inference Suite / Cloud AI 100

> ⚠️ **UNO Q will not boot without a USB-C Power Delivery source.** Bring a PD charger + PD-capable dongle. This is the single dumbest way to lose 2 hours.

---

## 1. Final Architecture — 5 Orchestration Hops

Most teams will use 3 devices. You are using **5 compute domains across 4 devices**, because the UNO Q is two computers in one. This is the entire basis of your Multi-Device Prize claim.

```
┌──────────────────── ARDUINO UNO Q (one board, TWO brains) ────────────────────┐
│                                                                               │
│  [HOP 1]  STM32U585 MCU  ·  Zephyr  ·  C++ sketch                             │
│           • Reads IMU (I²C) at 100 Hz — hard real-time, deterministic         │
│           • Reads GPS (UART, NMEA) at 1 Hz                                    │
│           • 2s ring buffer (200×6 floats)                                     │
│           • Simple peak-detector trigger: |a_z − 1g| > threshold              │
│           • On trigger → Bridge.call("submit_window", window)                 │
│                          ↓ Bridge / RPC (msgpack over internal serial)        │
│  [HOP 2]  QRB2210 MPU  ·  Debian Linux  ·  Python  ·  Hexagon DSP v66         │
│           • GATE MODEL (INT8 .dlc, ~10k params) via SNPE/QAIRT on DSP         │
│           • Binary: "real road event" vs "noise/handling/door slam"           │
│           • Kills ~70% of triggers here. Raw signal NEVER leaves the board.   │
│           • Survivors → WebSocket (Wi-Fi) with window + GPS + speed           │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                ↓ Wi-Fi (WebSocket, local network)
┌───────────────────────────────┴───────────────────────────────────────────────┐
│  [HOP 3]  SNAPDRAGON X ELITE PC  ·  Hexagon NPU v73  ·  Python                │
│           • CLASSIFIER (INT8 ONNX/QNN, ~60k params, 1D-CNN)                   │
│             4 classes: smooth · pothole · speed_breaker · rough_patch         │
│           • Severity regression head → speed-normalised score 0–10            │
│           • Vehicle-type calibration applied                                  │
│           • Emits ~40-byte event: {lat,lng,class,severity,speed,vtype,ts}     │
│           • THIS IS THE "BRAIN" — also hosts the local demo dashboard         │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                ↓ HTTPS (only clean events, ~40 bytes each)
┌───────────────────────────────┴───────────────────────────────────────────────┐
│  [HOP 4]  QUALCOMM CLOUD AI 100 / AI Inference Suite                          │
│           • H3 spatial clustering (res 12 ≈ 9m cells) of all fleet events     │
│           • Verification: ≥3 independent devices → hazard CONFIRMED           │
│           • Auto-clear: 5 consecutive clean passes → hazard RESOLVED          │
│           • LLM → plain-language repair brief per hotspot (this is the        │
│             genuine "AI" justification for Cloud AI 100, not just a DB)       │
│           • Smoothest-route graph: edge weight = time + λ·hazard_cost         │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                ↓ REST / WebSocket
┌───────────────────────────────┴───────────────────────────────────────────────┐
│  [HOP 5]  ONEPLUS 15  ·  Snapdragon 8 Elite  ·  Hexagon NPU v81               │
│           • Driver map: green/amber/red road health                           │
│           • Fastest vs Smoothest toggle ("+3 min, avoids 4 potholes")         │
│           • Voice alert (Hindi/English) — "Aage gaddha hai, dheere chaliye"   │
│           • PHONE-ONLY FALLBACK MODE: phone's own accel+GPS as sensor,        │
│             same classifier running on v81 NPU via LiteRT  ← [STRETCH]        │
│           • Authority Hazard Hotspot dashboard                                │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Why each hop is *necessary* (the answer you give the judge)
- MCU: only chip with deterministic 100 Hz timing. Linux can't guarantee it.
- MPU: kills noise at the source so you don't burn Wi-Fi/battery shipping junk. Runs on a 1 TOPS DSP — it *must* be tiny; that's the design constraint driving the two-model split.
- X Elite: 45 TOPS lets you afford the real 4-class model + severity. Too heavy for the DSP.
- Cloud: cross-vehicle fusion is impossible on any single device by definition — you need many cars.
- Phone: the only device with the driver.

**Say this line in the demo:** *"No single device in this room can do this. The timing needs an MCU, the fleet fusion needs a cloud, and the driver needs a phone. That's not four devices for the sake of it — that's the minimum."*

---

## 2. The Model (design it now, train it before the event)

### Input
- Window: **128 samples × 6 channels** (accel xyz + gyro xyz) @ 100 Hz = 1.28 s
- Centred on the trigger peak (64 samples before, 64 after)
- Normalised: subtract gravity on z, scale by per-axis std from training set
- Speed passed **separately as a scalar** (not into the CNN) — used for severity normalisation

### Two models, three deployments

| Model | Runs on | Chip | Size | Job |
|---|---|---|---|---|
| **Gate** | UNO Q MPU | Hexagon DSP v66 (1 TOPS) | ~10k params, INT8 `.dlc` | Binary: event / not-event |
| **Classifier** | X Elite PC | Hexagon NPU v73 (45 TOPS) | ~60k params, INT8 QNN | 4-class + severity |
| **Classifier** | OnePlus 15 | Hexagon NPU v81 | same, LiteRT `.tflite` | Fallback phone sensing [stretch] |

### Architecture (keep it boring — boring compiles cleanly to NPU)
```
Input (128×6)
 → Conv1D(16, k=7, s=2) → BatchNorm → ReLU
 → Conv1D(32, k=5, s=2) → BatchNorm → ReLU
 → Conv1D(64, k=3, s=2) → BatchNorm → ReLU
 → GlobalAvgPool
 → Dense(32) → ReLU
 → ├─ Dense(4)  → softmax   [class head]
   └─ Dense(1)  → sigmoid   [severity head, ×10]
```
**Avoid:** custom activations, dynamic shapes, LSTM/GRU, attention. Every one of those risks CPU fallback. Conv1D/BN/ReLU/Dense have full op coverage on all three Hexagon generations.

### Severity normalisation (have the formula ready — judges love a real equation)
```
severity_raw  = peak |a_z − 1g|  (in g)
severity_norm = severity_raw / (v / v_ref)^α        v_ref = 30 km/h, α ≈ 1.5
severity_final = clip(severity_norm × k_vehicle, 0, 10)
                 k_vehicle: 2-wheeler 0.7 | hatchback 1.0 | SUV 1.3
```
Rationale in one line: *the same pothole hits harder at higher speed, so severity must be speed-normalised or every highway looks broken and every parking lot looks perfect.*

---

## 3. PHASE 0 — Pre-Hackathon (Now → Fri July 17)
**Everything in this phase happens at home. This is where the hackathon is actually won.**

### 0.1 — Accounts & tokens (Day 1, 30 min)
- [ ] AI Hub account: `app.aihub.qualcomm.com` → Account → API Token
- [ ] `pip install qai-hub qai-hub-models` → `qai-hub configure --api_token <token>`
- [ ] `qai-hub list-devices | grep -i "X Elite"` and `| grep -i "8 Elite"` — **note the EXACT device label strings**, write them in the repo
- [ ] Qualcomm Discord: join `#snapdragon-multiverse-hack-noida`
- [ ] Mapbox free-tier token (or use OpenStreetMap + MapLibre — **fully open source, safer for the no-closed-source rule**)
- [ ] Decide license: **MIT** (simplest, zero friction)
- [ ] Attend the **pre-hackathon workshop / FAQ on July 13** — ask specifically: "what's the exact access path to Cloud AI 100 during the event?" and "is there a Modulino Movement / IMU in the kit or do we bring our own?"

### 0.2 — ⭐ COLLECT REAL TRAINING DATA (start Day 1 — this is the highest-value pre-work)
Most teams will try to collect data during the 24h and fail. You will arrive with a trained model.

**How:** write a tiny Android app (or use an off-the-shelf open-source logger like **SensorLogger / Physics Toolbox**, exported CSV) that records accel + gyro @ 100 Hz + GPS @ 1 Hz.

**Protocol:**
- Mount phone rigidly (suction mount or taped to the floor pan — *not* handheld, not in a pocket)
- Ride/drive around **Pilani and Delhi NCR**. Both are rich in ground truth. 🙂
- Have a passenger press a big button in the app to label events in real time, or shout the label into a voice memo synced by timestamp
- **Target: ≥300 labelled events** — ~80 potholes, ~80 speed breakers, ~80 rough patches, ~60 smooth/noise (incl. deliberate negatives: hard braking, door slam, phone bump, turning)
- Collect on **at least 2 vehicle types** (2-wheeler + car) — this is what makes your vehicle-calibration claim real, not theoretical
- Also record **10–100 clean windows for INT8 calibration** — the AI Hub guide is explicit that calibrating on random noise silently destroys accuracy. Use real windows matching your inference-time distribution.

**Deliverable:** `data/roadsense_v1.csv` + `data/calibration/` in the repo.

### 0.3 — Train + export both models (Days 2–4)
- [ ] Train in PyTorch on your Mac. Target ≥85% 4-class accuracy. Don't chase 99%.
- [ ] Export to ONNX (`torch.onnx.export`, opset 17, **static shapes**)
- [ ] **Quantize to INT8 with real calibration data** — mandatory for all three targets:
  - UNO Q DSP v66 **cannot run FP32 at all** — it silently falls back to CPU
- [ ] AI Hub export for X Elite:
  ```bash
  python -m qai_hub_models.models.<slug>.export \
    --target-runtime qnn \
    --device "<exact X Elite label>" \
    --calibration-data ./data/calibration/
  ```
  For a custom model, use the **"Bring Your Own Model"** notebook: `https://tinyurl.com/byom-aihub`
- [ ] **READ THE OP-COVERAGE OUTPUT.** ≥80% on NPU = good. <80% = restructure the model. Don't skip past this.
- [ ] Gate model → QAIRT/SNPE `.dlc` for DSP v66:
  ```bash
  qairt-converter --input_network gate.onnx --output_path gate_int8.dlc \
    --input_list calibration_windows.txt --quantization_overrides int8
  ```
- [ ] **Build-host warning:** if you ever touch a GenAI/LLM bundle, `torch` has **no Windows-ARM64 wheel** — you cannot export on the X Elite. Build in WSL/x86/macOS, copy the bundle to the X Elite to run. For your small classical models this mostly doesn't bite, but know it.
- [ ] **AI Hub compiles are queued against shared real hardware.** During the event, everyone hits it at once. **Do every export before July 17.** Arrive with artifacts in the repo.

**Deliverable:** `models/gate_int8.dlc`, `models/classifier_xelite.qnn`, `models/classifier_v81.tflite`, all committed.

### 0.4 — Cloud fusion service (Days 3–5)
Build and deploy it now; on-site you only re-point the URL.
- [ ] FastAPI service, endpoints:
  - `POST /events` (batch ingest)
  - `GET /hazards?bbox=` (confirmed hazards)
  - `GET /route?from=&to=&mode=smooth|fast`
  - `GET /authority/hotspots` (ranked repair list + LLM brief)
- [ ] H3 indexing (`pip install h3`), resolution 12 (~9 m cells)
- [ ] Verification rule: **≥3 distinct device IDs** in a cell within 14 days → `CONFIRMED`
- [ ] Auto-clear: **5 consecutive passes with no event** in a confirmed cell → `RESOLVED`
- [ ] Repair-priority score: `severity_avg × log(1 + vehicles_per_day) × age_factor`
- [ ] LLM repair brief via **Qualcomm AI Inference Suite** — prompt it to output a 2-sentence civic brief per hotspot
- [ ] **Everything must run cloud-free too** — the PC keeps a local SQLite copy so the driver loop survives Wi-Fi death. Build this fallback *now*, not at 4 AM.

### 0.5 — ⭐ Simulated fleet dataset (Day 5)
You have 1 rig. Your story is 1000 cars. Bridge that gap honestly with data.
- [ ] Generate a synthetic CSV: ~200 virtual vehicles × ~50 events each over a **real Noida road network** (grab OSM data for Sector 135 / Noida-Greater Noida Expressway — *the judges' own commute*)
- [ ] Seed ~30 realistic hazard clusters + noise + 3 "repaired" hazards that visibly auto-clear when you scrub the timeline
- [ ] Pre-load into the cloud service so the map is **alive** the second the demo starts
- [ ] Label it clearly as simulated in the README and say so out loud. **Honesty scores; a caught fake is fatal.**

### 0.6 — Mobile app skeleton (Days 4–6)
- [ ] React Native (your stack) + **MapLibre GL** (open source — avoids Mapbox licensing questions)
- [ ] Screens: Driver Map · Route Compare · Trip Summary · Authority Dashboard
- [ ] Wire to the cloud service with the pre-loaded simulated data → **the app should already look finished before you arrive**
- [ ] `react-native-sensors` for phone accel + `react-native-geolocation` for phone-fallback mode
- [ ] Voice alerts: Android native TTS is free and instant. Sarvam TTS for natural Hindi = stretch.
- [ ] **Design polish counts** ("commercially ready" is an explicit rule). Spend real Figma time. This is your skillset — use it.

### 0.7 — Repo + README (Day 6, non-negotiable)
```
roadsense/
├── README.md              ← full, finished, before you arrive
├── LICENSE                ← MIT
├── ARCHITECTURE.md        ← the 5-hop diagram
├── BENCHMARKS.md          ← table with blanks, filled on-site
├── unoq/
│   ├── app.yaml
│   ├── python/main.py + requirements.txt   ← MPU: gate model + WebSocket
│   └── sketch/sketch.ino + sketch.yaml     ← MCU: IMU/GPS + trigger
├── pc/                    ← X Elite: QNN classifier + local dashboard
├── cloud/                 ← FastAPI + H3 + LLM briefs
├── mobile/                ← React Native app
├── models/                ← all compiled artifacts, committed
├── data/                  ← training CSV + calibration + simulated fleet
└── tools/
    ├── train.py
    ├── export_aihub.py
    ├── verify_npu.py      ← the proof snippet
    └── benchmark.py
```
README must contain (this is a **hard eligibility rule**): app description · **names + emails of every team member** · setup from scratch incl. dependencies · run & usage instructions · license. Optional-but-recommended: tests, notes, references, commented code — do all four, they're free points under Presentation (15).

> ⚠️ **`app.yaml`, `python/`, `sketch/` — these exact names.** The UNO Q runtime looks for them literally. Get this wrong and nothing runs.

### 0.8 — 🔧 THE DEMO RIG (Day 6 — do not leave this to the venue)
GPS does not lock indoors. Plan for it now.

**Build a physical "road board":**
- A ~1.2 m plank or foam board
- A **speed breaker** = half-round dowel/cable-protector glued across
- A **pothole** = a rectangular hole cut out, ~2 cm deep
- A **rough patch** = coarse sandpaper / glued gravel strip
- A toy car / skateboard with the IMU rigidly taped on
- Roll it across → three visibly different, physically real signatures

This beats hand-shaking by a mile: judges *see* the pothole, then see the app say "pothole." That's the moment that wins the room and the popular vote.

**GPS indoors:** replay a pre-recorded NMEA track from a real Noida drive, synced to the rolls. Keep the live-GPS code path in the repo and *show* it: *"this reads the real module outdoors; we're replaying a real recorded drive because we're on floor 12."*

### 0.9 — Hardware to bring (pack Thursday night)
| Item | Why |
|---|---|
| **USB-C PD charger + PD dongle** | UNO Q will not boot without PD. Critical. |
| **IMU** — Modulino Movement (Qwiic, plug-and-play) **and** an MPU6050 backup | Kit may not include one. Qwiic = zero wiring. |
| **GPS** — NEO-6M / NEO-M8N (UART) | Won't lock indoors but must be in the demo for credibility |
| Breadboard, jumper wires (M-M, M-F), soldering-free Qwiic cables | |
| **Travel router or spare phone hotspot** | Venue Wi-Fi at a 100-team hackathon *will* be hostile. Your own 2.4/5 GHz island = insurance. |
| USB-C hub, USB-A↔C adapters, 2× long USB-C cables | Surface Laptop 7 has few ports |
| The demo road-board + toy car | |
| Power bank, extension board | |
| Pre-downloaded: all pip wheels, npm modules, model artifacts, OSM tiles | **Assume the internet dies.** |

---

## 4. PHASE 1 — On-Site Setup: Sat 9:00 AM → 1:00 PM (FREE TIME)
Devices are distributed at 9 AM; hacking officially starts at 1 PM. **This is 4 hours that don't cost you anything. Most teams will waste it.**

| Time | Action |
|---|---|
| 9:00 | Check-in. **Team Lead signs the Loaner Agreement immediately** — no signature, no device. |
| 9:15 | Power UNO Q via PD. First boot: firmware update, set username/password, **configure Wi-Fi (use YOUR hotspot, not venue Wi-Fi)**. This enables SSH. |
| 9:40 | Open Arduino App Lab → Examples → **Blink LED** → Run. This is the Hello World of the dual-brain Bridge: Python on MPU toggles, sketch on MCU drives the LED. **If Blink works, the Bridge works.** |
| 10:00 | Copy-and-edit Blink → `roadsense`. Confirm `python/main.py` and `sketch/sketch.ino` structure. Push a commit. |
| 10:15 | Wire the IMU (Qwiic → zero wiring, or I²C on UNO headers). Verify raw reads print in the App Lab Python console. |
| 10:40 | Surface Laptop 7: install Python (**native ARM64, not emulated x86**), `pip install onnxruntime-qnn`, run `tools/verify_npu.py`. **Confirm NPU is found before 11 AM.** |
| 11:00 | **Kickoff + Qualcomm DevRel Masterclass (11:00–11:30)** — attend, all of you. Ask about Cloud AI 100 access path. |
| 11:30 | **Sarvam: Edge & Hybrid Deployments (11:30–12:00)** — directly relevant. Ask about a lightweight Hindi TTS for the voice alert. |
| 12:00 | Lunch. Meanwhile: identify the mentors, tell one of them your architecture, get early feedback on whether the 5-hop story reads as impressive or as over-engineering. **Free judge-calibration.** |
| 12:45 | Final check: UNO Q boots, Bridge works, IMU reads, PC NPU verified, cloud service reachable, app renders simulated data. |

**By 1:00 PM you should already have every device alive and your app looking finished.** The other teams will be unboxing.

---

## 5. PHASE 2 — Hours 0–6 (Sat 1 PM → 7 PM): The Ugly End-to-End Chain
**Goal: one jolt travels all 5 hops. Ugly is fine. Stubs are fine. The chain must exist by dinner.**

- [ ] **MCU sketch:** IMU @ 100 Hz into a 200×6 ring buffer. Peak trigger on `|a_z − 1g| > 0.35g`. On trigger, `Bridge.call("submit_window", ...)`.
  - ⚠️ The Router **exclusively owns** the serial link between the chips. Never touch `Serial1` directly or the Bridge dies.
- [ ] **MPU python:** `Bridge.provide` receives window → **stub gate (always pass)** → WebSocket POST to PC.
- [ ] **PC:** receives window → **stub classifier (random class)** → POST event to cloud.
- [ ] **Cloud:** ingest → H3 cell → store → expose `/hazards`.
- [ ] **Phone:** new pin appears on the map within ~2 s of the jolt.
- [ ] **Milestone (7 PM): tap the sensor → a pin appears on the phone.** Video it. That video is your insurance if something breaks Sunday.

**If you are not here by 7 PM, cut scope immediately** — drop the phone-fallback stretch, drop the LLM briefs.

---

## 6. PHASE 3 — Hours 6–14 (Sat 7 PM → Sun 3 AM): Real Models on Real NPUs
**Goal: replace every stub with a real INT8 model on a real Hexagon, and prove it.**

- [ ] Deploy `gate_int8.dlc` to the UNO Q MPU. Run on the **DSP**:
  ```bash
  snpe-net-run --container gate_int8.dlc --input_list inputs.txt \
    --use_dsp --duration 30 --debug
  ```
  `--debug` prints per-layer timing; parse `Total Inference` for end-to-end latency.
- [ ] Deploy the classifier to the X Elite via QNN EP:
  ```python
  sess = ort.InferenceSession("classifier.onnx",
      providers=["QNNExecutionProvider"],
      provider_options=[{"backend_path": "QnnHtp.dll"}])
  ```
- [ ] ⭐ **VERIFY IT IS ACTUALLY ON THE NPU.** This is the #1 silent failure and a direct hit on Technical Implementation (40 pts):
  ```python
  import os, onnxruntime_qnn as q, onnxruntime as o
  os.add_dll_directory(os.path.dirname(q.__file__))
  o.register_execution_provider_library("QNNExecutionProvider", q.get_library_path())
  npu = [d for d in o.get_ep_devices()
         if d.ep_name == "QNNExecutionProvider" and str(d.device.type).endswith("NPU")]
  print("NPU device found:", bool(npu))
  ```
  **Note:** in `onnxruntime-qnn` 2.x the QNN EP does **not** appear in `get_available_providers()` even when working. Use `get_ep_devices()`. Screenshot the `True`. Put it on a slide.
- [ ] **Power profile — choose deliberately and be able to defend it.** Energy efficiency is explicitly scored.
  - UNO Q gate model = continuous background sensing → **`power_saver`/efficiency**
  - X Elite classifier = burst, event-driven → **`balanced`**
  - Say this out loud: *"we picked power_saver on the always-on gate because it runs every second on a battery-powered node; burst would be free performance we don't need and power we can't spare."* That one sentence is worth real points.
- [ ] **Benchmarks** (`tools/benchmark.py` — warmup 3, measure 50):
  ```python
  print(f"mean={t.mean():.1f}ms p50={p50:.1f} p95={p95:.1f} p99={p99:.1f}")
  ```
- [ ] **Fill BENCHMARKS.md — this table is your Technical Implementation score made visible:**

| Model | Device | Chip | Backend | mean | p50 | p95 | p99 | Speedup vs CPU |
|---|---|---|---|---|---|---|---|---|
| Gate | UNO Q MPU | Hexagon DSP v66 | DSP (INT8) | __ ms | __ | __ | __ | __× |
| Gate | UNO Q MPU | A53 | CPU (FP32) | __ ms | __ | __ | __ | 1× |
| Classifier | X Elite | Hexagon NPU v73 | QNN (INT8) | __ ms | __ | __ | __ | __× |
| Classifier | X Elite | X Elite CPU | CPU (FP32) | __ ms | __ | __ | __ | 1× |
| Classifier | OnePlus 15 | Hexagon NPU v81 | LiteRT NPU | __ ms | __ | __ | __ | __× |

> **Run the CPU baseline too.** "23 ms on NPU" is a number. "23 ms on NPU vs 140 ms on CPU, 6.1×, at lower power" is an *argument*. Also record end-to-end glass-to-glass latency (jolt → pin on phone) — that's the number a judge actually feels.

- [ ] **Milestone (3 AM): real models, real numbers, in the table.**

---

## 7. PHASE 4 — Hours 14–19 (Sun 3 AM → 8 AM): Fusion, Dashboard, Polish
- [ ] Point the PC at the live cloud service; merge live rig events into the simulated fleet
- [ ] Verify clustering: roll the car over the same pothole 3× from "3 different device IDs" → watch it flip `PENDING → CONFIRMED` live. **This is a great demo beat — a judge can watch verification happen.**
- [ ] Verify auto-clear: scrub the timeline → a repaired hazard disappears
- [ ] Authority dashboard: ranked hotspots + LLM repair briefs + the "worsening over 3 weeks" time-series
- [ ] "Why is this road red?" tooltip → "42 vehicles, avg severity 7.2, last 10 days"
- [ ] Route comparison: Fastest vs Smoothest with the explicit trade-off line
- [ ] Voice alert wired
- [ ] Privacy screen: *"no video, no location trail, no raw signal leaves your vehicle — only anonymised 40-byte event pings"* — one screen, real credibility, and it's **true**, which is the point
- [ ] **[STRETCH — only if everything above is done]** phone-fallback sensing with LiteRT on the v81 NPU:
  ```kotlin
  val env = Environment.create(BuiltinNpuAcceleratorProvider(context))
  val model = CompiledModel.create("/path/to/classifier.tflite",
      CompiledModel.Options(Accelerator.NPU), env)
  ```
  Requires copying the NPU libs into the app folder: `libLiteRtCompilerPlugin_Qualcomm.so`, `libLiteRtDispatch_Qualcomm.so`, `libQnnHtp.so`, `libQnnHtpPrepare.so`, `libQnnHtpV81Skel.so`, `libQnnHtpV81Stub.so`, `libQnnSystem.so`. **This needs a native module in React Native — 3+ hours. Cut it without hesitation if you're behind.**

---

## 8. PHASE 5 — Hours 19–23 (Sun 8 AM → 12 PM): Freeze, Document, Rehearse
**FEATURE FREEZE AT 8:00 AM. No new features after this. None.**

- [ ] Finalise README: description · **all names + emails** · setup from scratch · run instructions · license present
- [ ] Add: tests + testing instructions, Notes section, References, commented code (all four "optional" items — free Presentation points)
- [ ] **Audit for closed-source dependencies. Hard rule. Check every single one.**
- [ ] **Test the README on a clean machine.** "The application must be runnable using your provided instructions" is an eligibility gate, and a judge may literally try it.
- [ ] Fill BENCHMARKS.md completely
- [ ] Build the release APK, install on the OnePlus 15, test on the actual device
- [ ] **Rehearse the demo 3× against a phone timer at exactly 5:00.** Not 5:30. It's a hard cutoff.
- [ ] Record a backup demo video — if the live rig fails on stage, you're not dead
- [ ] Push everything. **Submit the GitHub link via the Microsoft Form well before 1:00 PM.** Not at 12:58.

---

## 9. PHASE 6 — The 5-Minute Demo Script

| Time | Beat |
|---|---|
| **0:00–0:25** | **Hook.** "Google Maps tells you when you'll arrive. It never tells you if your suspension will survive. India loses thousands of lives a year to road defects — and no city has objective data on which road to fix first." |
| **0:25–2:40** | **⭐ LIVE MULTI-DEVICE DEMO.** Roll the toy car over the road-board. Narrate the hops as they light up on screen: *"MCU caught it at 100 Hz → gate model on the UNO Q's Hexagon DSP said 'real event' → classifier on the X Elite NPU says pothole, severity 7 → cloud fuses it → phone."* Roll it over the speed breaker → **correctly classified differently**. Roll the pothole 3× → watch it flip to CONFIRMED live. **Hand the toy car to a judge and let them do it.** |
| **2:40–3:40** | **Technical depth.** The benchmark table: three Hexagon generations, one model concept, real measured numbers, CPU baselines, the NPU-verification screenshot. *"We verified via `get_ep_devices()` — because a model can load 'successfully' and silently run on CPU. Ours doesn't."* Mention the deliberate power-profile choice. |
| **3:40–4:35** | **Impact.** Authority dashboard: ranked repair list for Sector 135 with the LLM brief, the worsening-over-time chart, auto-clear. *"This isn't a map. It's the first objective repair-priority dataset a city has ever had — and it maintains itself."* |
| **4:35–5:00** | **The orchestration close.** *"Five compute domains. The MCU because Linux can't do deterministic 100 Hz. The DSP because raw signal shouldn't leave your car. The X Elite NPU because 45 TOPS buys real classification. The cloud because one car can't know what a thousand cars know. The phone because that's where the driver is. No single device does this. That's the whole point."* |

**Rules of the demo:** everyone on the team knows the whole script. One person talks, one drives the rig, one watches the clock. Do not read slides. Do not apologise for anything. If something breaks, cut to the backup video without breaking stride and keep talking.

---

## 10. Risk Register

| Risk | Probability | Mitigation |
|---|---|---|
| **UNO Q won't boot** | Med | Bring PD charger + PD dongle. Non-PD = no boot. |
| **No IMU in the kit** | Med | Bring Modulino Movement (Qwiic, zero wiring) + MPU6050 backup |
| **Venue Wi-Fi collapses** | **High** | Your own travel router/hotspot. Pre-download every dependency. |
| **AI Hub queue backed up** | **High** | **All exports done before July 17.** Artifacts committed. |
| **Model silently runs on CPU** | **High** | `verify_npu.py` + `get_ep_devices()`. Check on Sat morning, not Sun. |
| **<80% op coverage → CPU fallback** | Med | Boring ops only. Read the coverage output at export time, at home. |
| **GPS won't lock indoors** | **Certain** | Pre-recorded NMEA replay. Be transparent about it. |
| **Bridge/RPC fails** | Med | Never touch `Serial1`. Blink example first. Fallback: USB serial direct MCU→PC (drops Hop 2 — degrades gracefully, doesn't kill the demo). |
| **Cloud unreachable at demo** | Med | Local SQLite mirror on the PC. Driver loop must work cloud-free anyway — that's the "majority on edge" rule. |
| **Live demo fails on stage** | Med | Backup video, recorded Saturday night. |
| **Closed-source dep slips in** | Low/Fatal | Explicit audit at 8 AM Sunday. |
| **Scope creep** | **High** | 8 AM Sunday feature freeze. Phone-NPU fallback is the first thing cut. |

---

## 11. Team Roles (3–5 people)

| Role | Owns |
|---|---|
| **Embedded** | MCU sketch, MPU python, Bridge, IMU/GPS wiring, gate model on DSP |
| **Edge AI** | Data collection, training, AI Hub exports, quantization, NPU verification, **the benchmark table** |
| **Cloud/Backend** | FastAPI, H3 clustering, verification/auto-clear, LLM briefs, simulated fleet |
| **Mobile/Design** | React Native app, MapLibre, dashboards, polish, APK ← **this is you, Pratham** |
| **Integration/Demo** | Repo hygiene, README, license, demo rig, script, rehearsal, timekeeping |

If you're 4: Integration merges into Cloud. **Do not leave Integration unowned** — it's 15 points and the entire eligibility gate.

---

## 12. The Non-Negotiables (print this and tape it to the table)

1. **AI Hub exports done before July 17.** The queue will kill you on the day.
2. **Training data collected before July 17.** You cannot collect it in a Noida office.
3. **Verify NPU execution with `get_ep_devices()`, not vibes.**
4. **Every model INT8.** UNO Q's DSP v66 cannot run FP32 at all.
5. **PD charger.** No PD, no boot, no project.
6. **Your own hotspot.**
7. **README + LICENSE done before you arrive.** Eligibility, not polish.
8. **The Blink example runs by 10 AM Saturday.** If the Bridge doesn't work, nothing works.
9. **Feature freeze 8 AM Sunday.**
10. **Rehearse to 5:00. Three times.**
11. **Submit by 12:30, not 12:59.**
12. **You are building for the Multi-Device Prize. Every decision serves the 5-hop story.**
