# RoadSense Driver App (OnePlus 15 — hop 5)

**Status: not yet scaffolded.** Framework decision pending (Expo React
Native recommended). Everything the app consumes already exists and is
tested on the backend.

## Screens

1. **Driver map** — MapLibre GL, hazard pins from `GET /api/v1/hazards`
   (green/amber/red by severity), polls or WebSocket refresh.
2. **Route compare** — Fastest vs Smoothest toggle ("+3 min, avoids 4 potholes").
3. **Coins & missions** — balance + ledger from `GET /api/v1/rewards/{user}`,
   progress bars from `GET /api/v1/missions/{user}`.
4. **Hazard vote** — tap a pin → confirm / not there →
   `POST /api/v1/hazards/{id}/vote`.
5. **Authority dashboard** — ranked hotspots from
   `GET /api/v1/authority/hotspots`.

Voice alerts: Android TTS ("Aage gaddha hai, dheere chaliye") when
approaching a CONFIRMED hazard within ~150 m on the current heading.

## Offline mode (edge-first rule)

Point the app at the X Elite's local mirror
(`http://<x-elite>:8100/api/v1/hazards`) when the cloud is unreachable —
same response shape, `"source": "local_mirror"`.

## Stretch: on-device inference (Hexagon NPU v81)

`models/classifier_v81.tflite` (from `tools/export_aihub.py --target phone`)
via LiteRT with the NPU accelerator. Needs a native module plus the Qualcomm
NPU runtime libraries bundled in the app (`libLiteRtCompilerPlugin_Qualcomm.so`,
`libLiteRtDispatch_Qualcomm.so`, `libQnnHtp.so`, `libQnnHtpPrepare.so`,
`libQnnHtpV81Skel.so`, `libQnnHtpV81Stub.so`, `libQnnSystem.so`).
~3+ hours — first thing to cut if behind (per the build plan).
