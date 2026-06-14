"""
The Onchain Rover — autonomous agent loop.

Natural-language task  ->  local LLM (Ollama/gemma3)  ->  motion/goal plan  ->
rover executes  ->  camera photo captured as proof-of-action.

This is the sponsor-agnostic spine. Onchain pieces (USDC escrow, ENS, World ID,
0G proof upload) wrap around execute_task() and proof_path.

TWO planners share this file:
  * Default (motion primitives) — the original forward/turn/gimbal macro player.
    Used by the generic /task hire flow and Act 2. UNCHANGED behaviour.
  * Goal-based autonomy (autonomous=True) — the ACT 1 path. The LLM emits
    navigation GOALS ("0.8 m forward, face 90°") and Nav2 (cuVSLAM/Nvblox via
    ros2_bridge.py) drives there, avoiding obstacles; falls back to the
    closed-loop gyro primitives when ROS2/Nav2 isn't up. Opt-in so it only
    affects Act 1 — call execute_task(..., autonomous=True) or set ROVER_NAV.

NOTE: app.py (web UI) holds both the serial port and the camera. Stop it first:
    pgrep -f '[a]pp.py' | xargs -r kill
Run:  ./ugv-env/bin/python agent.py "drive forward a little and look around"
      ./ugv-env/bin/python agent.py --autonomous "go to the checkpoint, photo"
"""
import base64
import json
import math
import os
import sys
import time
import hashlib

import requests
import cv2

from rover import Rover

OLLAMA = "http://localhost:11434/api/generate"
MODEL = "gemma3:1b"

# Goal-based (Act 1) tuning.
CRUISE = float(os.environ.get("ROVER_CRUISE", "0.2"))        # m/s for distance->time
NAV_TIMEOUT = float(os.environ.get("ROVER_NAV_TIMEOUT", "20"))  # s per Nav2 goal

# NoMaD navigator (Act 1): off-board visual-nav policy server (nav_policy_server.py).
NAV_SERVER = os.environ.get("NAV_SERVER", "http://localhost:4041")
NAV_RATE_HZ = float(os.environ.get("NAV_RATE_HZ", "4"))
NAV_MAX_STEPS = int(os.environ.get("NAV_MAX_STEPS", "120"))   # cap per goto
ODOM_SCALE = float(os.environ.get("ROVER_ODOM_SCALE", "0.0001"))  # m per tick

# Semantic brain (Phase 3): off-board RoboBrain server (brain_service.py). Optional
# — set BRAIN_SERVER to enable goal-directed steering + an 'arrived' stop signal
# on top of NoMaD's reactive exploration. Unset/unreachable -> pure NoMaD.
BRAIN_SERVER = os.environ.get("BRAIN_SERVER", "")
BRAIN_GOAL = os.environ.get("BRAIN_GOAL", "the checkpoint")  # NL target to seek
BRAIN_EVERY = int(os.environ.get("BRAIN_EVERY", "8"))        # consult every N steps
BRAIN_BIAS_K = float(os.environ.get("BRAIN_BIAS_K", "1.0"))  # bearing->w gain

# The motion primitives the LLM is allowed to emit. Keep tiny + safe.
SYSTEM = """You control a 4-wheel rover. Convert the user's task into a JSON list
of steps. Allowed steps ONLY:
  {"action":"forward","secs":<0.1-3>,"speed":<0.1-0.4>}
  {"action":"backward","secs":<0.1-3>,"speed":<0.1-0.4>}
  {"action":"turn","secs":<0.1-2>,"speed":<0.1-0.4>}   (positive speed = right)
  {"action":"gimbal","pan":<-80..80>,"tilt":<-30..60>}
  {"action":"photo"}
  {"action":"wait","secs":<0.1-2>}
Keep speeds low and safe. Always end with a {"action":"photo"} step.
Respond with ONLY the JSON array, no prose."""

# Goal-based prompt — ACT 1 only. The LLM says WHERE to go (robot frame: x
# forward, y left, metres; yaw degrees, + = left); the autonomy plans the path.
SYSTEM_GOAL = """You direct an autonomous rover. Convert the user's task into a
JSON array of GOAL steps. The rover plans its own path and avoids obstacles — you
only say WHERE to go and what to sense. Allowed steps ONLY:
  {"action":"goto","forward":<-2.0..2.0>,"left":<-2.0..2.0>}   metres, robot frame
  {"action":"face","yaw":<-180..180>}                          degrees, + = left
  {"action":"gimbal","pan":<-80..80>,"tilt":<-30..60>}
  {"action":"photo"}
  {"action":"wait","secs":<0.1..2>}
Use small distances (<=1.0 m) per goto. Always end with a {"action":"photo"} step.
Respond with ONLY the JSON array, no prose."""


