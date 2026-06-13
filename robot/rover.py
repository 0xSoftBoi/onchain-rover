"""
Waveshare UGV Rover — clean control library for the Jetson Orin kit.

Talks to the ESP32 lower-computer board over UART (/dev/ttyTHS1 @115200) using
the JSON command protocol. Telemetry streams back as JSON lines:
    {"T":1001, ...IMU/odometry/voltage...}
    {"T":1002, ...roll/pitch/yaw + quaternion...}

IMPORTANT: the Waveshare web app (app.py) also owns /dev/ttyTHS1. Only ONE
process can hold the serial port at a time. Before using this library, stop the
web app:   pgrep -f '[a]pp.py' | xargs -r kill
...or drive through the web app's HTTP API instead.

Usage:
    from rover import Rover
    with Rover() as r:
        print(r.telemetry())     # read IMU / battery / odometry (read-only)
        r.drive(0.2, 0.2)        # left, right wheel speed in m/s-ish (-1.0..1.0)
        time.sleep(1)
        r.stop()
"""
import json
import time
import threading

import serial


class Rover:
    def __init__(self, port="/dev/ttyTHS1", baud=115200, timeout=0.5):
        self.ser = serial.Serial(port, baud, timeout=timeout)
        self._last = {}
        self._lock = threading.Lock()
        time.sleep(0.2)
        self.ser.reset_input_buffer()

    # --- low level ---------------------------------------------------------
    def _send(self, obj):
        line = json.dumps(obj) + "\n"
        with self._lock:
            self.ser.write(line.encode())

    def _read_one(self, want_type=None, attempts=20):
        """Read JSON telemetry lines; return first dict (optionally matching T)."""
        for _ in range(attempts):
            raw = self.ser.readline().decode(errors="replace").strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            self._last.update(msg)
            if want_type is None or msg.get("T") == want_type:
                return msg
        return None

    # --- telemetry (read-only) --------------------------------------------
    def telemetry(self):
        """Return the latest {T:1001} base-info frame: IMU, odometry, voltage."""
        return self._read_one(want_type=1001)

    def attitude(self):
        """Request roll/pitch/yaw + quaternion ({T:1002})."""
        self._send({"T": 126})
        return self._read_one(want_type=1002)

    def battery_volts(self):
        t = self.telemetry()
        return (t.get("v", 0) / 100.0) if t else None  # firmware reports centivolts

    # --- motion ------------------------------------------------------------
    def drive(self, left, right):
        """Set wheel speeds. left/right roughly -1.0..1.0."""
        self._send({"T": 1, "L": float(left), "R": float(right)})

    def forward(self, speed=0.2):
        self.drive(speed, speed)

    def turn(self, speed=0.2):
        """Positive = spin right in place."""
        self.drive(speed, -speed)

    def stop(self):
        self.drive(0, 0)

    # --- accessories -------------------------------------------------------
    def gimbal(self, x, y, speed=0, accel=0):
        """Pan/tilt the camera gimbal. x=pan deg, y=tilt deg."""
        self._send({"T": 133, "X": x, "Y": y, "SPD": speed, "ACC": accel})

    def lights(self, a=255, b=255):
        """Headlight PWM 0..255 on IO4/IO5."""
        self._send({"T": 132, "IO4": a, "IO5": b})

    def oled(self, line, text):
        """Write text to a line (0-3) of the onboard OLED."""
        self._send({"T": 3, "lineNum": line, "Text": text})

    # --- context manager ---------------------------------------------------
    def close(self):
        try:
            self.stop()
        finally:
            self.ser.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


if __name__ == "__main__":
    # Safe demo: read-only telemetry, no movement.
    with Rover() as r:
        print("Reading telemetry (no motion)...")
        for _ in range(5):
            t = r.telemetry()
            if t:
                print(f"  batt={t.get('v',0)/100:.2f}V  "
                      f"accel=({t.get('ax')},{t.get('ay')},{t.get('az')})  "
                      f"odo=({t.get('odl')},{t.get('odr')})")
            time.sleep(0.3)
        att = r.attitude()
        if att:
            print(f"attitude: roll={att.get('r')} pitch={att.get('p')} yaw={att.get('y')}")
        print("Done. To drive: r.forward(0.2); time.sleep(1); r.stop()")
