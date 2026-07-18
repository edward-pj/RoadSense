"""Endpoint tests: every /api/v1 route, error envelope, route compare."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from cloud import db
from cloud.app import app

LAT, LNG = 28.5355, 77.3910


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(db, "DB_PATH", ":memory:")
    with TestClient(app) as c:
        yield c


def _seed_confirmed(client: TestClient) -> int:
    """Three devices report the same pothole -> CONFIRMED; returns hazard id."""
    for i in range(1, 4):
        client.post("/api/v1/devices",
                    json={"device_id": f"d{i}", "user_id": f"u{i}"})
        r = client.post("/api/v1/events", json=[{
            "device_id": f"d{i}", "seq": 1, "ts": 1000.0, "lat": LAT,
            "lng": LNG, "road_class": "pothole", "severity": 7.0,
            "speed_kmh": 30.0}])
        assert r.status_code == 200
    hazards = client.get("/api/v1/hazards").json()["hazards"]
    assert hazards[0]["status"] == "CONFIRMED"
    return hazards[0]["id"]


def test_health(client: TestClient) -> None:
    assert client.get("/health").json() == {"status": "ok"}


def test_event_flow_confirms_and_pays(client: TestClient) -> None:
    _seed_confirmed(client)
    rw = client.get("/api/v1/rewards/u1").json()
    assert rw["balance"] > 0
    reasons = {h["reason"] for h in rw["history"]}
    assert "hazard_confirmed" in reasons


def test_batch_ingest_reports_duplicates(client: TestClient) -> None:
    client.post("/api/v1/devices", json={"device_id": "d1", "user_id": "u1"})
    evt = {"device_id": "d1", "seq": 5, "ts": 1.0, "lat": LAT, "lng": LNG,
           "road_class": "smooth", "severity": 0.0, "speed_kmh": 20.0}
    assert client.post("/api/v1/events", json=[evt]).json()["accepted"] == 1
    assert client.post("/api/v1/events", json=[evt]).json()["accepted"] == 0


def test_vote_endpoint(client: TestClient) -> None:
    hz = _seed_confirmed(client)
    r = client.post(f"/api/v1/hazards/{hz}/vote",
                    json={"user_id": "voter", "vote": "confirm"})
    assert r.json()["votes"] == {"confirm": 1}


def test_missions_endpoint(client: TestClient) -> None:
    _seed_confirmed(client)
    missions = client.get("/api/v1/missions/u1").json()["missions"]
    first = next(m for m in missions if m["id"] == "first_report")
    assert first["completed"]


def test_hotspots_ranked(client: TestClient) -> None:
    _seed_confirmed(client)
    hs = client.get("/api/v1/authority/hotspots").json()["hotspots"]
    assert hs and hs[0]["priority"] > 0


def test_route_compare(client: TestClient) -> None:
    _seed_confirmed(client)
    r = client.get("/api/v1/route", params={
        "from_lat": LAT - 0.01, "from_lng": LNG - 0.01,
        "to_lat": LAT + 0.01, "to_lng": LNG + 0.01}).json()
    assert r["fastest"]["distance_km"] > 0
    assert len(r["smoothest"]["polyline"]) == len(r["fastest"]["polyline"])
    assert r["smoothest"]["hazards_on_route"] <= r["fastest"]["hazards_on_route"]


def test_validation_error_shape(client: TestClient) -> None:
    r = client.post("/api/v1/events", json=[{"device_id": "d1"}])
    assert r.status_code == 422  # FastAPI validation envelope





def test_leaderboard(client: TestClient) -> None:
    _seed_confirmed(client)
    r = client.get("/api/v1/leaderboard").json()
    lb = r["leaderboard"]
    assert len(lb) >= 1
    assert lb[0]["rank"] == 1
    assert lb[0]["balance"] > 0
    assert "cells_mapped" in lb[0]
    assert "hazards_reported" in lb[0]


def test_stats(client: TestClient) -> None:
    _seed_confirmed(client)
    r = client.get("/api/v1/stats").json()
    s = r["stats"]
    assert s["total_events"] >= 3
    assert s["total_devices"] >= 3
    assert s["confirmed_hazards"] >= 1
    assert s["total_cells_mapped"] >= 1
    assert s["total_coins_awarded"] > 0
