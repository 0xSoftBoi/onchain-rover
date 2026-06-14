"""
Emote layer v2 — a research-grounded personality engine that gives each rover a
WALL-E-style character on top of the bare actuators in rover.py.

Design rules, each from the literature (see ROBOTICS.md / research notes):
  1. TWO-TIMESCALE AFFECT. Fast "emotion" dims (stimulated/happy/social/
     confident, à la Anki Cozmo/Vector) feed a slow "mood" (EMA). Mood is what
     colours idle behaviour, so a rejected courier *stays* down and recovers
     gradually instead of snapping back.  [Vector character study; Russell circumplex]
  2. ANTICIPATION BEFORE ACTION. Every gesture winds up (a small opposite move)
     before it acts, and settles after — the single best-supported lever for
     readability/intent.  [Apple ELEGNT; Takayama "Expressing Thought"; Disney/Nutty]
  3. EXPRESSION DECOUPLED FROM CONTROL. Motion is routed through one easing
     filter with per-persona character params (smoothness σ, responsiveness ρ),
     so two robots feel different without rewriting gestures.  [Nutty NMF]
  4. VOICE PARAMETRIZED BY AFFECT. espeak pitch/speed/amplitude are driven by
     mood: higher arousal → higher pitch + faster; positive valence → shorter,
     brighter. (Animal-vocalization biology applied to robot sound.)  [Sci Reports 2020]

It NEVER drives the wheels while the nav loop is active, and every hardware call
is wrapped so a missing actuator can't kill the demo (ROBOTICS.md graceful
degradation). The gimbal frame matches rover.py: gimbal(x, y), +x pans right,
+y tilts the head UP; neutral gaze is (0, 0).

Usage:
    from emote import Emoter
    e = Emoter.for_role(role="guard", rover=my_rover)   # or reads ROVER/ROBOT_ROLE
    e.start_idle()                  # background "alive" behaviour
    e.react("greeting")             # nudges affect + plays a gesture
    e.appraise_and_react(frame)     # Gemini looks at a frame -> unscripted reaction
    e.stop()
"""
import math
import os
import threading
import time
from dataclasses import dataclass, field

try:
    import voice
except Exception:
    voice = None


# ==========================================================================
# AFFECT — fast emotion dims + slow mood (rule 1)
# ==========================================================================
DIMS = ("stimulated", "happy", "social", "confident")


class Affect:
    """Four short-term emotion dims in [0,1] feeding a slow two-axis mood.

    valence (pleasant<->unpleasant) ≈ mix(happy, confident)
    arousal (active<->calm)         ≈ mix(stimulated, social)

    Emotions drift gently back to baseline (mood stability); mood is an EMA of
    the instantaneous valence/arousal so it lags — that lag IS the personality.
    """
    def __init__(self, baseline=None, drift_rate=0.03, mood_alpha=0.02):
        self.baseline = {d: 0.5 for d in DIMS}
        if baseline:
            self.baseline.update(baseline)
        self.dim = dict(self.baseline)
        self.drift_rate = drift_rate           # per-second pull toward baseline
        self.mood_alpha = mood_alpha           # EMA weight per tick
        self.mood_valence = self._inst_valence()
        self.mood_arousal = self._inst_arousal()
        self._cooldowns = {}                   # event -> earliest re-fire time

    def _inst_valence(self):
        return 0.6 * self.dim["happy"] + 0.4 * self.dim["confident"]

    def _inst_arousal(self):
        return 0.6 * self.dim["stimulated"] + 0.4 * self.dim["social"]

    def nudge(self, **deltas):
        for d, delta in deltas.items():
            if d in self.dim:
                self.dim[d] = max(0.0, min(1.0, self.dim[d] + delta))

    def tick(self, dt):
        """Drift emotions to baseline; advance the mood EMA. Call from idle loop."""
        for d in DIMS:
            b = self.baseline[d]
            self.dim[d] += (b - self.dim[d]) * min(1.0, self.drift_rate * dt)
        a = self.mood_alpha
        self.mood_valence += (self._inst_valence() - self.mood_valence) * a
        self.mood_arousal += (self._inst_arousal() - self.mood_arousal) * a

    def can_fire(self, event, cooldown):
        """Per-behaviour cool-down timer (Vector's habituation trick)."""
        now = _now()
        if self._cooldowns.get(event, 0) > now:
            return False
        self._cooldowns[event] = now + cooldown
        return True

    @property
    def valence(self):  # 0..1
        return self.mood_valence

    @property
    def arousal(self):  # 0..1
        return self.mood_arousal


