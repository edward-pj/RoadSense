"""Deterministic tests for the fusion + rewards core.

Covers: ingest idempotency, new-cell coin, 3-device confirmation payout,
5-pass auto-clear, mission completion, ledger replay safety.
"""

from __future__ import annotations

import sqlite3

import pytest

from cloud import db, hazards, rewards

LAT, LNG = 28.5355, 77.3910  # Noida Sector 135


@pytest.fixture()
def conn() -> sqlite3.Connection:
    c = db.connect(":memory:")
    for i in range(1, 5):
        hazards.register_device(c, f"dev{i}", f"user{i}")
    return c


def _event(device: str, seq: int, road_class: str = "pothole",
           lat: float = LAT, lng: float = LNG) -> dict:
    return {"device_id": device, "seq": seq, "ts": 1000.0 + seq, "lat": lat,
            "lng": lng, "road_class": road_class, "severity": 7.0, "speed_kmh": 30.0}


def test_duplicate_events_are_ignored(conn: sqlite3.Connection) -> None:
    assert not hazards.ingest_event(conn, _event("dev1", 1))["duplicate"]
    assert hazards.ingest_event(conn, _event("dev1", 1))["duplicate"]
    assert conn.execute("SELECT COUNT(*) AS n FROM events").fetchone()["n"] == 1


def test_first_mapper_earns_new_cell_coins(conn: sqlite3.Connection) -> None:
    # smooth event isolates the mapping coin from hazard-mission bonuses
    r = hazards.ingest_event(conn, _event("dev1", 1, road_class="smooth"))
    assert r["new_cell"]
    assert rewards.balance(conn, "user1") == rewards.COIN_NEW_CELL
    # Second vehicle in the same cell earns nothing for mapping.
    r2 = hazards.ingest_event(conn, _event("dev2", 1, road_class="smooth"))
    assert not r2["new_cell"]
    assert rewards.balance(conn, "user2") == 0


def test_three_devices_confirm_and_all_reporters_paid(conn: sqlite3.Connection) -> None:
    assert hazards.ingest_event(conn, _event("dev1", 1))["hazard_status"] == "PENDING"
    assert hazards.ingest_event(conn, _event("dev2", 1))["hazard_status"] == "PENDING"
    assert hazards.ingest_event(conn, _event("dev3", 1))["hazard_status"] == "CONFIRMED"
    for user in ("user1", "user2", "user3"):
        assert any(h["reason"] == "hazard_confirmed"
                   for h in rewards.history(conn, user)), user
    # Same device reporting repeatedly must NOT confirm.
    c2 = db.connect(":memory:")
    hazards.register_device(c2, "solo", "solo_user")
    for seq in range(1, 6):
        status = hazards.ingest_event(c2, _event("solo", seq))["hazard_status"]
    assert status == "PENDING"


def test_five_clean_passes_resolve_confirmed_hazard(conn: sqlite3.Connection) -> None:
    for i, dev in enumerate(("dev1", "dev2", "dev3"), start=1):
        hazards.ingest_event(conn, _event(dev, 1))
    for seq in range(10, 15):
        hazards.ingest_event(conn, _event("dev4", seq, road_class="smooth"))
    hz = conn.execute("SELECT status FROM hazards").fetchone()
    assert hz["status"] == "RESOLVED"


def test_new_report_resets_clean_pass_counter(conn: sqlite3.Connection) -> None:
    for dev in ("dev1", "dev2", "dev3"):
        hazards.ingest_event(conn, _event(dev, 1))
    for seq in range(10, 13):  # 3 clean passes
        hazards.ingest_event(conn, _event("dev4", seq, road_class="smooth"))
    hazards.ingest_event(conn, _event("dev1", 99))  # re-reported -> reset
    assert conn.execute("SELECT clean_passes FROM hazards").fetchone()["clean_passes"] == 0


def test_award_is_idempotent(conn: sqlite3.Connection) -> None:
    assert rewards.award(conn, "user1", 10, "cell_mapped", "cellX")
    assert not rewards.award(conn, "user1", 10, "cell_mapped", "cellX")
    assert rewards.balance(conn, "user1") == 10


def test_mission_completes_once_and_pays_bonus(conn: sqlite3.Connection) -> None:
    for i in range(5):
        rewards.bump_metric(conn, "user1", "cells_mapped")
    missions = {m["id"]: m for m in rewards.mission_status(conn, "user1")}
    assert missions["map_5_cells"]["completed"]
    bonus_rows = [h for h in rewards.history(conn, "user1")
                  if h["reason"] == "mission_complete" and h["ref"] == "map_5_cells"]
    assert len(bonus_rows) == 1
    rewards.bump_metric(conn, "user1", "cells_mapped")  # no double bonus
    assert len([h for h in rewards.history(conn, "user1")
                if h["reason"] == "mission_complete" and h["ref"] == "map_5_cells"]) == 1


def test_vote_counts_and_reward_on_confirmed(conn: sqlite3.Connection) -> None:
    for dev in ("dev1", "dev2", "dev3"):
        hazards.ingest_event(conn, _event(dev, 1))
    hz_id = conn.execute("SELECT id FROM hazards").fetchone()["id"]
    counts = hazards.vote(conn, hz_id, "user4", "confirm")
    assert counts == {"confirm": 1}
    assert rewards.balance(conn, "user4") == rewards.COIN_VOTE_ON_CONFIRMED
