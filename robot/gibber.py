"""
GibberLink — robot-to-robot data-over-sound (ggwave FSK tones), with a network
fallback so the demo never dies to venue noise.

Payloads are small JSON strings (wallet addr, signed challenge, payment confirm).
ggwave caps ~140 bytes/message — keep payloads tight; chunk if needed.
"""
import os
import threading
import time

import requests

PEER_URL = os.environ.get("PEER_ROBOT_URL")  # e.g. http://192.168.8.72:8000
FORCE_NETWORK = os.environ.get("GIBBER_NETWORK_ONLY") == "1"
# ggwave chirp is opt-in: it floods ALSA underruns on the Jetson and the
# espeak voice already gives audible, human-legible negotiation theater.
# Set GIBBER_CHIRP=1 for the "machine handshake sound" moment (e.g. the
# initial guard<->courier greeting), not the rapid auction.
CHIRP = os.environ.get("GIBBER_CHIRP") == "1"

_inbox = []  # network-fallback inbox (api.py can append via /gibber/send)


def _usb_device(kind: str):
    """Pick an audio device. kind: 'input' | 'output'. Overridable via env.

    Jetson gotcha: direct ALSA grab of the USB mic (hw:0/1) fails with
    'Device unavailable' (camera holds it / single-open). The Pulse layer
    mixes fine, so INPUT defaults to 'pulse'. OUTPUT to the USB PnP speaker
    (direct works and is louder) — fall back to default if absent."""
    import sounddevice as sd
    env = os.environ.get(f"GIBBER_{kind.upper()}_DEVICE")
    if env is not None:
        return int(env) if env.isdigit() else env
    if kind == "input":
        for i, d in enumerate(sd.query_devices()):
            if d["name"] == "pulse" and d["max_input_channels"] > 0:
                return i
        return None
    for i, d in enumerate(sd.query_devices()):  # output
        if "USB" in d["name"] and d["max_output_channels"] > 0:
            return i
    return None


def _audio_send(payload: str):
    import ggwave
    import sounddevice as sd
    import numpy as np
    vol = 25 if os.environ.get("NIGHT") == "1" else 80   # quiet for night testing
    waveform = ggwave.encode(payload, protocolId=1, volume=vol)
    audio = np.frombuffer(waveform, dtype=np.float32)
    sd.play(audio, samplerate=48000, blocking=True, device=_usb_device("output"))


def _audio_recv(timeout_secs: float):
    import ggwave
    import sounddevice as sd
    instance = ggwave.init()
    deadline = time.time() + timeout_secs
    try:
        with sd.InputStream(samplerate=48000, channels=1, dtype="float32",
                            blocksize=4096, device=_usb_device("input")) as stream:
            while time.time() < deadline:
                block, _ = stream.read(4096)
                res = ggwave.decode(instance, block.tobytes())
                if res:
                    return res.decode()
    finally:
        ggwave.free(instance)
    return None


def send(payload: str):
    """Mirror over network (reliable, instant) + chirp audibly (best-effort,
    async so a slow/underrunning audio device never blocks negotiation)."""
    if PEER_URL:  # reliable machine channel — do this FIRST, synchronously
        try:
            requests.post(f"{PEER_URL}/gibber/inbox",
                          json={"payload": payload}, timeout=5)
        except Exception as e:
            print(f"gibber mirror failed ({e})")
    if CHIRP and not FORCE_NETWORK:  # opt-in "machine sound" — fire and forget
        def _chirp():
            try:
                _audio_send(payload)
            except Exception as e:
                print(f"gibber audio send failed ({e})")
        threading.Thread(target=_chirp, daemon=True).start()


def recv(timeout_secs: float = 15, network_only: bool = False):
    """Listen for a payload. Checks the reliable network mirror FIRST (instant),
    then (unless network_only) listens to audio in short slices so a long
    timeout stays responsive to inbox arrivals.

    network_only=True is the deterministic path for negotiation: SEND still
    chirps audibly (the show), but RECV just polls the mirror — no per-call
    audio-stream open (which is slow/flaky and needs a configured mic)."""
    deadline = time.time() + timeout_secs
    while True:
        if _inbox:                       # network mirror — instant + reliable
            return _inbox.pop(0)
        remaining = deadline - time.time()
        if remaining <= 0:
            return None
        if FORCE_NETWORK or network_only:
            time.sleep(min(0.2, remaining))  # poll inbox only
            continue
        try:
            got = _audio_recv(min(1.5, remaining))  # short slice, then re-check inbox
            if got:
                return got
        except Exception as e:
            print(f"gibber audio recv failed ({e})")
            time.sleep(min(0.2, max(0, deadline - time.time())))


def inbox_push(payload: str):
    _inbox.append(payload)
