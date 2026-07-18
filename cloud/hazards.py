"""Fleet fusion: H3 clustering, crowd verification, auto-clear, hotspots.

Rules (see ARCHITECTURE.md):
- Events land in H3 res-12 cells (~9 m).
- A hazard flips PENDING -> CONFIRMED when >= 3 distinct devices report it.
- A CONFIRMED hazard flips -> RESOLVED after 5 consecutive clean passes.
- Coins: first mapper of a cell, and every distinct reporter on confirmation.
"""

from __future__ import annotations

import logging
import math
import sqlite3
import time
from typing import Any

import h3

from . import rewards

log = logging.getLogger("roadsense.hazards")

H3_RESOLUTION = 12
CONFIRM_DEVICES = 3
AUTOCLEAR_PASSES = 5
HAZARD_CLASSES = {"pothole", "speed_breaker", "rough_patch"}


def register_device(conn: sqlite3.Connection, device_id: str, user_id: str,
                    vehicle_type: str = "hatchback") -> None:
    """Idempotently attach a device to a user."""
    conn.execute(
        "INSERT OR IGNORE INTO devices (device_id, user_id, vehicle_type) VALUES (?, ?, ?)",
        (device_id, user_id, vehicle_type),
    )


def ingest_event(conn: sqlite3.Connection, evt: dict[str, Any]) -> dict[str, Any]:
    """Ingest one classified road event; returns what happened.

    Idempotent on (device_id, seq) so offline-sync replays never double count.
    """
    cell = h3.latlng_to_cell(evt["lat"], evt["lng"], H3_RESOLUTION)
    try:
        conn.execute(
            "INSERT INTO events (device_id, seq, ts, lat, lng, cell, road_class, severity, speed_kmh) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (evt["device_id"], evt["seq"], evt["ts"], evt["lat"], evt["lng"],
             cell, evt["road_class"], evt["severity"], evt["speed_kmh"]),
        )
    except sqlite3.IntegrityError:
        return {"cell": cell, "duplicate": True}

    user_id = _user_for(conn, evt["device_id"])
    result: dict[str, Any] = {"cell": cell, "duplicate": False, "new_cell": False,
                              "hazard_status": None}

    # Cell aggregate; first-ever mapper earns the exploration coin.
    conn.execute(
        "INSERT INTO cells (cell, sample_count, severity_sum, first_device, first_user, last_seen) "
        "VALUES (?, 1, ?, ?, ?, ?) "
        "ON CONFLICT (cell) DO UPDATE SET sample_count = sample_count + 1, "
        "severity_sum = severity_sum + excluded.severity_sum, last_seen = excluded.last_seen",
        (cell, evt["severity"], evt["device_id"], user_id, evt["ts"]),
    )
    if conn.execute(
        "SELECT sample_count FROM cells WHERE cell = ?", (cell,)
    ).fetchone()["sample_count"] == 1:
        result["new_cell"] = True
        rewards.award(conn, user_id, rewards.COIN_NEW_CELL, "cell_mapped", cell)
        rewards.bump_metric(conn, user_id, "cells_mapped")

    if evt["road_class"] in HAZARD_CLASSES:
        result["hazard_status"] = _report_hazard(conn, cell, evt, user_id)
    else:
        _record_clean_pass(conn, cell, evt["device_id"])

    return result


def _user_for(conn: sqlite3.Connection, device_id: str) -> str:
    row = conn.execute(
        "SELECT user_id FROM devices WHERE device_id = ?", (device_id,)
    ).fetchone()
    return row["user_id"] if row else device_id


def _report_hazard(conn: sqlite3.Connection, cell: str, evt: dict[str, Any],
                   user_id: str) -> str:
    """Upsert the hazard, add a report, run the confirmation rule."""
    conn.execute(
        "INSERT INTO hazards (cell, road_class, severity_sum, report_count) "
        "VALUES (?, ?, 0, 0) ON CONFLICT (cell, road_class) DO NOTHING",
        (cell, evt["road_class"]),
    )
    hz = conn.execute(
        "SELECT id, status FROM hazards WHERE cell = ? AND road_class = ?",
        (cell, evt["road_class"]),
    ).fetchone()
    conn.execute(
        "UPDATE hazards SET severity_sum = severity_sum + ?, report_count = report_count + 1, "
        "clean_passes = 0 WHERE id = ?",
        (evt["severity"], hz["id"]),
    )
    conn.execute(
        "INSERT INTO hazard_reports (hazard_id, device_id, user_id, severity, ts) "
        "VALUES (?, ?, ?, ?, ?)",
        (hz["id"], evt["device_id"], user_id, evt["severity"], evt["ts"]),
    )
    rewards.bump_metric(conn, user_id, "hazards_reported")

    if hz["status"] == "PENDING":
        distinct = conn.execute(
            "SELECT COUNT(DISTINCT device_id) AS n FROM hazard_reports WHERE hazard_id = ?",
            (hz["id"],),
        ).fetchone()["n"]
        if distinct >= CONFIRM_DEVICES:
            conn.execute(
                "UPDATE hazards SET status = 'CONFIRMED', confirmed_at = ? WHERE id = ?",
                (time.time(), hz["id"]),
            )
            log.info("hazard confirmed id=%d cell=%s class=%s devices=%d",
                     hz["id"], cell, evt["road_class"], distinct)
            for r in conn.execute(
                "SELECT DISTINCT user_id FROM hazard_reports WHERE hazard_id = ?",
                (hz["id"],),
            ).fetchall():
                rewards.award(conn, r["user_id"], rewards.COIN_HAZARD_CONFIRMED,
                              "hazard_confirmed", str(hz["id"]))
                rewards.bump_metric(conn, r["user_id"], "hazards_confirmed")
            return "CONFIRMED"
    return str(hz["status"])


