# RoadSense — PHASE 0 ASSIGNMENTS
## 4 members · 3 days · Wed 15 → Fri 17 July
### Goal: arrive Saturday with a **finished system that has never touched Qualcomm hardware**. On-site = swap mocks for real devices, verify, benchmark, demo.

---

## ⚠️ READ THIS FIRST — Three Corrections

**1. You have 3 days, not 6.** Today is Wed July 15. The event is Sat July 18. The pre-hackathon workshop (July 13) has already passed — if you missed it, ask your questions on Discord `#snapdragon-multiverse-hack-noida` **today**.

**2. You have ZERO Qualcomm hardware until 9:00 AM Saturday.** No UNO Q, no Surface X Elite, no OnePlus 15. Everything below is designed around that.
> **The one exception that saves you:** Qualcomm AI Hub **compiles in the cloud against real Snapdragon hardware and returns real measured latency**. You can fill ~80% of your benchmark table this week without owning a single device. This is the highest-leverage fact in this document.

**3. 🔴 Your phone cannot collect valid training data.** Your test file measured **62.4 Hz**. The UNO Q's STM32 will sample at **200 Hz**. If you train on 62 Hz phone data and deploy on 100 Hz MCU data, that is a **domain mismatch** — the model learns features that don't exist at deployment and misses the >31 Hz impact transient that separates *pothole* from *speed breaker*. The model will fail live on stage.
>
> **Fix: order an Arduino Nano + MPU6050 + NEO-6M TODAY.** ~₹1,200. Same sensor family as the UNO Q rig, 200 Hz, same mounting. **This is the single most important decision in the next hour** — see HW-1.

---

## 🔒 THE INTEGRATION CONTRACT (freeze TODAY, before anyone writes code)

This is what makes "just plug it in on-site" actually work. Every boundary is mocked. Nobody waits for anybody.

```
[MCU] --C1--> [MPU] --C2--> [PC] --C3--> [Cloud] --C4--> [App]
       Bridge       WebSocket    HTTPS         REST
```

**C1 — MCU → MPU (Bridge RPC)**
```cpp
Bridge.provide("submit_window", submit_window);
// void submit_window(float window[192][6], uint64_t ts_us, uint32_t seq)
// order: ax, ay, az, gx, gy, gz  |  units: m/s^2, rad/s  |  RAW accel (gravity IN)
```

**C2 — MPU → PC (WebSocket, msgpack)**
```json
{ "device_id":"unoq-01", "seq":1234, "ts_us":1784135940017324,
  "window":[[192][6]], "gps":{"lat":28.4949,"lng":77.4000,"speed_mps":8.3},
  "vtype":"hatchback", "gate_score":0.87 }
```

**C3 — PC → Cloud/Fusion (HTTPS POST /events) — the ~40-byte event**
```json
{ "device_id":"unoq-01", "ts":1784135940, "lat":28.4949, "lng":77.4000,
  "cls":"pothole", "severity":7.2, "speed_kmh":30.0, "vtype":"hatchback", "conf":0.91 }
```

**C4 — Fusion → App (REST)**
```
GET /hazards?bbox=            -> [{h3, lat, lng, cls, severity, status, n_reports, last_seen}]
GET /route?from=&to=&mode=    -> {geometry, duration_s, hazards_hit[], comfort_score}
GET /authority/hotspots       -> [{h3, rank, priority_score, n_reports, brief, trend}]
POST /events                  -> {accepted:n}
```
`status ∈ {PENDING, CONFIRMED, RESOLVED}`

**Rules:** contract lives in `docs/CONTRACT.md`, committed by **6 PM today**. Any change = message all 4. Every module ships with a mock of its upstream.

---

## 👤 HW — Hardware Engineer
### *You have no UNO Q. You are therefore the most important person this week, because you're going to make it so nobody needs one.*

### **HW-1 · TODAY, NEXT 60 MINUTES · PROCUREMENT** 🔴
Order with **fastest possible delivery** (Robu.in / Amazon India same-or-next-day; or physically buy at **Nehru Place / Lajpat Rai Market, Delhi** tomorrow — faster and certain):

