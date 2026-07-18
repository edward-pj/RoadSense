"""UNO Q MPU (hop 2): gate model + Wi-Fi forwarder.

Receives 128x6 IMU windows from the MCU over the Bridge, runs the INT8 gate
model on the Hexagon DSP v66 (SNPE), and forwards survivors to the X Elite
over WebSocket. Raw signal for rejected windows never leaves this board.

The Bridge exclusively owns the MCU serial link — never touch Serial1.
Verify the exact Bridge API against the App Lab Blink example on-site.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import tempfile
import threading
import time

import numpy as np

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("roadsense.unoq")

PC_WS_URL = os.environ.get("ROADSENSE_PC_WS", "ws://192.168.1.10:8100/ws/ingest")
DEVICE_ID = os.environ.get("ROADSENSE_DEVICE_ID", "unoq-01")
USER_ID = os.environ.get("ROADSENSE_USER_ID", "driver-01")
GATE_DLC = os.path.join(os.path.dirname(__file__), "..", "..", "models", "gate_int8.dlc")

_outbox: queue.Queue[dict] = queue.Queue(maxsize=64)
_seq = 0


def gate(window: np.ndarray) -> bool:
    """True if the window is a real road event, False for noise.

    Uses the INT8 gate model on the Hexagon DSP via snpe-net-run when the
    .dlc is present; otherwise a deterministic variance+peak rule so the
    pipeline works end-to-end before models are deployed.
    """
    if os.path.exists(GATE_DLC):
        try:
            return _gate_dsp(window)
        except Exception as exc:
            log.warning("DSP gate failed (%s); using rule gate", exc)
    az = window[:, 2] - 1.0
    return bool(np.max(np.abs(az)) > 0.3 and np.var(az) > 0.002)


def _gate_dsp(window: np.ndarray) -> bool:
    """Run the gate .dlc on the DSP. INT8 only — v66 cannot run FP32."""
    with tempfile.TemporaryDirectory() as td:
        raw = os.path.join(td, "input.raw")
        window.astype(np.float32).tofile(raw)
        lst = os.path.join(td, "inputs.txt")
        with open(lst, "w") as f:
            f.write(raw + "\n")
        subprocess.run(
            ["snpe-net-run", "--container", GATE_DLC, "--input_list", lst,
             "--use_dsp", "--output_dir", td],
            check=True, capture_output=True, timeout=5,
        )
        out = np.fromfile(os.path.join(td, "Result_0", "output.raw"), dtype=np.float32)
        return bool(out[0] > 0.5)


def submit_window(payload: str) -> None:
    """Bridge RPC target — MCU calls this with a JSON window message."""
    global _seq
    msg = json.loads(payload)
    window = np.asarray(msg["window"], dtype=np.float32)
    if not gate(window):
        log.info("gated out: seq=%d", _seq)
        return
    _seq += 1
    event = {
        "device_id": DEVICE_ID, "user_id": USER_ID, "seq": _seq,
        "ts": msg.get("ts", time.time()),
        "lat": msg.get("lat", 0.0), "lng": msg.get("lng", 0.0),
        "speed_kmh": msg.get("speed_kmh", 30.0),
        "vehicle_type": "hatchback",
        "window": window.tolist(),
    }
    try:
        _outbox.put_nowait(event)
    except queue.Full:
        log.warning("outbox full; dropping oldest")
        _outbox.get_nowait()
        _outbox.put_nowait(event)


def _sender() -> None:
    """Background thread: drain the outbox to the X Elite, reconnect forever."""
    import websockets.sync.client as wsc

    while True:
        try:
            with wsc.connect(PC_WS_URL) as ws:
                log.info("connected to PC at %s", PC_WS_URL)
                while True:
                    ws.send(json.dumps(_outbox.get()))
        except Exception as exc:
            log.warning("PC link down (%s); retrying in 2s", exc)
            time.sleep(2)


def main() -> None:
    threading.Thread(target=_sender, daemon=True).start()
    try:
        # App Lab Bridge: verify exact import/API against the Blink example.
        from arduino.app_utils import App, Bridge  # type: ignore

        Bridge.provide("submit_window", submit_window)
        log.info("bridge ready; waiting for MCU windows")
        App.run()
    except ImportError:
        log.warning("Bridge unavailable (dev machine?) — reading stdin instead")
        import sys
        for line in sys.stdin:
            submit_window(line)


if __name__ == "__main__":
    main()
