"""Voice out via piper-tts (already on the Jetsons) -> aplay."""
import os
import subprocess

PIPER_MODEL = os.environ.get(
    "PIPER_MODEL", os.path.expanduser("~/piper/en_US-lessac-medium.onnx"))


def say(text: str):
    try:
        p1 = subprocess.Popen(
            ["piper", "--model", PIPER_MODEL, "--output-raw"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        p2 = subprocess.Popen(
            ["aplay", "-r", "22050", "-f", "S16_LE", "-t", "raw", "-"],
            stdin=p1.stdout)
        p1.stdin.write(text.encode())
        p1.stdin.close()
        p2.wait(timeout=30)
    except Exception as e:
        print(f"voice failed: {e}")  # never let voice kill the demo
