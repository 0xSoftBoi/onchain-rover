"""
Robot FastAPI — the LAN-only interface contract surface for one rover.

Payment/auth lives in the Node sidecar (x402 Gateway); this API is trusted-LAN
only. Wraps rover.py + agent.py + perception/proof/gibber/voice modules.

Run on the Jetson (stop the stock app first — it owns serial + camera):
    pgrep -f '[a]pp.py' | xargs -r kill
    ROBOT_ROLE=guard ~/ugv_jetson/ugv-env/bin/python -m uvicorn api:app --host 0.0.0.0 --port 8000
"""
import hashlib
import os
import time

from fastapi import FastAPI, WebSocket
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import camera

import threading

import agent
import gibber
import negotiate
import perception
import proof as proofmod
import voice
import world_verify
from rover import Rover

ROLE = os.environ.get("ROBOT_ROLE", "guard")  # guard | courier
SIDECAR_URL = os.environ.get("SIDECAR_URL")    # e.g. http://192.168.x.x:4021
app = FastAPI(title=f"rover-{ROLE}")


@app.on_event("startup")
async def _start_heartbeat():
    """Announce our current IP to the sidecar every 10s so venue DHCP drift
    never breaks the demo (the sidecar derives our URL from the source IP)."""
    if not SIDECAR_URL:
        return
    import asyncio
    async def beat():
        while True:
            try:
                t = _live_rover().telemetry() or {}
                requests.post(f"{SIDECAR_URL}/robot/heartbeat",
                              json={"role": ROLE, "port": 8000,
                                    "battery": t.get("v", 0) / 100.0}, timeout=4)
            except Exception:
                pass
            await asyncio.sleep(10)
    asyncio.get_event_loop().create_task(beat())


class SeekReq(BaseModel):
    target: str           # open-vocab ("person in red lanyard") or "tag:<id>"
    timeout_secs: float = 30


class TaskReq(BaseModel):
    task: str
    dry_run: bool = False


class TextReq(BaseModel):
    text: str
    voice: str | None = None   # "texas" | "robot" (default)


class GibberReq(BaseModel):
    payload: str          # already-serialized JSON string to chirp


class WorldVerifyReq(BaseModel):
    idkit_result: dict    # forwarded AS-IS from IDKit
    action: str


@app.get("/health")
def health():
    try:
        t = _live_rover().telemetry() or {}
        return {"ok": True, "role": ROLE, "battery_v": t.get("v", 0) / 100.0}
    except Exception as e:  # serial busy / unplugged
        return {"ok": False, "role": ROLE, "error": str(e)}


@app.post("/task")
def task(req: TaskReq):
    """Full NL task -> plan -> drive -> photo proof. (Sidecar gates payment.)"""
    return agent.execute_task(req.task, dry_run=req.dry_run,
                              rover=_live_rover())


@app.post("/seek")
def seek(req: SeekReq):
    """Vision-guided seek: Gemini open-vocab with AprilTag fallback."""
    return perception.seek(req.target, timeout_secs=req.timeout_secs,
                           rover=_live_rover())


@app.post("/capture")
def capture():
    path, digest = agent.capture_photo()
    return {"photo": path, "sha256": digest}


@app.get("/stream")
def stream():
    """MJPEG live feed (browser <img src> / dashboard / race view). Shares the
    one camera with capture+seek via camera.py — no /dev/video0 contention."""
    boundary = "frame"

    def gen():
        import time as _t
        while True:
            jpg = camera.jpeg(quality=65)
            if jpg:
                yield (b"--" + boundary.encode() + b"\r\n"
                       b"Content-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n")
            _t.sleep(0.066)  # ~15 fps

    return StreamingResponse(
        gen(), media_type=f"multipart/x-mixed-replace; boundary={boundary}")


@app.post("/verify-photo")
def verify_photo(req: SeekReq):
    """Gemini verdict on the latest proof photo: did we accomplish `target`?"""
    return proofmod.gemini_verdict("/tmp/rover_proof.jpg", req.target)


@app.post("/store-proof")
def store_proof():
    """Push latest proof photo to Walrus; return blobId + sha256."""
    path = "/tmp/rover_proof.jpg"
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    blob_id = proofmod.walrus_put(path)
    return {"blobId": blob_id, "sha256": digest}


@app.post("/gibber/send")
def gibber_send(req: GibberReq):
    gibber.send(req.payload)
    return {"sent": True, "bytes": len(req.payload)}


@app.post("/gibber/inbox")
def gibber_inbox(req: GibberReq):
    """Network-fallback mirror target — peer robot drops payloads here."""
    gibber.inbox_push(req.payload)
    return {"queued": True}


@app.get("/gibber/recv")
def gibber_recv(timeout_secs: float = 15):
    payload = gibber.recv(timeout_secs=timeout_secs)
    return {"payload": payload}


@app.post("/worldid/verify")
def worldid(req: WorldVerifyReq):
    return world_verify.verify(req.idkit_result, req.action)


@app.post("/say")
def say(req: TextReq):
    voice.say(req.text, voice=req.voice)
    return {"ok": True}


