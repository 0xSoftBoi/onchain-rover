"""Voice out for the rovers.

Default = espeak-ng: instant, robotic, and on-brand for two robots haggling
(piper TTS runs ~16s/utterance on the Jetson — too slow for a live auction).
Set VOICE_ENGINE=piper for the smoother human voice on non-time-critical lines.
"""
import os
import subprocess

ENGINE = os.environ.get("VOICE_ENGINE", "espeak")
PIPER_MODEL = os.environ.get(
    "PIPER_MODEL", os.path.expanduser("~/piper-tts/en_US-lessac-medium.onnx"))
PIPER_BIN = os.environ.get(
    "PIPER_BIN", os.path.expanduser("~/.local/bin/piper"))
# espeak: -s words/min, -p pitch, -a amplitude. Lower pitch = more "robot".
ESPEAK_ARGS = os.environ.get("ESPEAK_ARGS", "-s 165 -p 35 -a 200").split()
# Play straight to the USB audio card via aplay — Pulse defaults to the dead
# onboard jack on the Jetson. `aplay -L`/`/proc/asound/cards`: USB = card 1.
AUDIO_DEV = os.environ.get("AUDIO_DEV", "plughw:1,0")

# Named voice characters (espeak-ng args). The seller is a Texas auctioneer:
# American-English male variant, slower drawl, a touch of pitch swing.
VOICES = {
    "robot": "-s 165 -p 35 -a 200".split(),                  # courier/default
    "texas": "-v en-us+m3 -s 145 -p 45 -a 200 -g 8".split(),  # auctioneer drawl
}


def _say_espeak(text, args=None):
    # espeak-ng --stdout (WAV) | aplay -D <usb card>  (bypasses Pulse routing)
    p1 = subprocess.Popen(["espeak-ng", *(args or ESPEAK_ARGS), "--stdout", text],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    p2 = subprocess.Popen(["aplay", "-D", AUDIO_DEV, "-q"],
                          stdin=p1.stdout, stderr=subprocess.DEVNULL)
    p1.stdout.close()
    p2.wait(timeout=15)


def _say_piper(text):
    p1 = subprocess.Popen([PIPER_BIN, "--model", PIPER_MODEL, "--output-raw"],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    p2 = subprocess.Popen(["aplay", "-r", "22050", "-f", "S16_LE", "-t", "raw", "-"],
                          stdin=p1.stdout)
    p1.stdin.write(text.encode())
    p1.stdin.close()
    p2.wait(timeout=30)


def say(text: str, voice: str = None):
    """Speak text. voice: a key in VOICES ('robot' default, 'texas' auctioneer)."""
    try:
        if ENGINE == "piper" and not voice:
            _say_piper(text)
        else:
            _say_espeak(text, VOICES.get(voice))
    except Exception as e:
        print(f"voice failed: {e}")  # never let voice kill the demo
