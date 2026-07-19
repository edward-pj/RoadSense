"""SQLite persistence for the RoadSense cloud fusion service.

Single-file schema, connection factory, and migration bootstrap. The same
schema runs on the cloud instance and as the X Elite local mirror, so the
driver loop survives with no internet (majority-on-edge rule).
"""

from __future__ import annotations

import os
import sqlite3
from dotenv import load_dotenv

load_dotenv()

DB_PATH = os.environ.get("ROADSENSE_DB", "roadsense.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    user_id   TEXT NOT NULL,
    vehicle_type TEXT NOT NULL DEFAULT 'hatchback',
    created_at REAL NOT NULL DEFAULT (unixepoch('subsec'))
);

CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    ts        REAL NOT NULL,
    lat       REAL NOT NULL,
    lng       REAL NOT NULL,
    cell      TEXT NOT NULL,
    road_class TEXT NOT NULL,
    severity  REAL NOT NULL,
    speed_kmh REAL NOT NULL,
    UNIQUE (device_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_cell ON events (cell);

CREATE TABLE IF NOT EXISTS cells (
    cell TEXT PRIMARY KEY,
    sample_count INTEGER NOT NULL DEFAULT 0,
    severity_sum REAL NOT NULL DEFAULT 0,
    first_device TEXT NOT NULL,
    first_user   TEXT NOT NULL,
    last_seen    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS hazards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cell TEXT NOT NULL,
    road_class TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | CONFIRMED | RESOLVED
    severity_sum REAL NOT NULL DEFAULT 0,
    report_count INTEGER NOT NULL DEFAULT 0,
    clean_passes INTEGER NOT NULL DEFAULT 0,  -- consecutive, resets on new report
    confirmed_at REAL,
    resolved_at  REAL,
    UNIQUE (cell, road_class)
);
CREATE INDEX IF NOT EXISTS idx_hazards_status ON hazards (status);

CREATE TABLE IF NOT EXISTS hazard_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hazard_id INTEGER NOT NULL REFERENCES hazards (id),
    device_id TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    severity  REAL NOT NULL,
    ts        REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_hazard ON hazard_reports (hazard_id);

CREATE TABLE IF NOT EXISTS hazard_votes (
    hazard_id INTEGER NOT NULL REFERENCES hazards (id),
    user_id   TEXT NOT NULL,
    vote      TEXT NOT NULL CHECK (vote IN ('confirm', 'deny')),
    ts        REAL NOT NULL,
    PRIMARY KEY (hazard_id, user_id)
);

CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    amount  INTEGER NOT NULL,
    reason  TEXT NOT NULL,
    ref     TEXT NOT NULL,
    idem_key TEXT NOT NULL UNIQUE,
    ts      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger (user_id);

CREATE TABLE IF NOT EXISTS mission_progress (
    user_id    TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    progress   INTEGER NOT NULL DEFAULT 0,
    completed_at REAL,
    PRIMARY KEY (user_id, mission_id)
);
"""


def connect(path: str | None = None) -> sqlite3.Connection:
    """Open a connection with schema applied and sane pragmas."""
    conn = sqlite3.connect(path or DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(_SCHEMA)
    return conn
