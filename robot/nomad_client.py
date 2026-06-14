"""
Phase 1 — NoMaD CLIENT loop (runs on the Jetson). The dumb real-time half of the
LeRobot async pattern: grab a frame, ask the off-board policy server for a
steering command, relay it as a Twist. All the GPU work is remote.

    [camera.py] --frame--> [this client] --POST /infer--> nav_policy_server (GPU)
                           [this client] <--(v, w)------- nav_policy_server
                           [this client] --/cmd_vel-----> ros2_bridge.py --> wheels

Two relay backends (PUBLISH env, auto: ros2 if rclpy present, else http):
  ros2  — publish geometry_msgs/Twist on /cmd_vel; ros2_bridge.py drives + adds
          the deadman + odom. Preferred (same path Nav2 uses).
  http  — POST api.py /drive directly (reuses dimos_rover.twist_to_wheels). Works
          with NO ROS2 — only api.py running.

A goal IMAGE is sent each step (used only by the goal-conditioned policy path;
the packaged NoMaD runs goal-masked exploration and ignores it). Stops after
NAV_MAX_STEPS, or when the policy reports dist_to_goal <= NAV_GOAL_DIST (only the
goal-conditioned path reports a real distance; exploration returns -1).

Run on the Jetson (api.py + ros2_bridge.py up):
    NAV_SERVER=http://<laptop>:4041 python nomad_client.py --goal goal_checkpoint.jpg
"""
import argparse
import base64
import os
import time

import requests

SERVER = os.environ.get("NAV_SERVER", "http://localhost:4041")
PUBLISH = os.environ.get("PUBLISH", "auto")          # auto | ros2 | http
ROBOT_API = os.environ.get("ROBOT_API", "http://localhost:8000")
RATE_HZ = float(os.environ.get("NAV_RATE_HZ", "4"))
GOAL_DIST = float(os.environ.get("NAV_GOAL_DIST", "0.5"))   # stop threshold
MAX_STEPS = int(os.environ.get("NAV_MAX_STEPS", "200"))


def _jpeg_b64(bgr, quality=70):
    import cv2
    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    return base64.b64encode(buf.tobytes()).decode()


def _load_goal_b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


# --- relay backends --------------------------------------------------------
class Ros2Relay:
    name = "ros2"

    def __init__(self):
        import rclpy
        from rclpy.node import Node
        from geometry_msgs.msg import Twist
        if not rclpy.ok():
            rclpy.init()
        self.rclpy, self.Twist = rclpy, Twist
        self.node = Node("nomad_client")
        self.pub = self.node.create_publisher(Twist, "cmd_vel", 10)

    def send(self, v, w):
        t = self.Twist()
        t.linear.x, t.angular.z = float(v), float(w)
        self.pub.publish(t)

    def stop(self):
        self.send(0.0, 0.0)


class HttpRelay:
    name = "http"

    def __init__(self):
        from dimos_rover import twist_to_wheels
        self._mix = twist_to_wheels
        self._s = requests.Session()

    def send(self, v, w):
        l, r = self._mix(v, w)
        try:
            self._s.post(f"{ROBOT_API}/drive", json={"left": l, "right": r}, timeout=1.5)
        except Exception as e:
            print(f"  http drive failed: {str(e)[:60]}")

    def stop(self):
        try:
            self._s.post(f"{ROBOT_API}/stop", timeout=1.5)
        except Exception:
            pass


def make_relay():
    if PUBLISH in ("auto", "ros2"):
        try:
            return Ros2Relay()
        except Exception as e:
            if PUBLISH == "ros2":
                raise
            print(f"  (ros2 relay unavailable: {str(e)[:60]} — using http)")
    return HttpRelay()


def run(goal_path, server=SERVER):
    import camera
    goal_b64 = _load_goal_b64(goal_path)
    relay = make_relay()
    print(f"NoMaD client: server={server} relay={relay.name} goal={goal_path}")
    camera.start()
    s = requests.Session()
    period = 1.0 / RATE_HZ
    reset = True
    try:
        for step in range(MAX_STEPS):
            t0 = time.time()
            frame = camera.latest()
            if frame is None:
                time.sleep(period)
                continue
            try:
                resp = s.post(f"{server}/infer", json={
                    "current": _jpeg_b64(frame), "goal": goal_b64, "reset": reset,
                }, timeout=3).json()
            except Exception as e:
                print(f"  infer failed: {str(e)[:60]}")
                relay.stop()
                time.sleep(period)
                continue
            reset = False
            if not resp.get("ok"):
                print(f"  policy error: {resp.get('error')}")
                relay.stop()
                continue
            v, w, dist = resp["linear_x"], resp["angular_z"], resp.get("dist_to_goal", -1)
            relay.send(v, w)
            print(f"  [{step:3d}] v={v:+.3f} w={w:+.3f} dist={dist:.2f}")
            # dist < 0 == not available (exploration mode) -> run to MAX_STEPS.
            if dist >= 0 and dist <= GOAL_DIST:
                print("  >> goal reached")
                break
            dt = time.time() - t0
            if dt < period:
                time.sleep(period - dt)
    finally:
        relay.stop()
    return True


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--goal", required=True, help="path to goal image (JPEG/PNG)")
    ap.add_argument("--server", default=SERVER)
    args = ap.parse_args()
    run(args.goal, server=args.server)