def plan(task, autonomous=False):
    """Ask the local LLM to turn a task into a plan (motion or goal-based)."""
    system = SYSTEM_GOAL if autonomous else SYSTEM
    prompt = f"{system}\n\nTask: {task}\n\nJSON:"
    r = requests.post(OLLAMA, json={
        "model": MODEL, "prompt": prompt, "stream": False,
        "options": {"temperature": 0.2},
    }, timeout=60)
    text = r.json()["response"].strip()
    # strip markdown fences if the model adds them
    if "```" in text:
        text = text.split("```")[1].replace("json", "", 1).strip()
    start, end = text.find("["), text.rfind("]")
    blob = text[start:end + 1]
    # small models emit raw newlines/tabs inside the JSON — strip control chars
    blob = "".join(ch for ch in blob if ch >= " " or ch == " ")
    try:
        return json.loads(blob, strict=False)
    except json.JSONDecodeError:
        # last resort: pull out individual {...} objects
        import re
        steps = []
        for m in re.findall(r"\{[^{}]*\}", blob):
            try:
                steps.append(json.loads(m, strict=False))
            except json.JSONDecodeError:
                pass
        if not steps:
            raise
        return steps


# --- goal navigators (ACT 1) ----------------------------------------------
class PrimitiveNavigator:
    """No-ROS2 fallback: turn to the bearing with the closed-loop gyro, then
    drive the straight-line distance open-loop. Uses the rover directly."""

    def __init__(self, rover):
        self.r = rover

    def goto(self, forward, left):
        bearing = math.degrees(math.atan2(left, forward))   # + = left
        dist = math.hypot(forward, left)
        if abs(bearing) > 1.0:
            self.r.turn_by(-bearing)        # turn_by: + = right, so negate
        if dist > 0.01:
            self.r.forward(CRUISE)
            t0 = time.time()
            while time.time() - t0 < dist / CRUISE:
                if self.r.bumped():          # stop early on collision
                    break
                time.sleep(0.02)
            self.r.stop()

    def face(self, yaw):
        self.r.turn_by(-yaw)                 # + yaw = left -> negate for turn_by


class Nav2Navigator:
    """Goals become NavigateToPose actions via nav2_simple_commander. Relative
    goals are resolved against the live pose from /odom (ros2_bridge.py)."""

    def __init__(self):
        import rclpy
        from nav2_simple_commander.robot_navigator import BasicNavigator
        if not rclpy.ok():
            rclpy.init()
        self.rclpy = rclpy
        self.nav = BasicNavigator()
        self.nav.waitUntilNav2Active(localizer="")

    def _current_pose(self):
        from nav_msgs.msg import Odometry
        box = {}
        node = self.rclpy.create_node("agent_pose_probe")
        node.create_subscription(
            Odometry, "odom", lambda m: box.setdefault("p", m.pose.pose), 10)
        t0 = time.time()
        while "p" not in box and time.time() - t0 < 2.0:
            self.rclpy.spin_once(node, timeout_sec=0.1)
        node.destroy_node()
        p = box.get("p")
        if not p:
            raise RuntimeError("no odom pose")
        q = p.orientation
        yaw = math.atan2(2 * (q.w * q.z + q.x * q.y),
                         1 - 2 * (q.y * q.y + q.z * q.z))
        return p.position.x, p.position.y, yaw

    def _send(self, x, y, yaw):
        from geometry_msgs.msg import PoseStamped
        goal = PoseStamped()
        goal.header.frame_id = "odom"
        goal.header.stamp = self.nav.get_clock().now().to_msg()
        goal.pose.position.x, goal.pose.position.y = x, y
        goal.pose.orientation.z = math.sin(yaw / 2.0)
        goal.pose.orientation.w = math.cos(yaw / 2.0)
        self.nav.goToPose(goal)
        t0 = time.time()
        while not self.nav.isTaskComplete():
            if time.time() - t0 > NAV_TIMEOUT:
                self.nav.cancelTask()
                raise TimeoutError("nav goal timed out")
            time.sleep(0.1)

    def goto(self, forward, left):
        cx, cy, cyaw = self._current_pose()
        gx = cx + forward * math.cos(cyaw) - left * math.sin(cyaw)
        gy = cy + forward * math.sin(cyaw) + left * math.cos(cyaw)
        self._send(gx, gy, math.atan2(left, forward) + cyaw)

    def face(self, yaw):
        cx, cy, cyaw = self._current_pose()
        self._send(cx, cy, cyaw + math.radians(yaw))