def _record_clean_pass(conn: sqlite3.Connection, cell: str, device_id: str) -> None:
    """A smooth drive through a cell counts toward auto-clearing its hazards."""
    for hz in conn.execute(
        "SELECT id, clean_passes FROM hazards WHERE cell = ? AND status = 'CONFIRMED'",
        (cell,),
    ).fetchall():
        passes = hz["clean_passes"] + 1
        if passes >= AUTOCLEAR_PASSES:
            conn.execute(
                "UPDATE hazards SET status = 'RESOLVED', resolved_at = ?, clean_passes = ? "
                "WHERE id = ?", (time.time(), passes, hz["id"]),
            )
            log.info("hazard auto-cleared id=%d cell=%s", hz["id"], cell)
        else:
            conn.execute(
                "UPDATE hazards SET clean_passes = ? WHERE id = ?", (passes, hz["id"]),
            )


def vote(conn: sqlite3.Connection, hazard_id: int, user_id: str, choice: str) -> dict[str, Any]:
    """Waze-style manual vote. One vote per user per hazard; matching votes
    on a later-confirmed hazard earn a small coin reward."""
    conn.execute(
        "INSERT OR REPLACE INTO hazard_votes (hazard_id, user_id, vote, ts) "
        "VALUES (?, ?, ?, ?)", (hazard_id, user_id, choice, time.time()),
    )
    hz = conn.execute("SELECT status FROM hazards WHERE id = ?", (hazard_id,)).fetchone()
    if hz and hz["status"] == "CONFIRMED" and choice == "confirm":
        rewards.award(conn, user_id, rewards.COIN_VOTE_ON_CONFIRMED,
                      "vote_confirmed", str(hazard_id))
    counts = conn.execute(
        "SELECT vote, COUNT(*) AS n FROM hazard_votes WHERE hazard_id = ? GROUP BY vote",
        (hazard_id,),
    ).fetchall()
    return {r["vote"]: r["n"] for r in counts}


def list_hazards(conn: sqlite3.Connection, statuses: tuple[str, ...] = ("PENDING", "CONFIRMED")) -> list[dict[str, Any]]:
    """Hazards with derived lat/lng, mean severity, and last-report time."""
    out = []
    for hz in conn.execute(
        "SELECT *, (SELECT MAX(ts) FROM hazard_reports WHERE hazard_id = hazards.id) "
        f"AS last_ts FROM hazards WHERE status IN ({','.join('?' * len(statuses))})",
        statuses,
    ).fetchall():
        lat, lng = h3.cell_to_latlng(hz["cell"])
        out.append({
            "id": hz["id"], "cell": hz["cell"], "lat": lat, "lng": lng,
            "road_class": hz["road_class"], "status": hz["status"],
            "severity": round(hz["severity_sum"] / max(hz["report_count"], 1), 1),
            "reports": hz["report_count"],
            "last_seen": _iso(hz["last_ts"]) if hz["last_ts"] else None,
        })
    return out


def _iso(ts: float) -> str:
    """Unix seconds -> UTC ISO-8601 (Z), for JSON timestamps."""
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _report_trend(conn: sqlite3.Connection, hazard_id: int, now: float, days: int = 7) -> list[int]:
    """Report counts per day over the last `days`, oldest -> newest.

    Real signal for the dashboard sparkline: how report volume on a hazard has
    moved this week (a rising trend = worsening, falling = self-clearing).
    """
    start = now - days * 86400
    buckets = [0] * days
    for row in conn.execute(
        "SELECT ts FROM hazard_reports WHERE hazard_id = ? AND ts >= ?",
        (hazard_id, start),
    ).fetchall():
        idx = min(days - 1, max(0, int((row["ts"] - start) // 86400)))
        buckets[idx] += 1
    return buckets


def hotspots(conn: sqlite3.Connection, limit: int = 20) -> list[dict[str, Any]]:
    """Ranked repair-priority list for the authority dashboard.

    priority = mean severity x log(1 + reports) x age factor (older = worse).
    """
    now = time.time()
    out = []
    for hz in conn.execute(
        "SELECT * FROM hazards WHERE status = 'CONFIRMED'"
    ).fetchall():
        mean_sev = hz["severity_sum"] / max(hz["report_count"], 1)
        age_days = max((now - (hz["confirmed_at"] or now)) / 86400, 0)
        priority = mean_sev * math.log1p(hz["report_count"]) * (1 + age_days / 14)
        lat, lng = h3.cell_to_latlng(hz["cell"])
        out.append({
            "id": hz["id"], "cell": hz["cell"], "lat": lat, "lng": lng,
            "road_class": hz["road_class"],
            "severity": round(mean_sev, 1), "reports": hz["report_count"],
            "priority": round(priority, 2),
            "trend": _report_trend(conn, hz["id"], now),
        })
    out.sort(key=lambda h: h["priority"], reverse=True)
    return out[:limit]
