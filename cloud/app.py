"""RoadSense cloud fusion API (FastAPI).

Route handlers orchestrate only — all business logic lives in hazards.py
and rewards.py. Runs identically as the cloud instance and as the X Elite
local mirror (edge-first rule).

Run:  uvicorn cloud.app:app --host 0.0.0.0 --port 8000
Docs: /docs (Swagger, auto-generated)
"""

from __future__ import annotations

import logging
import sqlite3
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import db, hazards, rewards, routing

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(name)s %(levelname)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.conn = db.connect()
    yield
    app.state.conn.close()


app = FastAPI(title="RoadSense Fusion API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def error_envelope(request: Request, exc: Exception) -> JSONResponse:
    """Consistent error envelope for unhandled failures."""
    if isinstance(exc, HTTPException):
        return JSONResponse(status_code=exc.status_code,
                            content={"error": {"code": str(exc.status_code),
                                               "message": str(exc.detail)}})
    logging.getLogger("roadsense.api").exception("unhandled error")
    return JSONResponse(status_code=500,
                        content={"error": {"code": "internal", "message": "internal error"}})


def _conn(request: Request) -> sqlite3.Connection:
    return request.app.state.conn


class DeviceIn(BaseModel):
    device_id: str
    user_id: str
    vehicle_type: str = "hatchback"


class EventIn(BaseModel):
    device_id: str
    seq: int = Field(ge=0)
    ts: float
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    road_class: str
    severity: float = Field(ge=0, le=10)
    speed_kmh: float = Field(ge=0, le=300)


class VoteIn(BaseModel):
    user_id: str
    vote: str = Field(pattern="^(confirm|deny)$")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/devices")
def register_device(body: DeviceIn, request: Request) -> dict[str, str]:
    conn = _conn(request)
    with conn:
        hazards.register_device(conn, body.device_id, body.user_id, body.vehicle_type)
    return {"device_id": body.device_id, "user_id": body.user_id}


@app.post("/api/v1/events")
def ingest_events(events: list[EventIn], request: Request) -> dict[str, Any]:
    """Batch ingest of classified road events (idempotent per device+seq)."""
    conn = _conn(request)
    results = []
    with conn:
        for evt in events:
            results.append(hazards.ingest_event(conn, evt.model_dump()))
    accepted = sum(1 for r in results if not r["duplicate"])
    return {"received": len(events), "accepted": accepted, "results": results}


@app.get("/api/v1/hazards")
def list_hazards(request: Request, include_resolved: bool = False) -> dict[str, Any]:
    statuses = ("PENDING", "CONFIRMED", "RESOLVED") if include_resolved \
        else ("PENDING", "CONFIRMED")
    return {"hazards": hazards.list_hazards(_conn(request), statuses)}


@app.post("/api/v1/hazards/{hazard_id}/vote")
def vote_hazard(hazard_id: int, body: VoteIn, request: Request) -> dict[str, Any]:
    conn = _conn(request)
    with conn:
        counts = hazards.vote(conn, hazard_id, body.user_id, body.vote)
    return {"hazard_id": hazard_id, "votes": counts}


@app.get("/api/v1/rewards/{user_id}")
def get_rewards(user_id: str, request: Request) -> dict[str, Any]:
    conn = _conn(request)
    return {"user_id": user_id,
            "balance": rewards.balance(conn, user_id),
            "history": rewards.history(conn, user_id)}


@app.get("/api/v1/missions/{user_id}")
def get_missions(user_id: str, request: Request) -> dict[str, Any]:
    return {"user_id": user_id,
            "missions": rewards.mission_status(_conn(request), user_id)}


@app.get("/api/v1/authority/hotspots")
def get_hotspots(request: Request, limit: int = 20) -> dict[str, Any]:
    """Ranked repair-priority list for the government dashboard."""
    return {"hotspots": hazards.hotspots(_conn(request), limit)}


@app.get("/api/v1/route")
def get_route(request: Request, from_lat: float, from_lng: float,
              to_lat: float, to_lng: float) -> dict[str, Any]:
    """Fastest vs smoothest route comparison over confirmed hazards."""
    return routing.compare_routes(_conn(request), from_lat, from_lng,
                                  to_lat, to_lng)


@app.get("/api/v1/leaderboard")
def leaderboard(request: Request, limit: int = 20) -> dict[str, Any]:
    """Competitive rankings: top drivers by coin balance."""
    conn = _conn(request)
    rows = conn.execute(
        "SELECT user_id, COALESCE(SUM(amount), 0) AS balance "
        "FROM ledger GROUP BY user_id ORDER BY balance DESC LIMIT ?",
        (limit,),
    ).fetchall()
    out = []
    for rank, r in enumerate(rows, 1):
        # Enrich with activity counts.
        cells = conn.execute(
            "SELECT COUNT(DISTINCT cell) AS n FROM events e "
            "JOIN devices d ON e.device_id = d.device_id WHERE d.user_id = ?",
            (r["user_id"],),
        ).fetchone()["n"]
        hazards = conn.execute(
            "SELECT COUNT(DISTINCT hr.hazard_id) AS n FROM hazard_reports hr "
            "WHERE hr.user_id = ?",
            (r["user_id"],),
        ).fetchone()["n"]
        out.append({"rank": rank, "user_id": r["user_id"],
                    "balance": int(r["balance"]),
                    "cells_mapped": cells, "hazards_reported": hazards})
    return {"leaderboard": out}


@app.get("/api/v1/stats")
def platform_stats(request: Request) -> dict[str, Any]:
    """Platform-wide statistics for the authority/overview dashboard."""
    conn = _conn(request)
    total_events = conn.execute("SELECT COUNT(*) AS n FROM events").fetchone()["n"]
    total_devices = conn.execute("SELECT COUNT(*) AS n FROM devices").fetchone()["n"]
    total_cells = conn.execute("SELECT COUNT(*) AS n FROM cells").fetchone()["n"]
    hz = conn.execute(
        "SELECT status, COUNT(*) AS n FROM hazards GROUP BY status"
    ).fetchall()
    hz_map = {r["status"]: r["n"] for r in hz}
    total_coins = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) AS n FROM ledger"
    ).fetchone()["n"]
    return {"stats": {
        "total_events": total_events,
        "total_hazards": sum(hz_map.values()),
        "confirmed_hazards": hz_map.get("CONFIRMED", 0),
        "resolved_hazards": hz_map.get("RESOLVED", 0),
        "pending_hazards": hz_map.get("PENDING", 0),
        "total_devices": total_devices,
        "total_cells_mapped": total_cells,
        "total_coins_awarded": int(total_coins),
    }}