class NomadNavigator:
    """SOTA path: a NoMaD visual-navigation foundation model (served off-board by
    nav_policy_server.py) drives the rover with obstacle-aware exploration.

    NoMaD is goal-MASKED exploration — it can't hit a metric (forward,left) offset
    like Nav2 can. So a goto is honoured as a hybrid: turn to the bearing with the
    closed-loop gyro (turn_by), then let NoMaD steer while we cover the requested
    straight-line distance, measured by wheel odometry. face() stays primitive
    (NoMaD has no metric yaw). Drives the held Rover directly via twist_to_wheels
    -> drive() so the sustain thread keeps the firmware failsafe fed."""

    def __init__(self, rover, server=NAV_SERVER):
        self.r = rover
        self.server = server
        self.s = requests.Session()
        from dimos_rover import twist_to_wheels
        self._mix = twist_to_wheels
        # require a reachable policy server, else make_navigator falls back
        h = self.s.get(f"{server}/health", timeout=3).json()
        if not h.get("ok"):
            raise RuntimeError("policy server unhealthy")
        self.backend = h.get("backend")
        self.r.set_heartbeat(15000)   # belt-and-suspenders for the cmd loop
        # optional semantic brain: goal-directed steering + 'arrived' stop
        self.brain = None
        if BRAIN_SERVER:
            try:
                bh = self.s.get(f"{BRAIN_SERVER}/health", timeout=3).json()
                if bh.get("ok"):
                    self.brain = BRAIN_SERVER
                    self.backend += f"+brain:{bh.get('backend')}"
            except Exception as e:
                print(f"    (brain unavailable: {str(e)[:50]} — pure NoMaD)")

    def _ask_brain(self, frame_b64):
        """Returns (bearing_bias_radps, arrived). Never raises."""
        if not self.brain:
            return 0.0, False
        try:
            r = self.s.post(f"{self.brain}/think", json={
                "image": frame_b64, "goal": BRAIN_GOAL}, timeout=4).json()
        except Exception as e:
            print(f"    brain think failed: {str(e)[:50]}")
            return 0.0, False
        if not r.get("ok") or not r.get("visible"):
            return 0.0, False
        bias = BRAIN_BIAS_K * math.radians(r.get("bearing_deg", 0.0))
        return bias, bool(r.get("arrived"))

    def _odom_m(self):
        t = self.r.telemetry() or {}
        odl, odr = t.get("odl"), t.get("odr")
        if odl is None or odr is None:
            return None
        return ((odl + odr) / 2.0) * ODOM_SCALE

    def goto(self, forward, left):
        bearing = math.degrees(math.atan2(left, forward))   # + = left
        dist = math.hypot(forward, left)
        if abs(bearing) > 1.0:
            self.r.turn_by(-bearing)        # turn_by: + = right, so negate
        import camera
        camera.start()
        period = 1.0 / NAV_RATE_HZ
        start = self._odom_m()
        reset = True
        bias = 0.0
        for step in range(NAV_MAX_STEPS):
            t0 = time.time()
            frame = camera.latest()
            if frame is None:
                time.sleep(period); continue
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
            frame_b64 = base64.b64encode(buf.tobytes()).decode()
            try:
                resp = self.s.post(f"{self.server}/infer", json={
                    "current": frame_b64, "reset": reset}, timeout=3).json()
            except Exception as e:
                print(f"    infer failed: {str(e)[:60]}"); self.r.stop()
                time.sleep(period); continue
            reset = False
            if not resp.get("ok"):
                self.r.stop(); continue
            # periodically ask the brain where the target is; bias steering to it
            if self.brain and step % BRAIN_EVERY == 0:
                bias, arrived = self._ask_brain(frame_b64)
                if arrived:
                    print("    brain: arrived -> stop"); break
            l, rr = self._mix(resp["linear_x"], resp["angular_z"] + bias)
            self.r.drive(l, rr)
            if self.r.bumped():             # hard safety stop on collision
                print("    bump -> stop"); break
            cur = self._odom_m()
            if dist and start is not None and cur is not None and abs(cur - start) >= dist:
                break
            dt = time.time() - t0
            if dt < period:
                time.sleep(period - dt)
        self.r.stop()

    def face(self, yaw):
        self.r.turn_by(-yaw)                # + yaw = left -> negate for turn_by


def make_navigator(rover):
    """Priority: NoMaD (visual-nav foundation model) -> Nav2 -> closed-loop
    primitives. Each falls back to the next if its stack isn't up. Returns
    (navigator, name). ROVER_NAV pins one: nomad | nav2 | primitive | auto."""
    pref = os.environ.get("ROVER_NAV", "auto")
    if pref in ("auto", "nomad"):
        try:
            nav = NomadNavigator(rover)
            return nav, f"nomad:{nav.backend}"
        except Exception as e:
            print(f"  (NoMaD unavailable: {str(e)[:60]} — trying Nav2)")
    if pref in ("auto", "nav2"):
        try:
            return Nav2Navigator(), "nav2"
        except Exception as e:
            print(f"  (Nav2 unavailable: {str(e)[:60]} — using primitives)")
    return PrimitiveNavigator(rover), "primitive"


