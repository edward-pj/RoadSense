"""Quality-aware routing v1: fastest vs smoothest corridor comparison.

v1 deliberately avoids a full OSM road graph (future work, documented in
README): it samples the straight corridor between two points, counts
confirmed hazards near each sample via H3 rings, and for the "smooth"
route applies small lateral detours away from hazardous cells. Honest,
demoable, and unit-testable; swaps for OSMnx graph routing later without
touching the API shape.
"""

from __future__ import annotations

import math
import sqlite3
from typing import Any

import h3

from .hazards import H3_RESOLUTION

SAMPLES = 40
DETOUR_DEG = 0.0006          # ~60 m lateral shift when dodging a hazard
NEAR_RING = 2                # h3 grid_disk radius counted as "on the route"
SPEED_KMH = 40.0
SMOOTH_TIME_PENALTY = 1.08   # detours cost ~8% extra time


def _hazard_cells(conn: sqlite3.Connection) -> dict[str, float]:
    """CONFIRMED hazard cells -> mean severity."""
    return {
        r["cell"]: r["severity_sum"] / max(r["report_count"], 1)
        for r in conn.execute(
            "SELECT cell, severity_sum, report_count FROM hazards "
            "WHERE status = 'CONFIRMED'"
        ).fetchall()
    }


def _near_hazard(lat: float, lng: float, cells: dict[str, float]) -> float:
    """Max severity of any confirmed hazard within NEAR_RING cells, else 0."""
    here = h3.latlng_to_cell(lat, lng, H3_RESOLUTION)
    return max((cells[c] for c in h3.grid_disk(here, NEAR_RING) if c in cells),
               default=0.0)


def _distance_km(points: list[tuple[float, float]]) -> float:
    total = 0.0
    for (lat1, lng1), (lat2, lng2) in zip(points, points[1:]):
        dlat = math.radians(lat2 - lat1)
        dlng = math.radians(lng2 - lng1)
        a = (math.sin(dlat / 2) ** 2
             + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
             * math.sin(dlng / 2) ** 2)
        total += 6371 * 2 * math.asin(math.sqrt(a))
    return total


def compare_routes(conn: sqlite3.Connection, from_lat: float, from_lng: float,
                   to_lat: float, to_lng: float) -> dict[str, Any]:
    """Fastest (straight corridor) vs smoothest (hazard-dodging) comparison."""
    cells = _hazard_cells(conn)

    fastest: list[tuple[float, float]] = []
    smoothest: list[tuple[float, float]] = []
    hazards_fast = hazards_smooth = 0

    # Perpendicular unit direction for lateral detours.
    dlat, dlng = to_lat - from_lat, to_lng - from_lng
    norm = math.hypot(dlat, dlng) or 1.0
    perp = (-dlng / norm, dlat / norm)

    for i in range(SAMPLES + 1):
        t = i / SAMPLES
        lat = from_lat + dlat * t
        lng = from_lng + dlng * t
        fastest.append((lat, lng))

        sev = _near_hazard(lat, lng, cells)
        if sev > 0:
            hazards_fast += 1
            # Try dodging to either side; keep the cleaner one.
            for sign in (1, -1):
                dl = lat + sign * perp[0] * DETOUR_DEG
                dg = lng + sign * perp[1] * DETOUR_DEG
                if _near_hazard(dl, dg, cells) < sev:
                    smoothest.append((dl, dg))
                    break
            else:
                smoothest.append((lat, lng))
                hazards_smooth += 1
        else:
            smoothest.append((lat, lng))

    def leg(points: list[tuple[float, float]], hazard_count: int,
            penalty: float = 1.0) -> dict[str, Any]:
        dist = _distance_km(points)
        return {
            "polyline": [[round(la, 6), round(ln, 6)] for la, ln in points],
            "distance_km": round(dist, 2),
            "eta_min": round(dist / SPEED_KMH * 60 * penalty, 1),
            "hazards_on_route": hazard_count,
        }

    fast = leg(fastest, hazards_fast)
    smooth = leg(smoothest, hazards_smooth, SMOOTH_TIME_PENALTY)
    return {
        "fastest": fast,
        "smoothest": smooth,
        "summary": (f"+{max(smooth['eta_min'] - fast['eta_min'], 0):.0f} min, "
                    f"avoids {max(hazards_fast - hazards_smooth, 0)} hazards"),
    }
