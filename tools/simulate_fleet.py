"""Seed the cloud with a simulated fleet over the Noida road network.

You have one rig; the story is a thousand cars. This bridges that gap
HONESTLY: the data is clearly labeled simulated (device ids sim-*), stated
in the README, and said out loud in the demo.

  python tools/simulate_fleet.py --cloud http://localhost:8000
  python tools/simulate_fleet.py --cloud http://localhost:8000 --resolve-demo

--resolve-demo additionally drives 5 clean passes over 3 hazards so the
auto-clear beat is visible when scrubbing the dashboard.
"""

from __future__ import annotations

import argparse
import random
import time

import httpx

# Noida-Greater Noida Expressway / Sector 135 corridor (the judges' commute).
CORRIDOR = [
    (28.5672, 77.3315), (28.5601, 77.3421), (28.5535, 77.3527),
    (28.5471, 77.3633), (28.5410, 77.3737), (28.5355, 77.3910),
    (28.5289, 77.4021), (28.5170, 77.4133), (28.5041, 77.4249),
]
N_VEHICLES = 200
EVENTS_PER_VEHICLE = 50
N_HAZARD_CLUSTERS = 30
CLASSES = ("pothole", "speed_breaker", "rough_patch")


def lerp(a: tuple[float, float], b: tuple[float, float], t: float) -> tuple[float, float]:
    return a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t


def corridor_point(rng: random.Random) -> tuple[float, float]:
    i = rng.randrange(len(CORRIDOR) - 1)
    lat, lng = lerp(CORRIDOR[i], CORRIDOR[i + 1], rng.random())
    return lat + rng.gauss(0, 1e-4), lng + rng.gauss(0, 1e-4)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cloud", default="http://localhost:8000")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--resolve-demo", action="store_true")
    args = ap.parse_args()
    rng = random.Random(args.seed)
    client = httpx.Client(base_url=args.cloud, timeout=30)

    hazard_spots = [(corridor_point(rng), rng.choice(CLASSES))
                    for _ in range(N_HAZARD_CLUSTERS)]

    now = time.time()
    for v in range(N_VEHICLES):
        device = f"sim-{v:04d}"
        client.post("/api/v1/devices", json={
            "device_id": device, "user_id": f"sim-user-{v:04d}",
            "vehicle_type": rng.choice(["2wheeler", "hatchback", "suv"]),
        })
        batch = []
        for seq in range(EVENTS_PER_VEHICLE):
            if rng.random() < 0.35:  # drive over a known hazard cluster
                (lat, lng), cls = rng.choice(hazard_spots)
                lat += rng.gauss(0, 3e-5)
                lng += rng.gauss(0, 3e-5)
                severity = rng.uniform(4, 9)
            else:                    # background smooth driving
                lat, lng = corridor_point(rng)
                cls, severity = "smooth", 0.0
            batch.append({
                "device_id": device, "seq": seq,
                "ts": now - rng.uniform(0, 14 * 86400),
                "lat": round(lat, 6), "lng": round(lng, 6),
                "road_class": cls, "severity": round(severity, 1),
                "speed_kmh": round(rng.uniform(15, 80), 1),
            })
        r = client.post("/api/v1/events", json=batch)
        r.raise_for_status()
        if v % 40 == 0:
            print(f"vehicle {v}/{N_VEHICLES} seeded")

    hz = client.get("/api/v1/hazards").json()["hazards"]
    confirmed = [h for h in hz if h["status"] == "CONFIRMED"]
    print(f"seeded: {len(hz)} hazards, {len(confirmed)} confirmed")

    if args.resolve_demo and confirmed:
        # 5 clean passes over 3 confirmed hazards -> visible auto-clear beat.
        for i, h in enumerate(confirmed[:3]):
            device = f"sim-repair-{i}"
            client.post("/api/v1/devices",
                        json={"device_id": device, "user_id": device})
            batch = [{"device_id": device, "seq": s, "ts": now,
                      "lat": h["lat"], "lng": h["lng"], "road_class": "smooth",
                      "severity": 0.0, "speed_kmh": 40.0} for s in range(5)]
            client.post("/api/v1/events", json=batch).raise_for_status()
        remaining = client.get("/api/v1/hazards").json()["hazards"]
        print(f"auto-clear demo: {len(confirmed) - len([h for h in remaining if h['status'] == 'CONFIRMED'])} hazards resolved")

    top = client.get("/api/v1/authority/hotspots?limit=5").json()["hotspots"]
    print("top hotspots:")
    for h in top:
        print(f"  {h['road_class']:14s} sev={h['severity']} reports={h['reports']} "
              f"priority={h['priority']} @ {h['lat']:.5f},{h['lng']:.5f}")


if __name__ == "__main__":
    main()