@app.post("/admit")
def admit():
    """Green-light beat: lights, OLED, voice, gimbal nod."""
    r = _live_rover()
    r.lights(255, 255)
    r.oled(0, "ACCESS GRANTED")
    r.gimbal(0, 30); time.sleep(0.4); r.gimbal(0, 0)  # nod
    voice.say("Access granted. Welcome in.")
    return {"admitted": True}


@app.post("/deny")
def deny():
    r = _live_rover()
    r.lights(0, 0)
    r.oled(0, "ACCESS DENIED")
    voice.say("Access denied. No valid pass detected.")
    return {"admitted": False}


# --- pilot mode (Rover GP) — persistent serial connection for low latency ---
_rover = None
def _live_rover():
    global _rover
    if _rover is None:
        _rover = Rover()
    return _rover


class DriveReq(BaseModel):
    left: float
    right: float


@app.post("/drive")
def drive(req: DriveReq):
    """Raw wheel command — sidecar has already clamped speed + checked session.
    Opening Rover() per call costs ~0.2s; pilot mode keeps the port open."""
    _live_rover().drive(req.left, req.right)
    return {"ok": True}


# Pilot session tokens — sidecar registers one after x402 payment; the WS
# below refuses connections without a live token. One pilot per robot.
_pilot_tokens: dict[str, float] = {}  # token -> expiry epoch


class PilotTokenReq(BaseModel):
    token: str
    ttl_secs: float = 120


@app.post("/pilot/authorize")
def pilot_authorize(req: PilotTokenReq):
    _pilot_tokens[req.token] = time.time() + req.ttl_secs
    return {"ok": True}


MAX_SPEED = 0.35
DEADMAN_SECS = 0.4   # no command for this long -> motors stop


@app.websocket("/ws/drive")
async def ws_drive(ws: WebSocket):
    """20 Hz pilot control (nipplejs -> {left,right,token}). Deadman watchdog
    stops the motors if commands cease; stale (>200ms) commands are dropped."""
    import asyncio
    from fastapi import WebSocketDisconnect
    await ws.accept()
    r = _live_rover()
    last_cmd = time.time()
    authed = False

    async def watchdog():
        while True:
            await asyncio.sleep(0.1)
            if time.time() - last_cmd > DEADMAN_SECS:
                r.stop()

    task = asyncio.get_event_loop().create_task(watchdog())
    try:
        while True:
            msg = await ws.receive_json()
            if not authed:
                exp = _pilot_tokens.get(msg.get("token", ""), 0)
                if exp < time.time():
                    await ws.close(code=4403)
                    return
                authed = True
            if msg.get("t") and time.time() - msg["t"] / 1000 > 0.2:
                continue  # stale command — drop, don't replay old inputs
            clamp = lambda v: max(-MAX_SPEED, min(MAX_SPEED, float(v)))
            r.drive(clamp(msg.get("left", 0)), clamp(msg.get("right", 0)))
            last_cmd = time.time()
    except WebSocketDisconnect:
        pass
    finally:
        task.cancel()
        r.stop()


# --- Dutch auction (robot-to-robot negotiation over GibberLink) -------------
_auction_results: dict[str, dict] = {}  # auctionId -> deal


class SellReq(BaseModel):
    item: str = "EventPass"
    start: float = 2.00
    floor: float = 0.50
    step: float = 0.25
    tick_secs: float = 4.0
    auctionId: str = "a1"


class BuyReq(BaseModel):
    budget: float = 1.25
    auctionId: str = "a1"
    timeout_secs: float = 40


@app.post("/negotiate/sell")
def negotiate_sell(req: SellReq):
    """GUARD: run the Dutch auction seller in the background. Poll /negotiate/result."""
    def _run():
        _auction_results[req.auctionId] = negotiate.run_seller(
            item=req.item, start=req.start, floor=req.floor, step=req.step,
            tick_secs=req.tick_secs, auction_id=req.auctionId)
    threading.Thread(target=_run, daemon=True).start()
    return {"started": True, "role": "seller", "auctionId": req.auctionId}


@app.post("/negotiate/buy")
def negotiate_buy(req: BuyReq):
    """COURIER: run the Dutch auction buyer in the background."""
    def _run():
        _auction_results[req.auctionId] = negotiate.run_buyer(
            budget=req.budget, auction_id=req.auctionId,
            timeout_secs=req.timeout_secs)
    threading.Thread(target=_run, daemon=True).start()
    return {"started": True, "role": "buyer", "auctionId": req.auctionId}


@app.get("/negotiate/result")
def negotiate_result(auctionId: str = "a1"):
    """Poll for the settled deal (agreed price)."""
    return _auction_results.get(auctionId, {"pending": True, "auctionId": auctionId})


class FinishWatchReq(BaseModel):
    tags: dict[int, str] = {1: "guard", 2: "courier"}  # tag id -> robot
    timeout_secs: float = 60


@app.post("/race/watch-finish")
def watch_finish(req: FinishWatchReq):
    """GUARD-only: block until a racer's tag crosses the finish line.
    Returns winner; the captured frame is the settle proof photo —
    follow with /verify-photo + /store-proof, then RaceMarket.settle()."""
    import finish_line
    return finish_line.watch_finish(req.tags, timeout_secs=req.timeout_secs)


@app.post("/stop")
def hard_stop():
    """Emergency stop — always reachable."""
    _live_rover().stop()
    return {"stopped": True}
