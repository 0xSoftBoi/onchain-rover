"""
Phase 3 — off-board SEMANTIC BRAIN server (laptop GPU). RoboBrain 2.0 (BAAI, an
embodied-reasoning VLM) looks at the rover's camera frame + a natural-language
target and POINTS at where to go. This gives the goal DIRECTION and an ARRIVED
signal that the goal-masked NoMaD explorer (nav_policy_server.py) lacks.

    NomadNavigator (Jetson) --POST /think {image, goal}--> [this server]
                            <--{visible, bearing_deg, arrived, point}-- RoboBrain

Navigation is RoboBrain's "pointing" task: the prompt "Identify spot within
<goal>" returns a 2D point in RELATIVE 0-1000 coords (verified against
FlagOpen/RoboBrain2.0 inference.py). We turn that point into:
  * bearing_deg : signed heading to steer (+ = left, matches ros2_bridge / rover)
  * arrived     : target sitting low in the frame => we're on top of it

Backends (BRAIN_BACKEND env, auto-falls back to 'stub' if the model won't load):
  robobrain — BAAI/RoboBrain2.0-3B via transformers (AutoModelForImageTextToText
              + AutoProcessor + qwen_vl_utils). Reproduces the repo's exact
              pointing prompt + point regex; no repo clone needed.
  stub      — points at the brightest blob; lets you test the loop with no model.

parse_point / point_to_bearing / arrived_from_point are pure + unit-tested.

Run on the laptop:  BRAIN_BACKEND=robobrain uvicorn brain_service:app --host 0.0.0.0 --port 4051
"""
import base64
import math
import os
import re
import tempfile

import numpy as np
import cv2
from fastapi import FastAPI
from pydantic import BaseModel

HFOV = float(os.environ.get("BRAIN_HFOV", "70"))       # camera horizontal FOV deg
ARRIVE_Y = float(os.environ.get("BRAIN_ARRIVE_Y", "850"))  # y_rel (0-1000) => close
BACKEND = os.environ.get("BRAIN_BACKEND", "robobrain")
MODEL_ID = os.environ.get("BRAIN_MODEL", "BAAI/RoboBrain2.0-3B")

# exact point format from RoboBrain inference.py: "[(x, y)]" in 0-1000 rel coords
_POINT_RE = re.compile(r"\(\s*(\d+)\s*,\s*(\d+)\s*\)")


# --- pure helpers ----------------------------------------------------------
def decode_image(b64):
    raw = base64.b64decode(b64)
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image")
    return img


def parse_point(text):
    """First (x, y) tuple in RoboBrain's answer, as rel 0-1000. None if absent."""
    m = _POINT_RE.search(text or "")
    return (int(m.group(1)), int(m.group(2))) if m else None


def point_to_bearing(x_rel, hfov=HFOV):
    """Relative x (0-1000, 500=center) -> steer angle. Target on the RIGHT
    (x>500) -> turn right -> NEGATIVE bearing (+ = left in our convention)."""
    return -((x_rel - 500.0) / 500.0) * (hfov / 2.0)


def arrived_from_point(y_rel, thresh=ARRIVE_Y):
    """Target low in the frame (large y) means we're nearly on top of it."""
    return y_rel >= thresh


# --- brain backends --------------------------------------------------------
# Contract: locate(bgr, goal) -> answer_text (RoboBrain-style, may contain a point)
class StubBrain:
    name = "stub"

    def locate(self, bgr, goal):
        # point at the brightest column / row so the loop visibly responds
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape
        x = int(gray.mean(axis=0).argmax() / max(1, w) * 1000)
        y = int(gray.mean(axis=1).argmax() / max(1, h) * 1000)
        return f"The {goal} is at [({x}, {y})]"


class RoboBrain:
    """BAAI/RoboBrain2.0-3B via transformers. Reproduces the repo's pointing
    prompt + chat template exactly. Loaded lazily so import never needs torch."""
    name = "robobrain"

    def __init__(self):
        from transformers import AutoModelForImageTextToText, AutoProcessor
        from qwen_vl_utils import process_vision_info
        self._pvi = process_vision_info
        print(f"[brain] loading {MODEL_ID} ...")
        self.model = AutoModelForImageTextToText.from_pretrained(
            MODEL_ID, dtype="auto", device_map="auto")
        self.processor = AutoProcessor.from_pretrained(MODEL_ID)

    def locate(self, bgr, goal):
        # RoboBrain takes an image FILE/URL; write the frame to a temp jpg.
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
            cv2.imwrite(f.name, bgr)
            path = f.name
        try:
            # exact pointing prompt suffix from RoboBrain2.0 inference.py
            text = (f"Identify spot within {goal}. Please provide its 2D "
                    "coordinates. Your answer should be formatted as a tuple, "
                    "i.e. [(x, y)], where the tuple contains the x and y "
                    "coordinates of a point satisfying the conditions above.")
            messages = [{"role": "user", "content": [
                {"type": "image", "image": f"file://{path}"},
                {"type": "text", "text": text}]}]
            chat = self.processor.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True)
            image_inputs, video_inputs = self._pvi(messages)
            inputs = self.processor(text=[chat], images=image_inputs,
                                    videos=video_inputs, padding=True,
                                    return_tensors="pt").to(self.model.device)
            ids = self.model.generate(**inputs, max_new_tokens=256, do_sample=False)
            trimmed = [o[len(i):] for i, o in zip(inputs.input_ids, ids)]
            out = self.processor.batch_decode(
                trimmed, skip_special_tokens=True,
                clean_up_tokenization_spaces=False)
            return out[0] if out else ""
        finally:
            os.unlink(path)


def make_brain():
    if BACKEND == "robobrain":
        try:
            return RoboBrain()
        except Exception as e:
            print(f"[brain] RoboBrain unavailable ({str(e)[:120]}) — using stub")
    return StubBrain()


# --- API -------------------------------------------------------------------
app = FastAPI(title="rover semantic brain")
_brain = None


class ThinkReq(BaseModel):
    image: str                   # base64 JPEG — live frame
    goal: str = "the checkpoint" # natural-language target to locate


@app.on_event("startup")
def _load():
    global _brain
    _brain = make_brain()
    print(f"[brain] backend={_brain.name} model={MODEL_ID}")


@app.get("/health")
def health():
    return {"ok": True, "backend": _brain.name if _brain else None}


@app.post("/think")
def think(req: ThinkReq):
    try:
        bgr = decode_image(req.image)
    except Exception as e:
        return {"ok": False, "error": str(e)[:120], "visible": False}
    answer = _brain.locate(bgr, req.goal)
    pt = parse_point(answer)
    if pt is None:
        return {"ok": True, "backend": _brain.name, "visible": False,
                "bearing_deg": 0.0, "arrived": False, "answer": answer[:200]}
    x, y = pt
    return {"ok": True, "backend": _brain.name, "visible": True,
            "bearing_deg": round(point_to_bearing(x), 2),
            "arrived": arrived_from_point(y),
            "point": [x, y], "answer": answer[:200]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("BRAIN_PORT", "4051")))
