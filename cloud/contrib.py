"""Per-user contribution aggregate for the driver "Your impact" screen.

The mobile Contribution screen needs a single per-user rollup (coins, events
sensed, hazards confirmed/repaired, badges, recent repairs, rank). Rather than
have the client fan out across /rewards, /leaderboard, /hazards and stitch the
result together on the phone, this module composes it server-side in a handful
of indexed queries — one round-trip for the client, and the same code runs on
the cloud and on the X Elite local mirror (edge-first rule).

Every field is derived from real ledger/event/hazard state. Nothing is
fabricated; where the platform genuinely does not track a quantity (road
distance in km), the screen reports mapped H3 cells instead and says so.
"""

from __future__ import annotations

import math
import sqlite3
import time
from typing import Any

import h3

from . import rewards

REGION = "Noida"          # demo geography; the fleet corridor is Sector 62–135
MONTHLY_GOAL_CELLS = 300  # ring goal for "mapped this month" (distinct cells)


def _month_start(now: float) -> float:
    """Unix timestamp of 00:00 on the 1st of the current month (local time)."""
    t = time.localtime(now)
    return time.mktime((t.tm_year, t.tm_mon, 1, 0, 0, 0, 0, 0, -1))


def _week(now: float) -> tuple[float, list[bool], int]:
    """(start_of_week_ts, 7 day-boundary timestamps Sun..Sat, today index)."""
    t = time.localtime(now)
    midnight = time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))
    today = (t.tm_wday + 1) % 7          # Python Mon=0 -> Sun=0 convention
    week_start = midnight - today * 86400
    bounds = [week_start + i * 86400 for i in range(7)]
    return week_start, bounds, today


def contribution(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    """Compose the full contribution rollup for one user in one call."""
    now = time.time()
    month_start = _month_start(now)

    coins = rewards.balance(conn, user_id)

    # Events + distinct cells this user's devices have sensed (all-time / month).
    events_all = conn.execute(
        "SELECT COUNT(*) AS n FROM events e JOIN devices d ON e.device_id = d.device_id "
        "WHERE d.user_id = ?", (user_id,),
    ).fetchone()["n"]
    cells_month = conn.execute(
        "SELECT COUNT(DISTINCT e.cell) AS n FROM events e "
        "JOIN devices d ON e.device_id = d.device_id "
        "WHERE d.user_id = ? AND e.ts >= ?", (user_id, month_start),
    ).fetchone()["n"]

    # Hazards this user reported that reached CONFIRMED / RESOLVED.
    confirmed = conn.execute(
        "SELECT COUNT(DISTINCT hr.hazard_id) AS n FROM hazard_reports hr "
        "JOIN hazards h ON hr.hazard_id = h.id "
        "WHERE hr.user_id = ? AND h.status IN ('CONFIRMED', 'RESOLVED')",
        (user_id,),
    ).fetchone()["n"]
    repaired = conn.execute(
        "SELECT COUNT(DISTINCT hr.hazard_id) AS n FROM hazard_reports hr "
        "JOIN hazards h ON hr.hazard_id = h.id "
        "WHERE hr.user_id = ? AND h.status = 'RESOLVED'", (user_id,),
    ).fetchone()["n"]

    # Weekly activity strip: which weekdays this user sensed anything.
    week_start, bounds, today = _week(now)
    week_days = [False] * 7
    for row in conn.execute(
        "SELECT e.ts FROM events e JOIN devices d ON e.device_id = d.device_id "
        "WHERE d.user_id = ? AND e.ts >= ?", (user_id, week_start),
    ).fetchall():
        idx = min(6, max(0, int((row["ts"] - week_start) // 86400)))
        week_days[idx] = True
    streak = 0
    for i in range(today, -1, -1):
        if week_days[i]:
            streak += 1
        else:
            break

    return {
        "user_id": user_id,
        "region": REGION,
        "coins": coins,
        "km_mapped": cells_month,          # distinct H3 cells mapped this month
        "hero_unit": "cells",              # honest: platform tracks cells, not km
        "monthly_goal": MONTHLY_GOAL_CELLS,
        "events_contributed": events_all,
        "hazards_confirmed_by_you": confirmed,
        "hazards_repaired": repaired,
        "week_activity": week_days,
        "today_index": today,
        "streak_days": streak,
        "badges": _badges(conn, user_id),
        "repairs": _repairs(conn, user_id),
        **_rank(conn, user_id),
    }


def _badges(conn: sqlite3.Connection, user_id: str) -> list[dict[str, Any]]:
    """Completed missions become earned badges (title + completion time)."""
    titles = {m["id"]: m["title"] for m in rewards.MISSIONS}
    out = []
    for row in conn.execute(
        "SELECT mission_id, completed_at FROM mission_progress "
        "WHERE user_id = ? AND completed_at IS NOT NULL ORDER BY completed_at DESC",
        (user_id,),
    ).fetchall():
        out.append({
            "id": row["mission_id"],
            "label": titles.get(row["mission_id"], row["mission_id"]),
            "earned_at": row["completed_at"],
        })
    return out


def _repairs(conn: sqlite3.Connection, user_id: str, limit: int = 5) -> list[dict[str, Any]]:
    """RESOLVED hazards this user reported, most recently repaired first."""
    out = []
    for row in conn.execute(
        "SELECT h.cell, h.road_class, h.resolved_at, COUNT(hr.id) AS your_reports "
        "FROM hazards h JOIN hazard_reports hr ON hr.hazard_id = h.id "
        "WHERE hr.user_id = ? AND h.status = 'RESOLVED' "
        "GROUP BY h.id ORDER BY h.resolved_at DESC LIMIT ?", (user_id, limit),
    ).fetchall():
        lat, lng = h3.cell_to_latlng(row["cell"])
        out.append({
            "location": f"{lat:.4f}, {lng:.4f}",
            "cls": row["road_class"],
            "repaired_at": row["resolved_at"],
            "your_reports": row["your_reports"],
        })
    return out


def _rank(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    """User's rank by coin balance and rough percentile (lower = better)."""
    rows = conn.execute(
        "SELECT user_id, COALESCE(SUM(amount), 0) AS bal FROM ledger "
        "GROUP BY user_id ORDER BY bal DESC"
    ).fetchall()
    total = len(rows)
    rank = next((i for i, r in enumerate(rows, 1) if r["user_id"] == user_id), None)
    percentile = max(1, math.ceil(rank / total * 100)) if rank and total else None
    return {"rank": rank, "percentile": percentile, "total_users": total}
