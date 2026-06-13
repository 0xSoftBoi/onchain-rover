"""
Hybrid seek (locked design): Gemini open-vocab locate with AprilTag fallback.

- Gemini path = the WOW ("find the person in the red lanyard") — used when
  confidence >= 0.6.
- AprilTag path = the NEVER-FAIL backbone — cv2.aruco DICT_APRILTAG_36h11,
  runs every frame (cheap); printed tags on all demo targets.
- Geofence via wheel odometry; speed capped low; hard-stop on timeout.
"""
import os
import time

import cv2

from rover import Rover
import proof as proofmod

SPEED = 0.18
TURN = 0.16
CLOSE_AREA_FRAC = 0.18      # bbox/tag fills this much of frame => "arrived"
GEOFENCE_ODO = int(os.environ.get("GEOFENCE_ODO", "4000"))  # odometry ticks

_aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11)
try:  # OpenCV >= 4.7 API
    _aruco_params = cv2.aruco.DetectorParameters()
    _detector = cv2.aruco.ArucoDetector(_aruco_dict, _aruco_params)
    def _detect_tags(gray):
        corners, ids, _ = _detector.detectMarkers(gray)
        return corners, ids
except AttributeError:  # Jetson ships 4.5.4
    _aruco_params = cv2.aruco.DetectorParameters_create()
    def _detect_tags(gray):
        corners, ids, _ = cv2.aruco.detectMarkers(gray, _aruco_dict,
                                                  parameters=_aruco_params)
        return corners, ids


def _apriltag_bearing(frame):
    """Return (x_center_frac, area_frac) of the largest tag, or None."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    corners, ids = _detect_tags(gray)
    if ids is None or len(corners) == 0:
        return None
    h, w = gray.shape
    best = max(corners, key=lambda c: cv2.contourArea(c))
    xs = best[0][:, 0]
    area = cv2.contourArea(best) / (w * h)
    return (float(xs.mean()) / w, float(area))


def seek(target, timeout_secs=30, rover=None):
    """Drive toward `target` until close. Returns outcome + proof photo.
    Pass an existing Rover to reuse an open serial port (api.py singleton)."""
    import contextlib
    cap = cv2.VideoCapture(0)
    deadline = time.time() + timeout_secs
    found_via = None
    try:
        ctx = contextlib.nullcontext(rover) if rover else Rover()
        with ctx as r:
            start = r.telemetry() or {}
            odo0 = abs(start.get("odl", 0)) + abs(start.get("odr", 0))
            while time.time() < deadline:
                ok, frame = cap.read()
                if not ok:
                    time.sleep(0.1); continue

                # geofence
                t = r.telemetry() or {}
                if abs(t.get("odl", 0)) + abs(t.get("odr", 0)) - odo0 > GEOFENCE_ODO:
                    r.stop()
                    return {"found": False, "reason": "geofence", "via": found_via}

                bearing = None
                tag = _apriltag_bearing(frame)        # cheap, every frame
                g = proofmod.gemini_locate(frame, target)  # may be slow/None
                if g and g.get("confidence", 0) >= 0.6:
                    bearing, area, found_via = g["x_frac"], g["area_frac"], "gemini"
                elif tag:
                    bearing, area, found_via = tag[0], tag[1], "apriltag"

                if bearing is None:
                    r.turn(TURN); time.sleep(0.35); r.stop()  # rotate-scan
                    continue
                if area >= CLOSE_AREA_FRAC:
                    r.stop()
                    cv2.imwrite("/tmp/rover_proof.jpg", frame)
                    return {"found": True, "via": found_via,
                            "photo": "/tmp/rover_proof.jpg"}
                # steer: simple proportional turn toward bearing
                err = bearing - 0.5
                r.drive(SPEED + err * TURN, SPEED - err * TURN)
                time.sleep(0.25)
                r.stop()
            return {"found": False, "reason": "timeout", "via": found_via}
    finally:
        cap.release()
