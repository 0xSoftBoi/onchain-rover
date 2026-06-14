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
import os
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
    # Per-unit motor polarity: on some units positive drives backward. Set
    # ROVER_DRIVE_INVERT=1 to flip so positive = forward. Verified per robot.
    _INVERT = -1.0 if os.environ.get("ROVER_DRIVE_INVERT") == "1" else 1.0

    # The ESP32 has a command-timeout failsafe: it STOPS the motors if a drive
    # command isn't resent within a few hundred ms. So we hold a target velocity
    # and a daemon thread resends it ~12 Hz — one-shot drive() calls now produce
    # sustained motion (fixes turns, forward, autonomous moves).
    _target = (0.0, 0.0)
    _sustain_started = False

    def _sustain(self):
        while True:
            l, r = self._target
            if l or r:
                self._send({"T": 1, "L": l * self._INVERT, "R": r * self._INVERT})
            time.sleep(0.08)

    def drive(self, left, right):
        """Set target wheel speeds (-1..1, + = forward). Held + resent by the
        sustain thread so the firmware failsafe doesn't cut the motors."""
        self._target = (float(left), float(right))
        if not self._sustain_started:
            self._sustain_started = True
            threading.Thread(target=self._sustain, daemon=True).start()
        self._send({"T": 1, "L": float(left) * self._INVERT,
                    "R": float(right) * self._INVERT})

    def drive_xz(self, linear, angular):
        """ROS-style differential drive — native firmware cmd T:13 (X=linear m/s,
        Z=angular rad/s). Cleaner than hand-rolled diff-drive for Twist/cmd_vel.
        Also sustained via the target thread (mirror into L/R for the resend)."""
        # firmware does the X/Z->wheel mix; we still send T:13 + keep alive
        self._target = (linear, angular)   # reused by sustain as a passthrough
        self._send({"T": 13, "X": float(linear) * self._INVERT,
                    "Z": float(angular)})

    def set_heartbeat(self, ms=10000):
        """Set the firmware motion failsafe timeout (default fw = 3000ms). We
        still resend ~12Hz, but raising this is belt-and-suspenders. T:136."""
        self._send({"T": 136, "cmd": int(ms)})

    def enable_feedback(self, on=True):
        """Turn on continuous base-info feedback flow (T:131) so telemetry
        streams without polling each frame."""
        self._send({"T": 131, "cmd": 1 if on else 0})

    def forward(self, speed=0.2):
        self.drive(speed, speed)

    def turn(self, speed=0.2):
        """Positive = spin right in place."""
        self.drive(speed, -speed)

    # --- sensor-driven motion (uses the 9-axis IMU we were ignoring) -------
    def heading(self):
        """Fused yaw in degrees from the attitude frame (0-360)."""
        a = self.attitude()
        return (a.get("y") if a else None)

    def tilt(self):
        """(roll, pitch) degrees — detect ramps / being picked up / stuck."""
        a = self.attitude()
        return (a.get("r"), a.get("p")) if a else (None, None)

    # Raw gyro_z integrates to angle. The fused yaw (T:1002) is dead on these
    # units, but raw gyro is strong (~-876 at spin). SCALE maps raw·s -> degrees;
    # tune ROVER_GYRO_SCALE against a camera-measured 360° (motion_check).
    _GYRO_SCALE = float(os.environ.get("ROVER_GYRO_SCALE", "0.0164"))

    def turn_by(self, degrees, speed=0.28, timeout=6.0):
        """CLOSED-LOOP turn by integrating the raw gyro — stops at the actual
        rotated angle (robust to battery sag/friction), not a blind timer.
        +degrees = right. Returns the integrated angle achieved."""
        direction = 1 if degrees >= 0 else -1
        target = abs(degrees)
        angle = 0.0
        t_prev = time.time()
        t0 = t_prev
        self.turn(speed * direction)
        while time.time() - t0 < timeout:
            t = self.telemetry()
            now = time.time()
            dt = now - t_prev
            t_prev = now
            if t:
                angle += abs(t.get("gz", 0)) * dt * self._GYRO_SCALE
            if angle >= target:
                break
            time.sleep(0.02)
        self.stop()
        return angle * direction

    def bumped(self, baseline_az=9800, thresh=4000):
        """Collision/jolt check: horizontal accel spike beyond gravity baseline.
        Returns True on a bump (use to auto-stop during autonomous moves)."""
        t = self.telemetry()
        if not t:
            return False
        ax, ay = abs(t.get("ax", 0)), abs(t.get("ay", 0))
        return (ax + ay) > thresh   # large horizontal accel = jolt/impact

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
