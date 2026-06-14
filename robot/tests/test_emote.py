"""
Unit tests for the personality/affect layer (emote.py). Pure-logic — no serial,
no camera, no audio: a fake rover records actuator calls and `voice` is stubbed,
so these run anywhere (laptop or Jetson).

    pytest robot/tests/test_emote.py -q
"""
import os
import sys
import types

ROBOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROBOT)

# stub voice before importing emote so no audio subprocess is spawned
if "voice" not in sys.modules:
    _v = types.ModuleType("voice")
    _v.say = lambda *a, **k: None
    _v._say_espeak = lambda *a, **k: None
    sys.modules["voice"] = _v

import emote  # noqa: E402


class FakeRover:
    """Records every actuator call instead of touching hardware."""
    def __init__(self):
        self.calls = []
        self.pitch = 0.0

    def gimbal(self, x, y, *a, **k):
        self.calls.append(("gimbal", round(float(x), 2), round(float(y), 2)))

    def lights(self, a, b):
        self.calls.append(("lights", int(a)))

    def oled(self, *a):
        self.calls.append(("oled",))

    def turn(self, s):
        self.calls.append(("turn", s))

    def stop(self):
        self.calls.append(("stop",))

    def tilt(self):
        return (0.0, self.pitch)

    def bumped(self):
        return False

    def gimbals(self):
        return [c for c in self.calls if c[0] == "gimbal"]


def make(role):
    return emote.Emoter.for_role(role=role, rover=FakeRover())


# ── affect core ────────────────────────────────────────────────────────────
def test_affect_dims_clamped():
    a = emote.Affect()
    a.nudge(happy=+5.0)
    assert a.dim["happy"] == 1.0
    a.nudge(happy=-9.0)
    assert a.dim["happy"] == 0.0


def test_mood_lags_then_recovers():
    """Rejection sags the mood (slowly, via EMA lag), then drift returns it
    toward baseline — the courier 'stays down' then recovers."""
    e = make("courier")
    v0 = e.affect.valence
    e.affect.nudge(happy=-0.4, confident=-0.3)
    # let the slow mood sag toward the lowered emotions, tracking the dip
    dip = e.affect.valence
    for _ in range(80):
        e.affect.tick(0.1)
        dip = min(dip, e.affect.valence)
    # the mood actually sagged (didn't snap)
    assert dip < v0
    # given lots of time, emotions drift to baseline and mood recovers above dip
    for _ in range(800):
        e.affect.tick(0.1)
    assert e.affect.valence > dip + 0.05


def test_cooldown_blocks_refire():
    a = emote.Affect()
    assert a.can_fire("x", 5.0) is True
    assert a.can_fire("x", 5.0) is False    # within cooldown


# ── persona distinctness ────────────────────────────────────────────────────
def test_personas_have_distinct_character():
    c, g = emote.COURIER, emote.GUARD
    assert c.responsiveness > g.responsiveness      # rookie snappier
    assert g.smoothness > c.smoothness              # veteran smoother
    assert c.pitch_base > g.pitch_base              # rookie higher-pitched
    # baseline moods differ: courier more aroused, guard more confident
    ec, eg = make("courier"), make("guard")
    assert ec.affect.arousal > eg.affect.arousal
    assert eg.affect.dim["confident"] > ec.affect.dim["confident"]


def test_smoothness_changes_step_count():
    """Higher σ ⇒ more eased gimbal steps for the same move."""
    c, g = make("courier"), make("guard")
    c.gesture("scan"); g.gesture("scan")
    assert len(g._rover.gimbals()) > len(c._rover.gimbals())


def test_role_fallback_defaults_courier():
    e = emote.Emoter.for_role(role="nonsense", rover=FakeRover())
    assert e.p is emote.COURIER


# ── anticipation (the headline expressive rule) ──────────────────────────────
def test_anticipation_winds_up_opposite():
    """_act to a +tilt should first move to a NEGATIVE tilt (the wind-up)."""
    e = make("guard")
    e._act(0, 25)
    tilts = [c[2] for c in e._rover.gimbals()]
    assert min(tilts) < 0          # wound up below zero before rising
    assert max(tilts) >= 24        # then reached the target


# ── gestures don't crash & respect the driving guard ─────────────────────────
def test_all_gestures_run():
    e = make("courier")
    for name in emote.Emoter.GESTURES:
        e.gesture(name)
    assert e._rover.calls            # something happened

def test_wiggle_yields_wheels_while_driving():
    e = make("courier")
    e.set_driving(True)
    e.gesture("excited_wiggle")
    assert not any(c[0] == "turn" for c in e._rover.calls)  # no wheel spin
    e2 = make("courier")
    e2.set_driving(False)
    e2.gesture("excited_wiggle")
    assert any(c[0] == "turn" for c in e2._rover.calls)     # spins when idle


# ── reactions move the mood + fire a gesture ─────────────────────────────────
def test_react_rejected_lowers_courier_happy():
    e = make("courier")
    h0 = e.affect.dim["happy"]
    e.react("rejected", cooldown=0.0)
    assert e.affect.dim["happy"] < h0
    assert e._rover.calls

def test_unknown_event_is_noop():
    e = make("guard")
    e.react("not-an-event", cooldown=0.0)   # must not raise


# ── voice params track mood ──────────────────────────────────────────────────
def test_voice_args_rise_with_arousal():
    e = make("courier")
    e.affect.mood_arousal = 0.1
    lo = e._voice_args()
    e.affect.mood_arousal = 0.9
    hi = e._voice_args()
    def pitch(args): return int(args[args.index("-p") + 1])
    def speed(args): return int(args[args.index("-s") + 1])
    assert pitch(hi) > pitch(lo)
    assert speed(hi) > speed(lo)


# ── IMU startled & VLM appraisal degrade safely (no hardware) ────────────────
def test_state_shape():
    e = make("guard")
    st = e.state()
    assert set(st) == {"persona", "valence", "arousal", "dims"}
    assert set(st["dims"]) == set(emote.DIMS)


def test_appraise_degrades_to_none():
    # On a host without cv2/genai/GEMINI key, appraise must return None, never
    # raise — the demo continues without the VLM reaction.
    e = make("courier")
    assert e.appraise(object()) is None
    assert e.appraise_and_react(frame_bgr=object()) is None