| Item | Qty | ~₹ | Why |
|---|---|---|---|
| **Arduino Nano / Uno** | 1 | 400 | Data logger — 200 Hz capable |
| **MPU6050 IMU** | 2 | 200 | *The* critical item. Same family as UNO Q rig. Buy 2. |
| **Modulino Movement** (Qwiic) | 1 | 900 | Plugs into UNO Q with **zero wiring**. Best on-site insurance. |
| **NEO-6M GPS** | 1 | 400 | GPS + speed |
| **microSD module + card** | 1 | 250 | Logging in-car |
| **USB-C PD charger (30W+) + PD dongle** | 1 | 1500 | 🔴 **UNO Q WILL NOT BOOT WITHOUT PD** |
| Breadboard, jumpers (M-M, M-F), Qwiic cables | — | 300 | |
| Travel router / spare hotspot phone | 1 | — | Venue Wi-Fi at a 100-team hackathon *will* fail |

**If nothing arrives in time:** the pipeline still works (you'll have the emulator), but you train on band-limited phone data and your pothole/breaker discrimination degrades. Say so honestly in the README rather than pretending. Buying the MPU6050 is how you avoid that conversation entirely.

### **HW-2 · TODAY · Build `fake_unoq.py`** ⭐ *Your highest-value deliverable*
An emulator that replays `simulate_unoq_imu.py` sessions and speaks **C2** over a real WebSocket. **This unblocks Backend, Frontend, and ML for the entire week.**
```bash
python fake_unoq.py --session ./sim/session_000_hatchback_33kmh --realtime --device-id unoq-01
```
Requirements: real WebSocket, real timing (192-sample windows at 100 Hz), real msgpack, replays GPS from `labels.json`, `--inject pothole` to fire an event on keypress (for demo rehearsal).
> On Saturday you delete one line and point the PC at the real board. **That's the whole trick.**

### **HW-3 · TODAY/THU · Write the MCU sketch (untestable — so write it defensively)**
Exact UNO Q app structure — **these names are literal, the runtime looks for them**:
```
unoq/
├── app.yaml
├── python/main.py + requirements.txt
└── sketch/sketch.ino + sketch.yaml
```
Sketch does: MPU6050 over I²C @ 200 Hz → 384-sample ring buffer → peak trigger `|a_z − 9.81| > 3.5 m/s²` → decimate to 192@100 Hz → `Bridge.call("submit_window", ...)`.

> ⚠️ **Never touch `Serial1`.** The arduino-router **exclusively owns** the inter-chip serial link. Touch it and the Bridge dies silently.
> ⚠️ **Keep the Bridge code to ~20 lines.** You cannot test it until Saturday. Copy the docs' Blink pattern *exactly*.
> ⚠️ **Write the USB-serial fallback now.** If the Bridge fails on-site, MCU streams straight to the PC over USB. You lose Hop 2 and degrade to 4 hops — but you still have a demo. This fallback is worth more than any feature.

### **HW-4 · THU · Collect REAL data** (once the MPU6050 lands)
Nano + MPU6050 + NEO-6M + SD + power bank, **rigidly taped to the car floor pan**. Not handheld. Not in a pocket — that's what produced the 86.9% gait signature in the phone test.
- **200 Hz**, raw accel (gravity IN), gyro, GPS
- Drive **Mainpuri → Delhi NCR**. Passenger calls out labels into a voice memo, or a button on a spare pin.
- **Target: ≥250 labelled events** — ~70 pothole, ~70 speed breaker, ~70 rough, ~40 negatives (hard braking, door slam, turning)
- **Both vehicle types** — 2-wheeler + car. This is what makes vehicle calibration real.
- **Run `check_recording.py` before you drive home.** It fails loudly on rate, gravity, alignment, and the wheel-hop test. If wheel-hop <5%, your mount is bad — re-record on the spot.

### **HW-5 · THU/FRI · 🔧 The Demo Road-Board** *(this wins the room and the popular vote)*
- ~1.2 m plank / foam board
- **Pothole** = rectangular hole cut ~4 cm deep with a **sharp far edge** (the exit strike is the signature)
- **Speed breaker** = half-round dowel or cable protector glued across (smooth, no edge)
- **Rough patch** = coarse sandpaper / glued gravel strip
- **Toy car / skateboard** with the IMU **rigidly** taped on
- Roll it → three physically distinct, visibly different signatures

Rehearse until the rolls are repeatable. **A judge will hold this.** Record a pre-recorded NMEA track from a real Noida drive for indoor GPS replay (GPS will not lock on floor 12 — plan for it, be transparent about it).

### **HW-6 · FRI · Pack**
Everything above + USB-C hub + USB-A↔C adapters + 2× long USB-C cables (the Surface Laptop 7 has almost no ports) + power bank + extension board + **all pip wheels, npm modules, model artifacts, OSM tiles pre-downloaded**. Assume the internet dies.

---

## 👤 ML — Model Engineer
### *You can get real hardware-measured latency this week without owning hardware. Exploit that.*

### **ML-1 · TODAY · Accounts + the exact device strings** (30 min)
```bash
pip install qai-hub qai-hub-models
qai-hub configure --api_token <token>          # app.aihub.qualcomm.com -> Account -> API Token
qai-hub list-devices | grep -i "X Elite"
qai-hub list-devices | grep -i "8 Elite"
```
**Commit the exact device label strings to `docs/DEVICES.md`.** Getting these wrong on Saturday costs an hour.
> Token is a secret. Never commit it. Never paste it in the team chat.

### **ML-2 · TODAY · Architecture + op-coverage dry run** ⭐
Train a throwaway on `windows_SYNTHETIC.npz` — **you don't care about accuracy, you care about whether it compiles clean to the NPU.**
```
Input (6, 192)
 → Conv1D(16,k=7,s=2) → BN → ReLU
 → Conv1D(32,k=5,s=2) → BN → ReLU
 → Conv1D(64,k=3,s=2) → BN → ReLU
 → GlobalAvgPool → Dense(32) → ReLU
 → ├─ Dense(4) softmax   [class]
   └─ Dense(1) sigmoid   [severity]
```
Export ONNX (**opset 17, static shapes**), then:
```bash
python -m qai_hub_models.models.<slug>.export --target-runtime qnn \
  --device "<exact X Elite label>" --calibration-data ./data/calibration/
```
Custom model → **Bring Your Own Model notebook: https://tinyurl.com/byom-aihub**

🔴 **READ THE OP-COVERAGE OUTPUT. Do not skip past it.**
- **≥80% on NPU** → ship it
- **<80%** → CPU↔NPU round-trips may cost more than they save. Restructure *today*, not Saturday.
- **Banned ops:** LSTM/GRU, attention, custom activations, dynamic shapes. Boring compiles clean.

### **ML-3 · TODAY/THU · Quantize INT8 — mandatory, all three targets**
| Target | Chip | Format | Note |
|---|---|---|---|
| Gate (~10k params) | UNO Q Hexagon **DSP v66**, 1.0 TOPS | `.dlc` INT8 | 🔴 **v66 cannot run FP32 at all** — silent CPU fallback |
| Classifier (~60k) | X Elite Hexagon **NPU v73**, 45 TOPS | QNN INT8 | |
| Classifier | OnePlus 15 Hexagon **NPU v81** | LiteRT `.tflite` | stretch |

```bash
qairt-converter --input_network gate.onnx --output_path gate_int8.dlc \
  --input_list calibration_windows.txt --quantization_overrides int8
```
🔴 **Calibration must use REAL data — 10–100 windows matching the inference distribution.** The AI Hub guide is explicit: calibrating on random or synthetic data silently wrecks your scales while the pipeline still appears to "work." **Hold calibration until HW-4 real data lands.** This is the one thing that genuinely blocks on hardware.

### **ML-4 · THU · Train v1 on real data**
Target ≥85% 4-class. Don't chase 99%. Severity head per the plan's formula:
```
severity_norm = peak|a_z − 1g| / (v/30)^1.5 × k_vehicle    k: 2W 0.7 | hatch 1.0 | SUV 1.3
```

### **ML-5 · THU/FRI · ⭐ AI Hub profiling jobs = your benchmark table, filled from home**
AI Hub runs on **real cloud-hosted Snapdragon hardware** and returns **real measured latency**. Submit profile jobs for all three targets. Fill `BENCHMARKS.md`:

| Model | Device | Chip | Backend | mean | p50 | p95 | p99 | vs CPU |
|---|---|---|---|---|---|---|---|---|
| Gate | UNO Q | DSP v66 | DSP INT8 | | | | | |
| Gate | UNO Q | A53 | CPU FP32 | | | | | 1× |
| Classifier | X Elite | NPU v73 | QNN INT8 | | | | | |
| Classifier | X Elite | CPU | CPU FP32 | | | | | 1× |
| Classifier | OnePlus 15 | NPU v81 | LiteRT NPU | | | | | |

🔴 **Run the CPU baselines too.** "23 ms on NPU" is a number. "23 ms vs 140 ms on CPU — 6.1× at lower power" is an **argument**. That gap is Technical Implementation (40 pts) made visible.

🔴 **AI Hub compiles are QUEUED against shared hardware.** On Saturday, ~100 teams hit it simultaneously. **Every export finished by Friday.** Artifacts committed to `models/`.

### **ML-6 · FRI · `verify_npu.py` + `benchmark.py`**
```python
import os, onnxruntime_qnn as q, onnxruntime as o
os.add_dll_directory(os.path.dirname(q.__file__))
o.register_execution_provider_library("QNNExecutionProvider", q.get_library_path())
npu = [d for d in o.get_ep_devices()
       if d.ep_name == "QNNExecutionProvider" and str(d.device.type).endswith("NPU")]
print("NPU device found:", bool(npu))
```
🔴 **In `onnxruntime-qnn` 2.x the QNN EP does NOT appear in `get_available_providers()` even when working correctly.** Use `get_ep_devices()`. A model can load "successfully" and silently run on CPU — that's a direct hit on your biggest scoring category. **Screenshot the `True`. It goes on a slide.**

`benchmark.py`: warmup 3, measure 50, report mean/p50/p95/p99.

**Power profiles — choose deliberately, energy efficiency is explicitly scored:**
- Gate on UNO Q = always-on battery sensing → **`power_saver`**
- Classifier on X Elite = event-driven burst → **`balanced`**
> Line for the demo: *"we chose power_saver on the always-on gate because it runs every second on a battery node — burst would be performance we don't need and power we can't spare."*

---

## 👤 BE — Backend Engineer
### *Your fusion engine runs on the X Elite, not the cloud. That's the edge-first story.*

### **BE-1 · TODAY · Freeze the contract** (with Frontend, by 6 PM) → `docs/CONTRACT.md`

### **BE-2 · TODAY/THU · Local fusion engine** *(runs on the X Elite — pure Python, fully testable at home)*
- `pip install h3` — **H3 resolution 12** (~9 m cells)
- SQLite hazard store
- **Verification:** ≥3 **distinct** `device_id` in a cell within 14 days → `PENDING → CONFIRMED`
- **Auto-clear:** 5 consecutive clean passes over a confirmed cell → `RESOLVED`
- **Priority:** `severity_avg × log(1 + vehicles_per_day) × age_factor`
- **Routing:** graph over OSM, edge weight `= time + λ · hazard_cost` → fastest vs smoothest
- Serves **C4** to the app

🔴 **The entire driver-facing loop must work with the network physically off.** That's the "majority runs on edge" rule *and* your best demo beat — **pull the Wi-Fi on stage and keep rolling the car.**

### **BE-3 · THU · Cloud layer (Qualcomm AI Inference Suite)**
- LLM → 2-sentence civic repair brief per hotspot. **This is what justifies Cloud AI 100 as *AI* rather than a database.**
- Cross-region hazard-map reconciliation
- **Everything here is optional by design** — kill the network, driver loop unaffected

> ⚠️ If you touch any GenAI bundle: **`torch` has no Windows-ARM64 wheel**, so you cannot export on the X Elite. Build in WSL/x86/macOS, copy the bundle over, run with native ARM64 Python + `onnxruntime-genai`. Multi-GB download — **do it this week, not Saturday.**

### **BE-4 · THU · Simulated fleet** ⭐
You have 1 rig. Your story is 1,000 cars. Bridge it honestly.
- ~200 virtual vehicles × ~50 events over **real Noida OSM roads — Sector 135 / Noida-Greater Noida Expressway**. *That's the judges' own commute.*
- ~30 realistic clusters + noise + **3 "repaired" hazards that visibly auto-clear when you scrub the timeline**
- Pre-loaded so the map is **alive** the instant the demo starts
- **Labelled as simulated in the README, and said out loud.** Honesty scores. A caught fake is fatal.

### **BE-5 · FRI · Local peer-consensus (the novelty play)**
Per the earlier decision — **Option A, BLE gossip**. Two nodes that see the same jolt within a few seconds mark it locally confirmed **before any cloud contact**. Build the protocol + logic now against `fake_unoq.py` running two device IDs; the BLE transport gets wired on-site.
> *"The map has no server"* is the one-line hook. **Wired fallback ready** — BLE demos die in RF-hostile rooms full of hackers.

---

## 👤 FE — Frontend / Design *(Pratham)* + **Integration Owner**
### *"Commercially ready to the extent it may be deployed on an app store" is an explicit rule. This is your skillset. It's also 15 points and the entire eligibility gate.*

### **FE-1 · TODAY · Contract freeze with BE** + repo scaffold + **`LICENSE` (MIT)** committed today

### **FE-2 · TODAY/THU · App against `fake_unoq.py` + BE's simulated fleet**
React Native + **MapLibre GL** (open source — 🔴 **"no closed-source code" is a hard rule**; Mapbox's licensing is a question you don't want on Sunday).

| Screen | Must have |
|---|---|
| **Driver Map** | green/amber/red road health, hazard icons, live "Pothole in 200 m — 12 vehicles" banner |
| **Route Compare** | Fastest vs Smoothest toggle → *"+3 min, avoids 4 potholes"* |
| **Trip Summary** | "Your car absorbed 6 jolts" + suspension-stress score |
| **Authority Dashboard** ⭐ | ranked repair list, LLM brief, **worsening-over-3-weeks chart**, auto-clear timeline scrub |
| **Privacy** | *"No video. No location trail. No raw signal leaves your vehicle — only anonymised 40-byte pings."* One screen. It's **true**, which is the point. |

Plus: **"Why is this road red?"** tooltip → *"42 vehicles, avg severity 7.2, last 10 days."* Cheap UI, big trust payoff.
Voice alerts: **Android native TTS is free and instant.** Hindi — *"Aage gaddha hai, dheere chaliye."* Sarvam TTS = stretch only.

🔴 **The app should look finished before you arrive.** Real Figma time. On Saturday the other teams will be unboxing.

### **FE-3 · THU · 🔴 README + LICENSE — this is an ELIGIBILITY GATE, not polish**
Must contain: app description · **names + emails of ALL 4 members** · **setup from scratch incl. dependencies** · **run & usage instructions** · open-source license.
Also do all four "optional" items — they're **free Presentation points**: tests + testing instructions, Notes section, References, well-commented code.
> **"The application must be runnable using your provided instructions."** A judge may literally try it. **Test the README on a clean machine Friday.**

### **FE-4 · FRI · Integration audit** *(you own this — with 4 people it cannot be unowned)*
- [ ] 🔴 **Dependency audit — every single one open source.** Hard rule.
- [ ] Full chain runs end-to-end: `fake_unoq.py` → PC → fusion → app
- [ ] Network-off test: driver loop survives
- [ ] Release APK built (installs on real Android Sat morning)
- [ ] `docs/DEVICES.md`, `BENCHMARKS.md`, `ARCHITECTURE.md` present
- [ ] All model artifacts committed to `models/`

### **FE-5 · FRI NIGHT · ⭐ FULL DEMO REHEARSAL — all 4 of you, emulator as hardware**
Rehearse **3× against a phone timer at exactly 5:00.** Not 5:30 — it's a hard cutoff.

| Time | Beat |
|---|---|
| 0:00–0:25 | **Hook.** "Maps tells you when you'll arrive. Never whether your suspension survives." |
| 0:25–2:40 | **⭐ LIVE.** Roll the car. Narrate hops lighting up. Speed breaker → different class. Pothole ×3 → **CONFIRMED live**. **Hand the car to a judge.** Pull the Wi-Fi — it keeps working. |
| 2:40–3:40 | **Depth.** Benchmark table, 3 Hexagon generations, CPU baselines, NPU-verification screenshot, power-profile rationale. |
| 3:40–4:35 | **Impact.** Authority dashboard, LLM brief for Sector 135, trend chart, auto-clear. |
| 4:35–5:00 | **Close.** *"Five compute domains. MCU because Linux can't do deterministic 100 Hz. DSP because raw signal shouldn't leave your car. NPU because 45 TOPS buys real classification. Cloud because one car can't know what a thousand know. Phone because that's where the driver is. No single device does this."* |

**Record the backup demo video Friday night.** If the live rig dies on stage, cut to it without breaking stride.

---

## 📅 Day Grid

| | **WED 15 (today)** | **THU 16** | **FRI 17** |
|---|---|---|---|
| **HW** | 🔴 **ORDER PARTS (1hr)** · `fake_unoq.py` · MCU sketch | **Collect real data** (Delhi/Mainpuri) · road-board rig | Rig rehearsal · USB fallback · **PACK** |
| **ML** | AI Hub token · device strings · **op-coverage dry run** | **Train v1 on real data** · INT8 + real calibration | **All AI Hub exports DONE** · benchmarks · verify_npu.py |
| **BE** | Contract freeze · fusion engine · H3 | Cloud/LLM briefs · **simulated fleet** | Peer-consensus logic · network-off test |
| **FE** | Contract freeze · LICENSE · RN + MapLibre | **All 4 screens** · design polish · **README** | **Integration audit** · APK · **REHEARSAL ×3** |

**Everyone, tonight 9 PM:** 15-min standup. Contract frozen? Parts ordered? Blockers?

---

## ✅ Definition of Done — Friday 11 PM

- [ ] `fake_unoq.py` → PC → fusion → app works end-to-end **with zero Qualcomm hardware**
- [ ] Model trained on **real 200 Hz IMU data**, INT8, **real calibration**, ≥80% NPU op coverage
- [ ] **All AI Hub artifacts committed** — nothing left to compile Saturday
- [ ] Benchmark table ~80% filled from AI Hub cloud profiling
- [ ] README + LICENSE done, **tested on a clean machine**
- [ ] Every dependency open source
- [ ] APK builds
- [ ] Demo rehearsed 3× at 5:00 · backup video recorded
- [ ] Bag packed: **PD charger**, MPU6050 ×2, Modulino, GPS, hotspot, road-board, toy car
- [ ] Network-off test passes

---

## 🚨 The Ten Non-Negotiables

1. **Order the MPU6050 today.** Phone data at 62 Hz cannot train a 100 Hz model.
2. **PD charger.** No PD → UNO Q doesn't boot → no project.
3. **Every AI Hub export done by Friday.** The Saturday queue will kill you.
4. **Real calibration data.** Synthetic calibration silently destroys INT8 accuracy.
5. **Every model INT8.** DSP v66 cannot run FP32 at all.
6. **Verify NPU with `get_ep_devices()`**, not `get_available_providers()`, not vibes.
7. **Never touch `Serial1`.** The router owns it.
8. **README + LICENSE before you arrive.** Eligibility, not polish.
9. **Zero closed-source dependencies.** Audit Friday.
10. **`fake_unoq.py` is sacred.** It's why on-site is assembly, not construction.

---

## Saturday Preview (why all of this pays off)

Devices land **9:00 AM**. Hacking starts **1:00 PM**. **Those 4 hours are free.**

| Time | |
|---|---|
| 9:00 | Team Lead signs Loaner Agreement — no signature, no device |
| 9:15 | UNO Q first boot **on PD** · firmware · **your hotspot**, not venue Wi-Fi |
| 9:40 | App Lab → **Blink LED**. *If Blink works, the Bridge works.* |
| 10:00 | Copy-and-edit → `roadsense` · paste HW's sketch + python |
| 10:15 | Modulino via Qwiic (**zero wiring**) → raw reads in console |
| 10:40 | Surface: **native ARM64** Python · `pip install onnxruntime-qnn` · **run `verify_npu.py`** |
| 11:00 | Kickoff + **DevRel Masterclass** — all 4 attend |
| 11:30 | **Sarvam: Edge & Hybrid** — ask about Hindi TTS |
| 12:00 | Lunch → **find a mentor, pitch the 5-hop architecture, get free judge-calibration** |
| 12:45 | Swap `fake_unoq.py` → real UNO Q. **The system should already work.** |

**By 1:00 PM you're benchmarking. Everyone else is unboxing.**

---

> **One honest note:** none of this *guarantees* a win — Multi-Device Prize remains your realistic target and the Top Award depends on what the other ~30 teams bring. But this plan removes every failure mode that's actually inside your control. That's the most any team can do, and it's more than almost any team will.