def capture_photo(path="/tmp/rover_proof.jpg"):
    # Use the shared camera (so MJPEG streaming + capture don't fight over
    # /dev/video0). Falls back to a direct open if the shared module is unused.
    frame = None
    camera = None
    try:
        import camera as camera
        camera.start()
        for _ in range(20):           # wait up to ~2s for a grabbed frame
            frame = camera.latest()
            if frame is not None:
                break
            time.sleep(0.1)
    except Exception:
        camera = None
    if frame is None and camera is None:
        # no shared camera module — safe to open directly
        cap = cv2.VideoCapture(0)
        time.sleep(0.4)
        ok, frame = cap.read()
        cap.release()
        if not ok:
            raise RuntimeError("camera read failed")
    if frame is None:
        raise RuntimeError("camera read failed (shared camera no frame)")
    cv2.imwrite(path, frame)
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    return path, digest


def _run_motion_steps(r, steps):
    """Original primitive executor — unchanged behaviour for /task & Act 2."""
    for s in steps:
        a = s.get("action")
        print(f"  -> {s}")
        if a == "forward":
            r.forward(s.get("speed", 0.2)); time.sleep(s.get("secs", 1)); r.stop()
        elif a == "backward":
            r.forward(-s.get("speed", 0.2)); time.sleep(s.get("secs", 1)); r.stop()
        elif a == "turn":
            r.turn(s.get("speed", 0.2)); time.sleep(s.get("secs", 1)); r.stop()
        elif a == "gimbal":
            r.gimbal(s.get("pan", 0), s.get("tilt", 0)); time.sleep(0.5)
        elif a == "wait":
            time.sleep(s.get("secs", 0.5))
        elif a == "photo":
            yield s            # let caller capture (keeps proof handling in one place)


def _run_goal_steps(r, steps):
    """ACT 1 goal executor — Nav2 if up, else closed-loop primitives."""
    nav, nav_name = make_navigator(r)
    print(f"NAV: {nav_name}")
    for s in steps:
        a = s.get("action")
        print(f"  -> {s}")
        try:
            if a == "goto":
                nav.goto(float(s.get("forward", 0)), float(s.get("left", 0)))
            elif a == "face":
                nav.face(float(s.get("yaw", 0)))
            elif a == "gimbal":
                r.gimbal(s.get("pan", 0), s.get("tilt", 0)); time.sleep(0.5)
            elif a == "wait":
                time.sleep(s.get("secs", 0.5))
            elif a == "photo":
                yield s
        except Exception as e:
            # one bad goal shouldn't abort the run (or the payment proof)
            print(f"  !! step failed ({a}): {str(e)[:80]}")
            r.stop()


def execute_task(task, dry_run=False, rover=None, autonomous=None):
    """Run a NL task end to end. Returns a proof dict for the onchain layer.
    Pass an existing Rover to reuse an open serial port (api.py singleton).

    autonomous: None -> env ROVER_AUTONOMOUS; True -> ACT 1 goal-based navigation
    (Nav2 with primitive fallback); False -> original motion primitives."""
    if autonomous is None:
        autonomous = os.environ.get("ROVER_AUTONOMOUS") == "1"
    steps = plan(task, autonomous=autonomous)
    print(f"PLAN ({'goal' if autonomous else 'motion'}): {json.dumps(steps)}")
    proof = {"task": task, "steps": steps, "photo": None, "photo_sha256": None,
             "telemetry": None}
    if dry_run:
        return proof

    import contextlib
    ctx = contextlib.nullcontext(rover) if rover else Rover()
    with ctx as r:
        runner = _run_goal_steps if autonomous else _run_motion_steps
        for s in runner(r, steps):       # runner yields only on photo steps
            path, digest = capture_photo()
            proof["photo"], proof["photo_sha256"] = path, digest
            print(f"  -> PHOTO {path} sha256={digest[:16]}...")
        proof["telemetry"] = r.telemetry()
    return proof


if __name__ == "__main__":
    argv = [a for a in sys.argv[1:] if a not in ("--dry", "--autonomous")]
    dry = "--dry" in sys.argv
    auto = "--autonomous" in sys.argv or None
    task = " ".join(argv) or "look around and take a photo"
    result = execute_task(task, dry_run=dry, autonomous=auto)
    print("\nPROOF:", json.dumps({k: v for k, v in result.items()
                                  if k != "steps"}, indent=2))
