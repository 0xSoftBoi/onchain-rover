"""
Shared camera — ONE cv2.VideoCapture for the whole API, so MJPEG streaming,
proof capture, and the seek loop never fight over /dev/video0.

A background thread continuously grabs the latest frame; everyone reads the
latest snapshot. This unifies camera access the same way the Rover serial
singleton unifies the ESP32 port.
"""
import threading
import time

import cv2

_cap = None
_frame = None
_lock = threading.Lock()
_thread = None
_running = False


def _grab_loop():
    global _frame, _running
    while _running:
        if _cap is None:
            time.sleep(0.05); continue
        ok, f = _cap.read()
        if ok:
            with _lock:
                _frame = f
        else:
            time.sleep(0.02)


def start(index=0):
    """Open the camera and begin the grab thread (idempotent)."""
    global _cap, _thread, _running
    if _cap is not None:
        return
    _cap = cv2.VideoCapture(index)
    time.sleep(0.4)  # let exposure settle
    _running = True
    _thread = threading.Thread(target=_grab_loop, daemon=True)
    _thread.start()


def latest():
    """Return the most recent BGR frame (or None). Starts the camera on demand."""
    if _cap is None:
        start()
        time.sleep(0.5)
    with _lock:
        return None if _frame is None else _frame.copy()


def jpeg(quality=70):
    """Latest frame as JPEG bytes, or None."""
    f = latest()
    if f is None:
        return None
    ok, buf = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes() if ok else None