def _now():
    return time.time()


# ==========================================================================
# PERSONA — what makes two robots distinct characters (rules 3 & 4)
# ==========================================================================
@dataclass
class Persona:
    name: str
    voice: str                       # base key into voice.VOICES
    # character params (Nutty σ/ρ): smoothness 0..1 (eased moves), responsiveness
    smoothness: float                # high = many eased steps, fluid
    responsiveness: float            # high = bigger/snappier wind-ups & moves
    # eyes (headlight PWM 0-255)
    eye_base: int
    eye_bright: int
    eye_dim: int
    # idle gaze
    gaze_range: int                  # deg of idle pan wander
    # voice base params (espeak): pitch 0-99, speed wpm, amp 0-200
    pitch_base: int
    speed_base: int
    amp_base: int
    # affect baseline biases — seeds the character's "default mood"
    affect_baseline: dict = field(default_factory=dict)
    vocalize: bool = True


COURIER = Persona(
    name="Courier", voice="robot",
    smoothness=0.25, responsiveness=0.9,        # snappy, restless rookie
    eye_base=140, eye_bright=255, eye_dim=40,
    gaze_range=28,
    pitch_base=55, speed_base=175, amp_base=200,
    affect_baseline={"stimulated": 0.65, "happy": 0.6, "social": 0.7,
                     "confident": 0.45},
)

GUARD = Persona(
    name="Guard", voice="texas",
    smoothness=0.85, responsiveness=0.45,        # smooth, deliberate veteran
    eye_base=110, eye_bright=255, eye_dim=60,
    gaze_range=12,
    pitch_base=30, speed_base=140, amp_base=200,
    affect_baseline={"stimulated": 0.35, "happy": 0.45, "social": 0.4,
                     "confident": 0.7},
)

PERSONAS = {"courier": COURIER, "guard": GUARD}


