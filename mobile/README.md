# RoadSense Driver App (OnePlus 15 — hop 5)

**Status: not yet scaffolded.** Framework decision pending (Expo React
Native recommended). Everything the app consumes already exists and is
tested on the backend.

## Onboarding + multilingual front (built)

A working, framework-free onboarding flow — a vanilla port of the
`Onboarding.dc.html` design: **language → intro slides → login → done**.

- `rs-i18n.js` — the multilingual engine (`window.RSI18n`). Ships 6 Indian
  languages (English, Hindi, Bengali, Tamil, Telugu, Marathi). Missing keys
  fall back to English. The chosen language is persisted in `localStorage`
  (`rs_lang`) and broadcast via `RSI18n.onChange`, so it is **app-wide** — the
  language a driver picks drives every screen and every later session.
- `rs-onboarding.js` — `window.OnboardingScreen`, following the same
  `mount()/onShow()/onHide()` contract as `rs-screens.js`. All copy comes from
  `RSI18n.t()`; picking a language re-renders the whole flow live.
- `onboarding.html` — standalone host in the 390×844 phone frame.

Run: `python3 -m http.server 8777` then open
`http://localhost:8777/onboarding.html`. Sign in with **demo / demo**.
To reuse the engine elsewhere, add `RSI18n.t()` calls and a dictionary key.

### Whole-app translation (Sarvam AI)

The onboarding/login copy lives inline in `rs-i18n.js`. The **main app screens**
(routes + contribution, in `rs-screens.js` and `app.html`) are also fully
multilingual: every visible string goes through `RSI18n.t(key, params)`, and
the translations are **pre-baked** into `mobile/i18n/app.<lang>.json`.

- `mobile/i18n/app.en.json` is the hand-written English source of truth.
- `tools/translate_ui.py` runs **Sarvam Translate** over it once and writes
  `app.hi/bn/ta/te/mr.json` (committed). `{n}`/`{cls}`/`{loc}` placeholders are
  protected and verified; any string whose placeholder is lost keeps English.
- `rs-i18n.js` fetches these at boot (English base + active language) and on
  language change, so the running app needs **no network for text**. Missing
  keys fall back to English. `RSI18n.ready()` resolves once they are loaded.
- Language comes from onboarding via `?lang=` / `localStorage('rs_lang')`; the
  **You** tab also has an in-app switcher that re-renders every screen live.

Re-bake after editing English copy: `python tools/translate_ui.py`
(reads `SARVAM_API_KEY` from the repo-root `.env`).

### Navigation voice alert (Sarvam AI TTS)

Tapping **Start navigation** now *speaks* the hazard alert in the driver's
language via **Sarvam Text-to-Speech**, not just shows the banner text.
`RSApi.speak(text, lang)` (in `rs-api.js`) POSTs to the backend proxy
`POST /api/v1/tts` (cloud `:8000` or the PC edge `:8100`), which holds the
Sarvam key server-side and returns WAV audio. If the cloud/Sarvam is
unreachable it falls back to the browser's on-device `speechSynthesis`, so the
alert still speaks offline (edge-first rule). `RSApi.speak` is reusable for the
second voice spot planned in the app.

**Run the full app** (both hops):
```
# repo root, with SARVAM_API_KEY in .env
uvicorn cloud.app:app --port 8000            # cloud fusion + Sarvam proxy
uvicorn pc.server:app --port 8100            # PC edge (also serves /mobile)
```
Open `http://localhost:8100/mobile/onboarding.html`, pick a language, sign in
(**demo / demo**), Open RoadSense → the whole app is in that language; the
Routes tab → **Start navigation** speaks the alert.

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
