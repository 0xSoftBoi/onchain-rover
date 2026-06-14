"""
Phase 0 — off-board navigation POLICY SERVER (runs on a laptop GPU, not the
Jetson). A NoMaD / ViNT visual-navigation foundation model turns the rover's
live camera frame + a GOAL IMAGE into a steering command. The Jetson stays free
for camera capture + the real-time control loop (LeRobot async pattern).

    nomad_client.py (Jetson)  --POST /infer {current, goal}-->  [this server]
                              <--{linear_x, angular_z, dist}--   NoMaD on GPU

Backends (POLICY_BACKEND env, auto-falls back to 'stub' if NoMaD won't load):
  nomad  — general-navigation package (GNM/ViNT/NoMaD).  pip install general-navigation
           Wraps the package's own GPTVision.step() stepper EXACTLY: it manages a
           temporal context queue internally and runs the diffusion policy + MPC,
           returning a steer command in [-1, 1]. NOTE: the packaged NoMaD runs in
           goal-MASKED exploration mode (input_goal_mask=1 -> the goal image is
           ignored), so it does obstacle-aware forward navigation following a
           learned prior, NOT goal-image homing. The 'goal' field is accepted for
           API stability + the future goal-conditioned path (see GoalNomadPolicy).
  stub   — gentle constant forward; lets you test the whole client/bridge loop
           with NO model + NO robot, then swap in real weights.

decode_image and waypoint_to_twist are pure functions (unit-tested without torch).

Run on the laptop:  POLICY_BACKEND=nomad uvicorn nav_policy_server:app --host 0.0.0.0 --port 4041
"""
import base64
import math
import os

import numpy as np
import cv2
from fastapi import FastAPI
from pydantic import BaseModel

# Map the policy's steer command in [-1, 1] -> unicycle (linear_x, angular_z).
V_MAX = float(os.environ.get("NAV_V_MAX", "0.25"))  # m/s, matches rover clamp
W_MAX = float(os.environ.get("NAV_W_MAX", "1.2"))   # rad/s at full steer
# + steer in the driving model -> which way the rover yaws. ros2_bridge uses
# +angular_z = CCW/left. Flip this to -1 if the rover turns the wrong way.
STEER_SIGN = float(os.environ.get("NAV_STEER_SIGN", "1.0"))
STEER_SLOW = float(os.environ.get("NAV_STEER_SLOW", "0.6"))  # slow fwd in turns
# Waypoint controller gains (only the trajectory/goal path uses these).
K_V = float(os.environ.get("NAV_K_V", "0.6"))
K_W = float(os.environ.get("NAV_K_W", "1.2"))
BACKEND = os.environ.get("POLICY_BACKEND", "nomad")


def steer_to_twist(steer, v_max=V_MAX, w_max=W_MAX,
                   sign=STEER_SIGN, slow=STEER_SLOW):
    """MPC steer in [-1,1] -> (linear_x, angular_z). Ease off the throttle as the
    turn sharpens so the rover doesn't carve wide. Pure + testable."""
    s = max(-1.0, min(1.0, steer))
    w = sign * w_max * s
    v = v_max * (1.0 - slow * abs(s))
    return max(0.0, v), w


# --- pure helpers ----------------------------------------------------------
def decode_image(b64):
    """base64(JPEG/PNG) -> BGR ndarray. Raises on garbage."""
    raw = base64.b64decode(b64)
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image")
    return img


def waypoint_to_twist(dx, dy, k_v=K_V, k_w=K_W, v_max=V_MAX, w_max=W_MAX):
    """Next-waypoint offset (dx forward, dy left) -> clamped (linear_x, angular_z).
    Turn toward the waypoint; slow the forward speed when the heading error is
    large so the rover pivots before driving. Pure + testable."""
    heading = math.atan2(dy, dx)                      # rad, + = left
    w = max(-w_max, min(w_max, k_w * heading))
    # scale forward speed down as |heading| grows (cos falloff, no reverse)
    v = k_v * math.hypot(dx, dy) * max(0.0, math.cos(heading))
    v = max(0.0, min(v_max, v))
    return v, w


