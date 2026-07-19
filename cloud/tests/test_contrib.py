"""Tests for the composed per-user contribution rollup (cloud/contrib.py)."""

from __future__ import annotations

import sqlite3
import time

import pytest

from cloud import contrib, db, hazards

LAT, LNG = 28.5355, 77.3910


@pytest.fixture()
def conn() -> sqlite3.Connection:
    c = db.connect(":memory:")
    for i in range(1, 6):
        hazards.register_device(c, f"dev{i}", f"user{i}")
    return c


def _event(device: str, seq: int, road_class: str = "pothole",
           lat: float = LAT, lng: float = LNG, ts: float | None = None) -> dict:
    return {"device_id": device, "seq": seq, "ts": ts if ts is not None else time.time(),
            "lat": lat, "lng": lng, "road_class": road_class,
            "severity": 7.0, "speed_kmh": 30.0}


def test_empty_user_rollup_is_zeroed(conn: sqlite3.Connection) -> None:
    c = contrib.contribution(conn, "nobody")
    assert c["coins"] == 0
    assert c["events_contributed"] == 0
    assert c["hazards_confirmed_by_you"] == 0
    assert c["hazards_repaired"] == 0
    assert c["badges"] == []
    assert c["repairs"] == []


def test_rollup_counts_events_coins_and_confirmation(conn: sqlite3.Connection) -> None:
    # user1 maps a fresh cell (earns the new-cell coin) then 3 devices confirm.
    hazards.ingest_event(conn, _event("dev1", 1))
    hazards.ingest_event(conn, _event("dev2", 1))
    hazards.ingest_event(conn, _event("dev3", 1))  # -> CONFIRMED, all 3 paid

    c = contrib.contribution(conn, "user1")
    assert c["coins"] > 0
    assert c["events_contributed"] == 1
    assert c["km_mapped"] == 1                 # one distinct cell mapped this month
    assert c["hazards_confirmed_by_you"] == 1
    assert c["hazards_repaired"] == 0
    assert c["hero_unit"] == "cells"
    assert c["rank"] is not None


def test_rollup_surfaces_repairs_after_autoclear(conn: sqlite3.Connection) -> None:
    for dev in ("dev1", "dev2", "dev3"):
        hazards.ingest_event(conn, _event(dev, 1))          # CONFIRMED
    for seq in range(10, 15):
        hazards.ingest_event(conn, _event("dev4", seq, road_class="smooth"))  # RESOLVED

    c1 = contrib.contribution(conn, "user1")
    assert c1["hazards_repaired"] == 1
    assert len(c1["repairs"]) == 1
    assert c1["repairs"][0]["cls"] == "pothole"
    assert c1["repairs"][0]["your_reports"] == 1


def test_badges_come_from_completed_missions(conn: sqlite3.Connection) -> None:
    from cloud import rewards
    for _ in range(5):
        rewards.bump_metric(conn, "user1", "cells_mapped")   # completes map_5_cells
    c = contrib.contribution(conn, "user1")
    assert any(b["id"] == "map_5_cells" for b in c["badges"])
