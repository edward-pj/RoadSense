from arduino.app_utils import *
import time
import socket
import threading

ACCEL_LSB_PER_G = 16384.0
GYRO_LSB_PER_DPS = 131.0

def counts_to_g(raw):
    return raw / ACCEL_LSB_PER_G

def counts_to_dps(raw):
    return raw / GYRO_LSB_PER_DPS

STREAM_PORT = 9000
SAMPLE_PERIOD = 0.1

def parse_imu(raw: str):
    try:
        ax, ay, az, gx, gy, gz = map(int, raw.split(','))
        return {
            "ax": ax,
            "ay": ay,
            "az": az,
            "gx": gx,
            "gy": gy,
            "gz": gz,
        }
    except ValueError:
        return None

def parse_gps(raw: str):
    try:
        parts = raw.split(',')

        fix_valid = int(parts[0]) == 1
        lat, lon, alt, speed, course = map(float, parts[1:6])
        sats = int(parts[6])
        hh, mm, ss = map(int, parts[7:10])
        year, month, day = map(int, parts[10:13])

        return {
            "fix_valid": fix_valid,
            "lat": lat,
            "lon": lon,
            "altitude": alt,
            "speed_kmph": speed,
            "course_deg": course,
            "satellites": sats,
            "time": f"{hh:02d}:{mm:02d}:{ss:02d}",
            "date": f"{year:04d}-{month:02d}-{day:02d}",
        }

    except (ValueError, IndexError):
        return None

def convert_imu(imu: dict):
    return {
        "ax": counts_to_g(imu["ax"]),
        "ay": counts_to_g(imu["ay"]),
        "az": counts_to_g(imu["az"]),
        "gx": counts_to_dps(imu["gx"]),
        "gy": counts_to_dps(imu["gy"]),
        "gz": counts_to_dps(imu["gz"]),
    }

def format_line(g: dict, gps: dict):
    if gps["fix_valid"]:
        gps_str = (
            f"lat={gps['lat']:.6f} "
            f"lon={gps['lon']:.6f} "
            f"spd={gps['speed_kmph']:.1f}km/h "
            f"sats={gps['satellites']}"
        )
    else:
        gps_str = "NO FIX"

    return (
        f"ax={g['ax']:+6.3f}g "
        f"ay={g['ay']:+6.3f}g "
        f"az={g['az']:+6.3f}g | "
        f"gx={g['gx']:+8.2f} "
        f"gy={g['gy']:+8.2f} "
        f"gz={g['gz']:+8.2f} dps | "
        f"GPS: {gps_str}"
    )

class StreamServer:
    def __init__(self, port):
        self.port = port
        self.clients = []
        self.lock = threading.Lock()
        self.sock = None

    def start(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("0.0.0.0", self.port))
        self.sock.listen(5)
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def _accept_loop(self):
        while True:
            try:
                conn, addr = self.sock.accept()
            except OSError:
                break

            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            conn.settimeout(2.0)

            with self.lock:
                self.clients.append(conn)

            try:
                conn.sendall(b"--- UNO Q telemetry stream connected ---\n")
            except OSError:
                pass

    def broadcast(self, line):
        data = (line + "\n").encode("utf-8", "replace")

        with self.lock:
            dead = []

            for client in self.clients:
                try:
                    client.sendall(data)
                except OSError:
                    dead.append(client)

            for client in dead:
                try:
                    client.close()
                except OSError:
                    pass
                self.clients.remove(client)

_server = None
_inited = False

def _init():
    global _server, _inited

    if _inited:
        return

    _inited = True
    _server = StreamServer(STREAM_PORT)

    try:
        _server.start()
        print(
            f"[NET] Wireless serial live on TCP {STREAM_PORT}. "
            f"Connect using: nc <uno-ip> {STREAM_PORT}"
        )
    except OSError as e:
        print(f"[NET] Could not start stream server: {e}")
        _server = None

def loop():
    _init()

    imu_raw = Bridge.call("get_imu", "")
    gps_raw = Bridge.call("get_gps", "")

    imu = parse_imu(imu_raw)
    gps = parse_gps(gps_raw)

    if imu is None or gps is None:
        print("Warning: malformed data from MCU, skipping this tick.")
        time.sleep(SAMPLE_PERIOD)
        return

    converted = convert_imu(imu)
    line = format_line(converted, gps)

    print(line)

    if _server is not None:
        _server.broadcast(line)

    time.sleep(SAMPLE_PERIOD)

App.run(user_loop=loop)
