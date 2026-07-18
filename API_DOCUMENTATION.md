# RoadSense API Documentation

This document describes the REST and WebSocket APIs exposed by the RoadSense backend. 

The architecture is **edge-first**. The frontend can connect to either:
1. **Cloud Server**: `http://<cloud-ip>:8000`
2. **PC Edge Mirror**: `http://<x-elite-ip>:8100`

Both expose identical core routing and logic. If the PC mirror loses its connection to the Cloud, the frontend will continue to work seamlessly off the local mirror. All endpoints expect and return `application/json`.

---

## 📍 Core Map & Hazards

### `GET /api/v1/hazards`
Retrieves a list of detected road hazards to render on the driver's map.
- **Query Params**: `include_resolved` (boolean, optional, default: false)
- **Response**:
  ```json
  {
    "hazards": [
      {
        "id": 12,
        "cell": "8c392b21c4303ff",
        "lat": 28.5355,
        "lng": 77.3910,
        "road_class": "pothole", 
        "status": "PENDING", // PENDING | CONFIRMED | RESOLVED
        "severity": 6.8, // 0.0 - 10.0
        "reports": 2
      }
    ],
    "source": "cloud" // or "local_mirror"
  }
  ```

### `POST /api/v1/hazards/{hazard_id}/vote`
Records a Waze-style manual verification from a driver.
- **Body**: 
  ```json
  { "user_id": "driver-01", "vote": "confirm" } // "confirm" or "deny"
  ```
- **Response**:
  ```json
  {
    "hazard_id": 12,
    "votes": { "confirm": 3, "deny": 0 }
  }
  ```

---

## 🪙 Economy & Gamification

### `GET /api/v1/rewards/{user_id}`
Retrieves a user's total coin balance and recent earning history.
- **Response**:
  ```json
  {
    "user_id": "driver-01",
    "balance": 150,
    "history": [
      {
        "amount": 10,
        "reason": "cell_mapped",
        "ref": "8c392b21c4303ff",
        "ts": 1718000000.0
      }
    ]
  }
  ```

### `GET /api/v1/missions/{user_id}`
Retrieves a user's progress on gamified missions.
- **Response**:
  ```json
  {
    "user_id": "driver-01",
    "missions": [
      {
        "id": "map_5_cells",
        "title": "Trailblazer: map 5 unmapped road cells",
        "target": 5,
        "bonus": 50,
        "progress": 2,
        "completed": false
      }
    ]
  }
  ```

### `GET /api/v1/leaderboard`
Retrieves a ranked list of top drivers.
- **Query Params**: `limit` (int, default 20)
- **Response**:
  ```json
  {
    "leaderboard": [
      {
        "rank": 1,
        "user_id": "driver-01",
        "balance": 450,
        "cells_mapped": 22,
        "hazards_reported": 18
      }
    ]
  }
  ```

---

## 🧭 Navigation & Routing

### `GET /api/v1/route`
Provides a comparison between the most direct route and a hazard-avoiding route.
- **Query Params**: `from_lat`, `from_lng`, `to_lat`, `to_lng`
- **Response**:
  ```json
  {
    "fastest": {
      "polyline": [[28.5355, 77.3910], ...],
      "distance_km": 12.4,
      "eta_min": 18.6,
      "hazards_on_route": 4
    },
    "smoothest": {
      "polyline": [[28.5355, 77.3910], ...],
      "distance_km": 12.6,
      "eta_min": 20.1,
      "hazards_on_route": 0
    },
    "summary": "+1.5 min, avoids 4 hazards"
  }
  ```

---

## 🏛️ Authority Dashboard

### `GET /api/v1/authority/hotspots`
Ranked repair-priority list for city officials.
- **Query Params**: `limit` (int, default: 20)
- **Response**:
  ```json
  {
    "hotspots": [
      {
        "id": 15,
        "cell": "8c392b21c4303ff",
        "lat": 28.5355,
        "lng": 77.3910,
        "road_class": "speed_breaker",
        "severity": 8.2,
        "reports": 14,
        "priority": 45.3
      }
    ]
  }
  ```

### `GET /api/v1/stats`
Platform-wide high-level metrics.
- **Response**:
  ```json
  {
    "stats": {
      "total_events": 1420,
      "total_hazards": 85,
      "confirmed_hazards": 42,
      "resolved_hazards": 12,
      "pending_hazards": 31,
      "total_devices": 150,
      "total_cells_mapped": 640,
      "total_coins_awarded": 18500
    }
  }
  ```

---

## 📡 Live Event WebSockets (PC Server Only)

### `ws://<x-elite-ip>:8100/ws/dashboard`
Live telemetry stream for rendering pipeline visualizers.
- **Message Types (JSON)**:
  - Hop activation: `{"kind": "hop", "hop": 3, "label": "pothole (92%) sev 6.8", "infer_ms": 14.2, "backend": "qnn_npu", "waveform": [...]}`
  - Event classified: `{"kind": "event", "road_class": "pothole", "severity": 6.8, "device_id": "d1", "lat": 28.5, "lng": 77.3, "backend": "qnn_npu", "glass_ms": 22.4}`
