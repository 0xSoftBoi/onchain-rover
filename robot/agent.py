"""
The Onchain Rover — autonomous agent loop.

Natural-language task  ->  local LLM (Ollama/gemma3)  ->  motion plan  ->
rover.py executes  ->  camera photo captured as proof-of-action.

This is the sponsor-agnostic spine. Onchain pieces (USDC escrow, ENS, World ID,
0G proof upload) wrap around execute_task() and proof_path.

NOTE: app.py (web UI) holds both the serial port and the camera. Stop it first:
    pgrep -f '[a]pp.py' | xargs -r kill
Run:  ./ugv-env/bin/python agent.py "drive forward a little and look around"
"""
import json
import sys
import time
import hashlib

import requests
import cv2

from rover import Rover

OLLAMA = "http://localhost:11434/api/generate"
MODEL = "gemma3:1b"

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


def plan(task):
    """Ask the local LLM to turn a task into a motion plan."""
    prompt = f"{SYSTEM}\n\nTask: {task}\n\nJSON:"
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


def capture_photo(path="/tmp/rover_proof.jpg"):
    # Use the shared camera (so MJPEG streaming + capture don't fight over
    # /dev/video0). Falls back to a direct open if the shared module is unused.
    frame = None
    try:
        import camera
        frame = camera.latest()
    except Exception:
        frame = None
    if frame is None:
        cap = cv2.VideoCapture(0)
        time.sleep(0.4)
        ok, frame = cap.read()
        cap.release()
        if not ok:
            raise RuntimeError("camera read failed")
    cv2.imwrite(path, frame)
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    return path, digest


def execute_task(task, dry_run=False, rover=None):
    """Run a NL task end to end. Returns a proof dict for the onchain layer.
    Pass an existing Rover to reuse an open serial port (api.py singleton)."""
    steps = plan(task)
    print(f"PLAN: {json.dumps(steps)}")
    proof = {"task": task, "steps": steps, "photo": None, "photo_sha256": None,
             "telemetry": None}
    if dry_run:
        return proof

    import contextlib
    ctx = contextlib.nullcontext(rover) if rover else Rover()
    with ctx as r:
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
                path, digest = capture_photo()
                proof["photo"], proof["photo_sha256"] = path, digest
                print(f"  -> PHOTO {path} sha256={digest[:16]}...")
        proof["telemetry"] = r.telemetry()
    return proof


if __name__ == "__main__":
    task = " ".join(sys.argv[1:]) or "look around and take a photo"
    dry = "--dry" in sys.argv
    if dry:
        task = task.replace("--dry", "").strip()
    result = execute_task(task, dry_run=dry)
    print("\nPROOF:", json.dumps({k: v for k, v in result.items()
                                  if k != "steps"}, indent=2))
