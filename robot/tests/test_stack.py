"""
Phase 5 — integration + unit tests for the autonomy stack. A pre-demo safety net:
run `pytest robot/tests` and a code change can't silently break the pipeline.

Tests degrade gracefully via pytest.importorskip — pure-logic tests run anywhere;
tests needing cv2/fastapi/serial skip when those aren't installed (e.g. a laptop
without the server extras), and run fully in the project venv / on the Jetson.

    pytest robot/tests -q
"""
import math
import os
import sys

import pytest

ROBOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROBOT)


# ── pure control math (no heavy deps) ──────────────────────────────────────
def test_twist_to_wheels_directions():
    from dimos_rover import twist_to_wheels
    # straight: equal wheels
    l, r = twist_to_wheels(0.2, 0.0)
    assert abs(l - r) < 1e-9
    # +angular (CCW/left) -> right wheel faster
    l, r = twist_to_wheels(0.2, 1.0)
    assert r > l
    # clamp to max speed
    l, r = twist_to_wheels(10.0, 0.0)
    assert max(abs(l), abs(r)) <= 0.351


def test_odom_integrator():
    from ros2_bridge import OdomIntegrator
    od = OdomIntegrator(scale=0.001, wheel_base=0.18)
    assert od.update(1000, 1000) == (0.0, 0.0, 0.0)        # seed, no motion
    x, y, th = od.update(1100, 1100)                        # +100 ticks both
    assert round(x, 3) == 0.1 and abs(y) < 1e-9 and abs(th) < 1e-9
    _, _, th2 = od.update(1100, 1200)                       # right ahead -> +yaw
    assert th2 > 0


def test_shared_memory_handshake():
    from roboos_memory import SharedMemory, _DictBackend
    _DictBackend._store = {}
    mem = SharedMemory(backend=_DictBackend(), clock=lambda: 100.0)
    mem.update("courier", action="at_checkpoint", x=1.2)
    assert mem.get("courier")["action"] == "at_checkpoint"
    assert mem.wait_for("courier", "action", "at_checkpoint", timeout=1)
    # timeout path with advancing clock
    t = [0.0]
    def clk():
        t[0] += 0.5; return t[0]
    m2 = SharedMemory(backend=_DictBackend(), clock=clk)
    assert m2.wait_for("guard", "action", "admitted", timeout=1, poll=0) is False


def test_roboos_profile_roles(monkeypatch):
    monkeypatch.setenv("ROVER", "guard")
    sys.modules.pop("roboos_profile", None)
    import roboos_profile as g
    assert g.ROBOT_PROFILE["embodiment"] == "wheeled"
    assert "admit" in g.ROBOT_PROFILE["skills"] and "pay_for_passage" not in g.ROBOT_PROFILE["skills"]
    monkeypatch.setenv("ROVER", "courier")
    sys.modules.pop("roboos_profile", None)
    import roboos_profile as c
    assert "pay_for_passage" in c.ROBOT_PROFILE["skills"] and "admit" not in c.ROBOT_PROFILE["skills"]


# ── nav policy server (needs cv2 + numpy) ──────────────────────────────────
def test_waypoint_and_steer_twist():
    pytest.importorskip("cv2"); pytest.importorskip("numpy"); pytest.importorskip("fastapi")
    import nav_policy_server as nps
    # waypoint: forward -> no turn; left -> +w; right -> -w; never reverses
    assert nps.waypoint_to_twist(1, 0)[1] == 0.0
    assert nps.waypoint_to_twist(0, 1)[1] > 0 and nps.waypoint_to_twist(0, -1)[1] < 0
    assert nps.waypoint_to_twist(-1, 0)[0] >= 0
    # steer: straight=max fwd/0 turn; clamps; eases throttle in turns
    assert nps.steer_to_twist(0)[1] == 0.0
    assert nps.steer_to_twist(2.0) == nps.steer_to_twist(1.0)
    assert nps.steer_to_twist(1.0)[0] < nps.steer_to_twist(0.2)[0]


def test_nav_server_stub_e2e():
    pytest.importorskip("cv2"); pytest.importorskip("fastapi")
    np = pytest.importorskip("numpy")
    import base64, cv2
    os.environ["POLICY_BACKEND"] = "stub"
    import importlib, nav_policy_server
    importlib.reload(nav_policy_server)
    from fastapi.testclient import TestClient
    with TestClient(nav_policy_server.app) as c:
        assert c.get("/health").json()["backend"] == "stub"
        img = np.full((128, 256, 3), 200, np.uint8)
        ok, buf = cv2.imencode(".jpg", img)
        b64 = base64.b64encode(buf.tobytes()).decode()
        r = c.post("/infer", json={"current": b64, "reset": True}).json()
        assert r["ok"] and "linear_x" in r and "angular_z" in r
        assert 0.0 <= r["linear_x"] <= 0.26


# ── brain server (needs cv2 + numpy) ───────────────────────────────────────
def test_brain_pure_helpers():
    pytest.importorskip("cv2"); pytest.importorskip("fastapi")
    import brain_service as bs
    assert bs.parse_point("at [(640, 880)]") == (640, 880)
    assert bs.parse_point("not visible") is None
    assert bs.point_to_bearing(500) == 0.0
    assert bs.point_to_bearing(1000) < 0 and bs.point_to_bearing(0) > 0   # right<0,left>0
    assert bs.arrived_from_point(900) and not bs.arrived_from_point(400)


def test_brain_server_stub_e2e():
    pytest.importorskip("cv2"); pytest.importorskip("fastapi")
    np = pytest.importorskip("numpy")
    import base64, cv2
    os.environ["BRAIN_BACKEND"] = "stub"
    import importlib, brain_service
    importlib.reload(brain_service)
    from fastapi.testclient import TestClient
    with TestClient(brain_service.app) as c:
        assert c.get("/health").json()["backend"] == "stub"
        img = np.zeros((128, 256, 3), np.uint8); img[:, 200:] = 255   # bright right
        ok, buf = cv2.imencode(".jpg", img)
        r = c.post("/think", json={"image": base64.b64encode(buf.tobytes()).decode(),
                                   "goal": "the checkpoint"}).json()
        assert r["ok"] and r["visible"] and "bearing_deg" in r


# ── fallback selection (needs agent.py deps) ───────────────────────────────
def test_make_navigator_falls_back_to_primitive(monkeypatch):
    pytest.importorskip("cv2"); pytest.importorskip("serial"); pytest.importorskip("requests")
    import importlib, agent
    importlib.reload(agent)
    # force the NoMaD health probe to fail; rclpy/Nav2 isn't installed -> primitive
    import requests
    def boom(*a, **k):
        raise RuntimeError("server down")
    monkeypatch.setattr(requests.Session, "get", boom)
    monkeypatch.setenv("ROVER_NAV", "auto")
    nav, name = agent.make_navigator(rover=object())
    assert name == "primitive"
    assert isinstance(nav, agent.PrimitiveNavigator)
