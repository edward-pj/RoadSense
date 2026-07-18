"""X Elite hop: WebSocket ingest from UNO Q, classification, cloud forward,
local mirror, and the hop-visualizer dashboard.

Edge-first: every event is written to the local SQLite mirror FIRST, then
forwarded to the cloud if reachable. If the cloud is down the driver loop
keeps working and unsent events are flushed on reconnect.

Run:  uvicorn pc.server:app --host 0.0.0.0 --port 8100
Dashboard: http://localhost:8100/
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from cloud import db as clouddb
from cloud import hazards as local_fusion
from . import detector as detector_mod

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("roadsense.pc")

CLOUD_URL = os.environ.get("ROADSENSE_CLOUD", "http://localhost:8000")
MIRROR_DB = os.environ.get("ROADSENSE_MIRROR_DB", "pc_mirror.db")
DASHBOARD = Path(__file__).resolve().parent / "dashboard" / "index.html"

VEHICLE_FACTORS = {"2wheeler": 0.7, "hatchback": 1.0, "suv": 1.3}


class HopBus:
    """Broadcasts hop/pipeline events to every connected dashboard."""

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()

    async def register(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)

    def unregister(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def emit(self, kind: str, payload: dict[str, Any]) -> None:
        msg = json.dumps({"kind": kind, "ts": time.time(), **payload})
        for ws in list(self._clients):
            try:
                await ws.send_text(msg)
            except Exception:
                self.unregister(ws)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.detector = detector_mod.get_detector()
    app.state.mirror = clouddb.connect(MIRROR_DB)
    app.state.bus = HopBus()
    app.state.pending: list[dict[str, Any]] = []  # events awaiting cloud sync
    app.state.http = httpx.AsyncClient(timeout=3.0)
    flusher = asyncio.create_task(_flush_loop(app))
    log.info("pc hop up: backend=%s cloud=%s", app.state.detector.backend, CLOUD_URL)
    yield
    flusher.cancel()
    await app.state.http.aclose()
    app.state.mirror.close()


app = FastAPI(title="RoadSense PC Hop", version="1.0.0", lifespan=lifespan)


@app.get("/")
def dashboard() -> FileResponse:
    return FileResponse(DASHBOARD)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "backend": app.state.detector.backend}


@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket) -> None:
    await app.state.bus.register(ws)
    try:
        while True:
            await ws.receive_text()  # keepalive; dashboard is read-only
    except WebSocketDisconnect:
        app.state.bus.unregister(ws)


@app.websocket("/ws/ingest")
async def ws_ingest(ws: WebSocket) -> None:
    """Receives gated windows from the UNO Q MPU (hop 2 -> hop 3).

    Message: {device_id, user_id, seq, ts, lat, lng, speed_kmh, vehicle_type,
              window: [[ax,ay,az,gx,gy,gz] x 128]}
    """
    await ws.accept()
    log.info("uno q connected")
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            await _process_window(msg)
    except WebSocketDisconnect:
        log.info("uno q disconnected")


async def _process_window(msg: dict[str, Any]) -> None:
    t0 = time.perf_counter()
    bus: HopBus = app.state.bus
    await bus.emit("hop", {"hop": 2, "label": "gate passed",
                           "device": msg["device_id"]})

    window = np.asarray(msg["window"], dtype=np.float32)
    vf = VEHICLE_FACTORS.get(msg.get("vehicle_type", "hatchback"), 1.0)
    det = app.state.detector.predict(window, msg.get("speed_kmh", 30.0), vf)
    infer_ms = (time.perf_counter() - t0) * 1000

    await bus.emit("hop", {"hop": 3, "label": f"{det.road_class} "
                           f"({det.confidence:.0%}) sev {det.severity:.1f}",
                           "infer_ms": round(infer_ms, 1),
                           "backend": det.backend,
                           "waveform": [round(float(s), 4) for s in window[:, 2]]})

    event = {
        "device_id": msg["device_id"], "seq": msg["seq"], "ts": msg["ts"],
        "lat": msg["lat"], "lng": msg["lng"], "road_class": det.road_class,
        "severity": round(det.severity, 2), "speed_kmh": msg.get("speed_kmh", 30.0),
    }

    # Edge-first: local mirror is the source of truth for the driver loop.
    mirror = app.state.mirror
    with mirror:
        local_fusion.register_device(mirror, msg["device_id"],
                                     msg.get("user_id", msg["device_id"]))
        local_fusion.ingest_event(mirror, event)

    app.state.pending.append(event)
    await _try_flush()
    await bus.emit("event", {**event, "backend": det.backend,
                             "glass_ms": round((time.perf_counter() - t0) * 1000, 1)})


async def _try_flush() -> None:
    """Push pending events to the cloud; keep them on any failure."""
    if not app.state.pending:
        return
    batch, app.state.pending = app.state.pending, []
    try:
        r = await app.state.http.post(f"{CLOUD_URL}/api/v1/events", json=batch)
        r.raise_for_status()
        await app.state.bus.emit("hop", {"hop": 4, "label": f"cloud fused {len(batch)}"})
    except Exception as exc:
        app.state.pending = batch + app.state.pending
        log.warning("cloud unreachable (%s); %d events queued", exc,
                    len(app.state.pending))
        await app.state.bus.emit("hop", {"hop": 4, "label": "offline — queued",
                                         "offline": True})


async def _flush_loop(app: FastAPI) -> None:
    """Background retry so queued events drain when the cloud returns."""
    while True:
        await asyncio.sleep(5)
        await _try_flush()


@app.get("/api/v1/hazards")
def local_hazards() -> dict[str, Any]:
    """Local-mirror hazards — what the phone reads when the cloud is dead."""
    return {"hazards": local_fusion.list_hazards(app.state.mirror),
            "source": "local_mirror"}
