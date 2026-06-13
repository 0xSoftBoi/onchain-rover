"""
DimOS Phase 1 — RoverModule: the body adapter.

Bridges DimOS's reactive `cmd_vel: In[Twist]` motion abstraction to the
Waveshare rover. A DimOS agent/planner publishes Twist (unicycle: linear.x m/s,
angular.z rad/s); this turns it into differential-drive wheel commands and sends
them to the rover, and publishes wheel-odometry back as `pose: Out[PoseStamped]`.

Serial is single-owner (the ESP32 port). Default DRIVE_MODE="http" routes
commands through api.py's existing /drive endpoint (which owns the shared serial
+ enforces the same speed clamp), so DimOS and the FastAPI app coexist with no
contention. DRIVE_MODE="serial" opens the port directly for standalone use
(only when api.py is NOT running).

The Twist->wheels math is a pure function (twist_to_wheels) so it's testable
without DimOS installed. The DimOS Module wraps it.

Run standalone on the Jetson (DimOS installed):
    DRIVE_MODE=http python dimos_rover.py
"""
import os

MAX_SPEED = float(os.environ.get("ROVER_MAX_SPEED", "0.35"))   # matches pilot clamp
WHEEL_BASE = float(os.environ.get("ROVER_WHEEL_BASE", "0.18"))  # metres, track width
ROBOT_API = os.environ.get("ROBOT_API", "http://localhost:8000")
DRIVE_MODE = os.environ.get("DRIVE_MODE", "http")               # http | serial


def twist_to_wheels(linear_x: float, angular_z: float,
                    wheel_base: float = WHEEL_BASE,
                    max_speed: float = MAX_SPEED):
    """Unicycle (v, w) -> (left, right) wheel commands, clamped to ±max_speed.
    Pure + dependency-free so it can be unit-tested anywhere."""
    half = wheel_base / 2.0
    left = linear_x - angular_z * half
    right = linear_x + angular_z * half
    # preserve the turn ratio if clamping would distort it
    peak = max(abs(left), abs(right))
    if peak > max_speed:
        scale = max_speed / peak
        left *= scale
        right *= scale
    clamp = lambda x: max(-max_speed, min(max_speed, x))
    return clamp(left), clamp(right)


# --- drive backends --------------------------------------------------------
class _HttpDrive:
    """Drives via api.py's /drive (shared serial owner). No contention."""
    def __init__(self, base):
        import requests
        self._s = requests.Session()
        self._url = f"{base}/drive"
        self._stop = f"{base}/stop"

    def drive(self, left, right):
        try:
            self._s.post(self._url, json={"left": left, "right": right}, timeout=2)
        except Exception as e:
            print(f"http drive failed: {e}")

    def stop(self):
        try:
            self._s.post(self._stop, timeout=2)
        except Exception:
            pass

    def odometry(self):
        try:
            h = self._s.get(f"{ROBOT_API}/health", timeout=2).json()
            return {"battery_v": h.get("battery_v")}
        except Exception:
            return {}


class _SerialDrive:
    """Opens the ESP32 serial directly. ONLY when api.py is not running.
    Uses the native T:13 X/Z command so DimOS Twist maps 1:1 (no hand-rolled
    diff-drive) — the firmware does the wheel mix + PID."""
    def __init__(self):
        from rover import Rover
        self.r = Rover()
        self.r.set_heartbeat(15000)

    def drive_xz(self, linear, angular):
        self.r.drive_xz(linear, angular)

    def drive(self, left, right):
        self.r.drive(left, right)

    def stop(self):
        self.r.stop()

    def odometry(self):
        t = self.r.telemetry() or {}
        return {"odl": t.get("odl"), "odr": t.get("odr"), "battery_v": (t.get("v", 0) / 100.0)}


def make_backend():
    return _SerialDrive() if DRIVE_MODE == "serial" else _HttpDrive(ROBOT_API)


# --- DimOS Module (imported only when DimOS is installed) ------------------
def build_module():
    """Construct the RoverModule class lazily so this file imports fine without
    DimOS present (for unit-testing twist_to_wheels). Call on the Jetson once
    `pip install 'dimos[base,agents]'` is done."""
    import reactivex as rx
    from dimos.core.module import Module
    from dimos.core.stream import In, Out
    from dimos.msgs.geometry_msgs.Twist import Twist
    from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped

    class RoverModule(Module):
        cmd_vel: In[Twist]
        pose: Out[PoseStamped]

        def start(self):
            self._drive = make_backend()
            self._last_cmd = 0.0
            # motion: every cmd_vel Twist -> wheels
            self.register_disposable(
                self.cmd_vel.observable().subscribe(self._on_twist))
            # deadman: stop if no command for 0.5s (same safety as the pilot WS)
            self.register_disposable(
                rx.interval(0.1).subscribe(lambda _: self._watchdog()))
            # odometry pose at ~5Hz (best-effort)
            self.register_disposable(
                rx.interval(0.2).subscribe(lambda _: self._publish_pose()))

        def _on_twist(self, t):
            import time
            left, right = twist_to_wheels(t.linear.x, t.angular.z)
            self._drive.drive(left, right)
            self._last_cmd = time.time()

        def _watchdog(self):
            import time
            if time.time() - self._last_cmd > 0.5:
                self._drive.stop()

        def _publish_pose(self):
            odo = self._drive.odometry()
            ps = PoseStamped()
            # wheel odometry is relative; expose what we have (x from mean ticks)
            if odo.get("odl") is not None and odo.get("odr") is not None:
                ps.pose.position.x = (odo["odl"] + odo["odr"]) / 2.0
            self.pose.publish(ps)

    return RoverModule


if __name__ == "__main__":
    # Standalone wiring on the Jetson: subscribe cmd_vel over the default
    # transport so a DimOS agent (or `dimos` CLI) can drive the rover.
    from dimos.core.coordination.blueprints import autoconnect  # noqa
    from dimos.core.transport.lcm_transport import LCMTransport
    from dimos.msgs.geometry_msgs.Twist import Twist

    RoverModule = build_module()
    rover = RoverModule()
    rover.cmd_vel.transport = LCMTransport("/cmd_vel", Twist)
    print(f"RoverModule listening on /cmd_vel (DRIVE_MODE={DRIVE_MODE}, "
          f"max={MAX_SPEED} m/s, base={WHEEL_BASE} m)")
    autoconnect(rover).build().loop()
