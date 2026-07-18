"""Coin-based incentive system: append-only ledger + missions.

Design rules:
- Every award is one ledger row with a unique idempotency key, so retries
  and offline-sync replays can never double-pay.
- Balances are derived (SUM over ledger), never stored/mutated.
- Missions are config-defined counters; crossing the target pays a one-time
  bonus through the same ledger path.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from typing import Any

log = logging.getLogger("roadsense.rewards")

COIN_NEW_CELL = 10          # first vehicle ever to map an H3 cell
COIN_HAZARD_CONFIRMED = 5   # paid to each distinct reporter when a hazard confirms
COIN_VOTE_ON_CONFIRMED = 2  # manual Waze-style vote that matches the outcome

MISSIONS: list[dict[str, Any]] = [
    {"id": "map_5_cells", "title": "Trailblazer: map 5 unmapped road cells",
     "metric": "cells_mapped", "target": 5, "bonus": 50},
    {"id": "map_25_cells", "title": "Cartographer: map 25 unmapped road cells",
     "metric": "cells_mapped", "target": 25, "bonus": 200},
    {"id": "confirm_3_hazards", "title": "Verifier: help confirm 3 hazards",
     "metric": "hazards_confirmed", "target": 3, "bonus": 30},
    {"id": "first_report", "title": "First responder: report your first hazard",
     "metric": "hazards_reported", "target": 1, "bonus": 15},
]


def award(conn: sqlite3.Connection, user_id: str, amount: int,
          reason: str, ref: str) -> bool:
    """Append one ledger row. Returns False if the idempotency key already
    exists (replay), True if coins were actually awarded."""
    idem_key = f"{user_id}:{reason}:{ref}"
    try:
        conn.execute(
            "INSERT INTO ledger (user_id, amount, reason, ref, idem_key, ts) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, amount, reason, ref, idem_key, time.time()),
        )
    except sqlite3.IntegrityError:
        return False
    log.info("award user=%s amount=%d reason=%s ref=%s", user_id, amount, reason, ref)
    return True


def balance(conn: sqlite3.Connection, user_id: str) -> int:
    """Derived coin balance for a user."""
    row = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) AS bal FROM ledger WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    return int(row["bal"])


def history(conn: sqlite3.Connection, user_id: str, limit: int = 50) -> list[dict[str, Any]]:
    """Most recent ledger entries for a user."""
    rows = conn.execute(
        "SELECT amount, reason, ref, ts FROM ledger "
        "WHERE user_id = ? ORDER BY id DESC LIMIT ?",
        (user_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def bump_metric(conn: sqlite3.Connection, user_id: str, metric: str, n: int = 1) -> None:
    """Advance every mission tracking `metric`; pay bonus on completion."""
    for mission in MISSIONS:
        if mission["metric"] != metric:
            continue
        conn.execute(
            "INSERT INTO mission_progress (user_id, mission_id, progress) "
            "VALUES (?, ?, ?) "
            "ON CONFLICT (user_id, mission_id) DO UPDATE SET progress = progress + ?",
            (user_id, mission["id"], n, n),
        )
        row = conn.execute(
            "SELECT progress, completed_at FROM mission_progress "
            "WHERE user_id = ? AND mission_id = ?",
            (user_id, mission["id"]),
        ).fetchone()
        if row["completed_at"] is None and row["progress"] >= mission["target"]:
            conn.execute(
                "UPDATE mission_progress SET completed_at = ? "
                "WHERE user_id = ? AND mission_id = ?",
                (time.time(), user_id, mission["id"]),
            )
            award(conn, user_id, mission["bonus"], "mission_complete", mission["id"])


def mission_status(conn: sqlite3.Connection, user_id: str) -> list[dict[str, Any]]:
    """All missions with this user's progress merged in."""
    progress = {
        r["mission_id"]: r
        for r in conn.execute(
            "SELECT mission_id, progress, completed_at FROM mission_progress "
            "WHERE user_id = ?", (user_id,)
        ).fetchall()
    }
    out = []
    for m in MISSIONS:
        p = progress.get(m["id"])
        out.append({
            **{k: m[k] for k in ("id", "title", "target", "bonus")},
            "progress": min(p["progress"], m["target"]) if p else 0,
            "completed": bool(p and p["completed_at"]),
        })
    return out