# ==========================================================================
# EMOTER — drives a Persona+Affect through a Rover
# ==========================================================================
class Emoter:
    def __init__(self, persona: Persona, rover=None):
        self.p = persona
        self.affect = Affect(baseline=persona.affect_baseline)
        self._rover = rover
        self._lock = threading.Lock()
        self._idle = False
        self._busy = False                 # pause idle motion during a gesture
        self._driving = False              # set True when nav owns the wheels
        self._pan = 0.0                    # tracked gaze (for eased slews)
        self._tilt = 0.0

    @classmethod
    def for_role(cls, role=None, rover=None):
        role = (role or os.environ.get("ROVER")
                or os.environ.get("ROBOT_ROLE") or "courier").lower()
        return cls(PERSONAS.get(role, COURIER), rover=rover)

    # --- plumbing ---------------------------------------------------------
    def _r(self):
        if self._rover is None:
            from rover import Rover
            self._rover = Rover()
        return self._rover

    def _safe(self, fn, *a, **k):
        try:
            fn(*a, **k)
        except Exception as e:
            print(f"emote: {getattr(fn,'__name__','call')} failed: {e}")

    def set_driving(self, on: bool):
        """Nav loop calls this. While driving, expression keeps the wheels free
        (gimbal + eyes + voice only) so it never fights the 4 Hz control loop."""
        self._driving = on

    # --- voice: parametrized by mood (rule 4) -----------------------------
    def _voice_args(self):
        v, a = self.affect.valence, self.affect.arousal
        amp = int(os.environ.get("AMP", self.p.amp_base))
        # arousal lifts pitch + speed; positive valence brightens a touch
        pitch = int(self.p.pitch_base + (a - 0.5) * 36 + (v - 0.5) * 12)
        speed = int(self.p.speed_base + (a - 0.5) * 70)
        amp = int(amp * (0.7 + 0.3 * a))
        pitch = max(0, min(99, pitch))
        return f"-s {speed} -p {pitch} -a {amp}".split()

    def say(self, text):
        if voice is None:
            return
        # Use the Texas voice variant for guard, else mood-parametrized espeak.
        if self.p.voice == "texas":
            self._safe(voice.say, text, "texas")
        else:
            try:
                voice._say_espeak(text, self._voice_args())
            except Exception as e:
                print(f"emote: say failed: {e}")

    def beep(self, kind="ok"):
        """Tiny non-verbal vocalization (shorter+brighter = positive valence)."""
        if not self.p.vocalize:
            return
        token = {"ok": "eh", "yes": "mm-hm", "no": "uh-uh",
                 "huh": "eh?", "sad": "aww", "wow": "woah"}.get(kind, "eh")
        self.say(token)

    # --- eyes & face ------------------------------------------------------
    def eyes(self, pwm):
        pwm = max(0, min(255, int(pwm)))
        self._safe(self._r().lights, pwm, pwm)

    def face(self, text, line=0):
        self._safe(self._r().oled, line, text)

    # --- gaze: one eased filter with anticipation (rules 2 & 3) -----------
    def _slew(self, pan, tilt, ease=None):
        """Move the head to (pan,tilt) through eased steps. σ sets step count;
        more steps = smoother. Tracks current gaze for the next wind-up."""
        steps = 1 + int(self.p.smoothness * 6) if ease is None else ease
        p0, t0 = self._pan, self._tilt
        for i in range(1, steps + 1):
            f = i / steps
            f = f * f * (3 - 2 * f)               # smoothstep easing
            self._safe(self._r().gimbal, p0 + (pan - p0) * f, t0 + (tilt - t0) * f)
            time.sleep(0.04)
        self._pan, self._tilt = pan, tilt

    def _act(self, pan, tilt, anticipate=True):
        """Anticipation-first head move: wind up opposite (scaled by ρ), then act,
        then a small settle/overshoot. This is the core expressive primitive."""
        if anticipate:
            wx = -math.copysign(6 * self.p.responsiveness, pan or 1)
            wy = -math.copysign(4 * self.p.responsiveness, tilt or 1)
            self._slew(self._pan + wx, self._tilt + wy, ease=2)
            time.sleep(0.06)
        self._slew(pan, tilt)
        # settle: tiny overshoot back to target
        self._slew(pan + math.copysign(3, pan or 1), tilt, ease=2)
        self._slew(pan, tilt, ease=2)

    # --- gesture library --------------------------------------------------
    def nod_yes(self):
        for _ in range(2):
            self._slew(0, 25, ease=3); self._slew(0, 5, ease=3)
        self._slew(0, 0, ease=3); self.beep("yes")

    def shake_no(self):
        for _ in range(2):
            self._slew(-18, 0, ease=3); self._slew(18, 0, ease=3)
        self._slew(0, 0, ease=3); self.beep("no")

    def curious_tilt(self):
        self.eyes(self.p.eye_bright)
        self._act(14, 18)
        self.beep("huh")
        self._slew(0, 0)

    def perk_up(self):
        self.eyes(self.p.eye_bright)
        self._act(0, 28)
        self.beep("ok")
        self._slew(0, 0)

    def droop_sad(self):
        self.eyes(self.p.eye_dim)
        self._act(0, -22)
        self.beep("sad")
        time.sleep(0.5)
        self._slew(0, 0)

    def suspicious(self):
        self.eyes(self.p.eye_bright)
        self._act(-16, 6); self._slew(16, 6, ease=4); self._slew(0, 0)

    def scan(self):
        for pan in (-self.p.gaze_range, self.p.gaze_range, 0):
            self._slew(pan, 8)

    def double_take(self):
        self._slew(20, 0, ease=2); self._slew(-20, 0, ease=2)
        self.curious_tilt()

    def excited_wiggle(self):
        """Happy body language — quick eye flash + shimmy. Skipped while nav drives."""
        self.eyes(self.p.eye_bright)
        if not self._driving:
            r = self._r()
            for _ in range(3):
                self._safe(r.turn, 0.25); time.sleep(0.12)
                self._safe(r.turn, -0.25); time.sleep(0.12)
            self._safe(r.stop)
        else:
            self.nod_yes()
        self.beep("wow")
        self._slew(0, 0)

    def data_pulse(self):
        """GibberLink handshake visual — eyes pulse like a modem talking."""
        for _ in range(4):
            self.eyes(self.p.eye_bright); time.sleep(0.12)
            self.eyes(self.p.eye_dim); time.sleep(0.12)
        self.eyes(self.p.eye_base)

    def blink(self):
        self.eyes(0); time.sleep(0.1); self.eyes(self.p.eye_base)

    GESTURES = ("nod_yes", "shake_no", "curious_tilt", "perk_up", "droop_sad",
                "suspicious", "scan", "double_take", "excited_wiggle",
                "data_pulse", "blink")

    def gesture(self, name):
        fn = getattr(self, name, None)
        if not callable(fn) or name not in self.GESTURES:
            print(f"emote: unknown gesture {name!r}")
            return
        self._busy = True
        with self._lock:
            self._safe(fn)
        self._busy = False

    # --- semantic reactions: nudge affect + play gesture (+ line) ----------
    # spec: gesture, affect-nudge dict, optional line. Persona-coloured.
    REACTIONS = {
        "greeting":  {"courier": ("perk_up", {"social": +0.2, "stimulated": +0.2}, None),
                      "guard":   ("scan", {"stimulated": +0.1}, None)},
        "handshake": {"courier": ("data_pulse", {"stimulated": +0.15}, None),
                      "guard":   ("data_pulse", {"stimulated": +0.1}, None)},
        "rejected":  {"courier": ("droop_sad", {"happy": -0.4, "confident": -0.3}, None),
                      "guard":   ("shake_no", {"confident": +0.1}, "No valid pass.")},
        "negotiate": {"courier": ("curious_tilt", {"stimulated": +0.2, "confident": -0.1}, None),
                      "guard":   ("suspicious", {"confident": +0.1}, None)},
        "admitted":  {"courier": ("excited_wiggle", {"happy": +0.5, "confident": +0.4}, None),
                      "guard":   ("nod_yes", {"happy": +0.1}, "Welcome in.")},
        "thinking":  {"courier": ("curious_tilt", {"stimulated": +0.1}, None),
                      "guard":   ("scan", {}, None)},
        "startled":  {"courier": ("double_take", {"stimulated": +0.4}, "whoa!"),
                      "guard":   ("perk_up", {"stimulated": +0.3}, "Hey now.")},
        "win":       {"courier": ("excited_wiggle", {"happy": +0.5}, None),
                      "guard":   ("nod_yes", {"confident": +0.2}, None)},
    }

    def react(self, event, cooldown=2.0):
        if not self.affect.can_fire(event, cooldown):
            return
        role = "guard" if self.p is GUARD else "courier"
        spec = self.REACTIONS.get(event, {}).get(role)
        if not spec:
            return
        gname, nudges, line = spec
        if nudges:
            self.affect.nudge(**nudges)
        self.gesture(gname)
        if line:
            self.say(line)

    # --- VLM appraisal: unscripted reaction to a camera frame -------------
    def appraise(self, frame_bgr):
        """Ask Gemini for an emotional appraisal of what the rover sees.
        Reuses the proof.py Gemini client. Returns a dict or None (degrades
        silently — never blocks the demo)."""
        try:
            import cv2
            from pydantic import BaseModel
            import proof as proofmod
            from google.genai import types

            if not proofmod.GEMINI_KEY:
                return None

            class Appraisal(BaseModel):
                reaction: str            # one of REACTIONS keys
                line: str                # <=5 words, robot-style
                valence: float           # 0..1
                arousal: float           # 0..1

            ok, jpg = cv2.imencode(".jpg", frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 70])
            if not ok:
                return None
            persona_brief = (f"You ARE the {self.p.name} rover's personality "
                             f"(a WALL-E-like robot). ")
            resp = proofmod._gemini().models.generate_content(
                model=proofmod.GEMINI_MODEL,
                contents=[
                    types.Part.from_bytes(data=jpg.tobytes(), mime_type="image/jpeg"),
                    persona_brief +
                    "Given what you see, choose ONE reaction from "
                    f"{list(self.REACTIONS)} and a <=5-word robot utterance. "
                    "Also rate your valence (0=sad,1=happy) and arousal "
                    "(0=calm,1=excited).",
                ],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json", response_schema=Appraisal),
            )
            return resp.parsed.model_dump() if resp.parsed else None
        except Exception as e:
            print(f"emote: appraise failed: {e}")
            return None

    def appraise_and_react(self, frame_bgr=None):
        """Capture (or accept) a frame, get a Gemini appraisal, apply it."""
        if frame_bgr is None:
            try:
                import camera
                frame_bgr = camera.latest()
            except Exception:
                frame_bgr = None
        if frame_bgr is None:
            return None
        ap = self.appraise(frame_bgr)
        if not ap:
            return None
        # nudge mood toward the appraised valence/arousal, then play the reaction
        self.affect.mood_valence += (ap["valence"] - self.affect.mood_valence) * 0.5
        self.affect.mood_arousal += (ap["arousal"] - self.affect.mood_arousal) * 0.5
        ev = ap.get("reaction")
        if ev in self.REACTIONS:
            self.react(ev, cooldown=0.0)
        if ap.get("line"):
            self.say(ap["line"])
        return ap

    # --- IMU "startled" watch ---------------------------------------------
    def watch_imu(self, period=0.3):
        """Background: react('startled') when picked up (big tilt) or bumped."""
        def loop():
            while self._idle:
                try:
                    r = self._r()
                    roll, pitch = r.tilt()
                    jolt = r.bumped()
                    if jolt or (pitch is not None and abs(pitch) > 35):
                        self.react("startled", cooldown=4.0)
                except Exception:
                    pass
                time.sleep(period)
        threading.Thread(target=loop, daemon=True).start()

    # --- idle "alive" loop: mood-coloured (rule 1) ------------------------
    def start_idle(self, watch_imu=False):
        if self._idle:
            return
        self._idle = True
        threading.Thread(target=self._idle_loop, daemon=True).start()
        if watch_imu:
            self.watch_imu()

    def _idle_loop(self):
        t0 = _now()
        last = t0
        last_glance = 0.0
        while self._idle:
            now = _now()
            dt = now - last
            last = now
            self.affect.tick(dt)
            if self._busy or self._driving:
                time.sleep(0.1); continue
            v, a = self.affect.valence, self.affect.arousal
            # breathing eyes: faster when aroused, brighter when positive
            breath_period = 6.0 - 3.0 * a            # 3s (excited) .. 6s (calm)
            phase = (now - t0) / max(0.5, breath_period) * 2 * math.pi
            lo = self.p.eye_dim
            hi = int(self.p.eye_base * (0.7 + 0.5 * v))
            pwm = lo + (hi - lo) * (0.5 + 0.5 * math.sin(phase))
            with self._lock:
                if not (self._busy or self._driving):
                    self._safe(self._r().lights, int(pwm), int(pwm))
            # wandering glance: more restless when aroused
            glance_period = 4.5 - 2.5 * a
            if now - last_glance > glance_period:
                last_glance = now
                pan = self.p.gaze_range * (0.4 + 0.6 * a) * math.sin(now * 0.7)
                with self._lock:
                    if not (self._busy or self._driving):
                        self._slew(int(pan), 4, ease=2 + int(self.p.smoothness * 4))
            time.sleep(0.1)

    def state(self):
        return {"persona": self.p.name,
                "valence": round(self.affect.valence, 3),
                "arousal": round(self.affect.arousal, 3),
                "dims": {d: round(v, 3) for d, v in self.affect.dim.items()}}

    def stop(self):
        self._idle = False
        time.sleep(0.05)
        self.eyes(self.p.eye_base)
        self._slew(0, 0, ease=4)


# ==========================================================================
# Manual demo:  ROVER=courier python emote.py   |   ROVER=guard python emote.py
# ==========================================================================
if __name__ == "__main__":
    e = Emoter.for_role()
    print(f"Persona: {e.p.name}  σ={e.p.smoothness} ρ={e.p.responsiveness}")
    e.start_idle()
    try:
        for ev in ("greeting", "thinking", "negotiate", "rejected", "admitted"):
            print(f"  react({ev!r})  mood->", e.state())
            e.react(ev, cooldown=0.0)
            time.sleep(2.0)
        print("final mood:", e.state())
    finally:
        e.stop()
        print("done.")