# --- policy backends -------------------------------------------------------
# Contract: infer(current_bgr, goal_bgr) -> (linear_x, angular_z, dist_to_goal).
# dist_to_goal < 0 means "not available" (exploration mode has no goal distance);
# the client then stops on NAV_MAX_STEPS instead of a distance threshold.
class StubPolicy:
    """No model: creep forward, steering toward the brighter half of the frame so
    the loop visibly responds. Lets you validate client+bridge before weights."""
    name = "stub"

    def reset(self):
        pass

    def infer(self, current, goal):
        h, w = current.shape[:2]
        left = float(current[:, : w // 2].mean())
        right = float(current[:, w // 2:].mean())
        steer = 0.8 * (left - right) / 255.0          # brighter-left -> steer left
        v, ang = steer_to_twist(steer)
        return v, ang, -1.0


class NomadPolicy:
    """general-navigation (NoMaD/ViNT/GNM) via the package's own GPTVision stepper.

    GPTVision owns the temporal context queue + runs the diffusion policy and MPC;
    we feed it a DroneState per frame and read controls.steer in [-1, 1]. Loaded
    lazily so importing this module never needs torch. Exploration mode (goal
    masked) -> no goal distance, returns dist = -1."""
    name = "nomad"

    def __init__(self):
        import torch
        from general_navigation.models.factory import get_default_config
        from general_navigation.gpt.gpt_vision import GPTVision
        device = "cuda" if torch.cuda.is_available() else "cpu"
        self.cfg = get_default_config()               # nomad.yaml
        self.gpt = GPTVision(self.cfg, device=device)
        self._last_steer = 0.0
        print(f"[policy] GPTVision loaded on {device} "
              f"(context_size={self.cfg['context_size']})")

    def reset(self):
        # clear the temporal buffers so a new run starts clean
        self.gpt.context_queue = []
        self.gpt.trajectory_history = []
        self._last_steer = 0.0

    def infer(self, current, goal):
        from general_navigation.schema.environment import DroneState
        from general_navigation.schema.image import Image
        state = DroneState(
            image=Image(data=current),                # validator JPEG-encodes BGR
            velocity_x=0.0, velocity_y=0.0, velocity_z=0.0,
            steering_angle=self._last_steer,
        )
        controls = self.gpt.step(state)               # warms up over context_size
        self._last_steer = controls.steer
        v, ang = steer_to_twist(controls.steer)
        return v, ang, -1.0


def make_policy():
    if BACKEND == "nomad":
        try:
            return NomadPolicy()
        except Exception as e:
            print(f"[policy] NoMaD unavailable ({str(e)[:120]}) — using stub")
    return StubPolicy()


# --- API -------------------------------------------------------------------
app = FastAPI(title="rover nav policy server")
_policy = None


class InferReq(BaseModel):
    current: str                 # base64 JPEG — live frame
    goal: str = ""               # base64 JPEG — goal image (unused in exploration)
    reset: bool = False          # clear the policy's temporal context (new run)


@app.on_event("startup")
def _load():
    global _policy
    _policy = make_policy()
    print(f"[policy] backend={_policy.name}")


@app.get("/health")
def health():
    return {"ok": True, "backend": _policy.name if _policy else None}


@app.post("/infer")
def infer(req: InferReq):
    if req.reset:
        _policy.reset()
    try:
        cur = decode_image(req.current)
        goal = decode_image(req.goal) if req.goal else None
    except Exception as e:
        return {"ok": False, "error": str(e)[:120],
                "linear_x": 0.0, "angular_z": 0.0}
    v, w, dist = _policy.infer(cur, goal)
    return {"ok": True, "backend": _policy.name,
            "linear_x": round(v, 4), "angular_z": round(w, 4),
            "dist_to_goal": round(dist, 4)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("NAV_PORT", "4041")))
