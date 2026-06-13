"""
Drag-race finish judge — a camera at the finish line looking ACROSS the
track. Each racer carries an ArUco tag (AprilTag 36h11 dict) on its nose.
First tag to cross the finish ROI wins.

SELF-CONTAINED (cv2 only, no rover deps) so it runs in two modes:
- Head-to-head (both rovers race): runs on the LAPTOP webcam at the line;
  the judge WALLET still signs RaceMarket.settle().
- Time-trial (guard judges): runs on the GUARD via /race/watch-finish.

Geometry: camera perpendicular to the lanes; the finish line is a vertical
band in the frame (FINISH_X_FRAC). A racer finishes when its tag centroid
enters the band with sufficient size (close = at the line, not far noise).
"""
import time

import cv2

_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11)
try:  # OpenCV >= 4.7
    _detector = cv2.aruco.ArucoDetector(_dict, cv2.aruco.DetectorParameters())
    def _detect_tags(gray):
        c, i, _ = _detector.detectMarkers(gray)
        return c, i
except AttributeError:  # Jetson 4.5.4
    _params = cv2.aruco.DetectorParameters_create()
    def _detect_tags(gray):
        c, i, _ = cv2.aruco.detectMarkers(gray, _dict, parameters=_params)
        return c, i

FINISH_X_FRAC = (0.45, 0.55)   # vertical band in frame = the line
MIN_AREA_FRAC = 0.002          # tag must be near, not across the room


def watch_finish(tag_to_robot: dict[int, str], timeout_secs: float = 60):
    """Block until the first tag crosses the line. Returns winner + proof photo.

    tag_to_robot: e.g. {1: "guard", 2: "courier"} (tag id on each racer's nose)
    """
    cap = cv2.VideoCapture(0)
    deadline = time.time() + timeout_secs
    try:
        while time.time() < deadline:
            ok, frame = cap.read()
            if not ok:
                time.sleep(0.05); continue
            h, w = frame.shape[:2]
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            corners, ids = _detect_tags(gray)
            if ids is None:
                continue
            for tag_corners, tag_id in zip(corners, ids.flatten()):
                if int(tag_id) not in tag_to_robot:
                    continue
                xs = tag_corners[0][:, 0]
                x_frac = float(xs.mean()) / w
                area = cv2.contourArea(tag_corners) / (w * h)
                if FINISH_X_FRAC[0] <= x_frac <= FINISH_X_FRAC[1] and area >= MIN_AREA_FRAC:
                    ts = time.time()
                    cv2.imwrite("/tmp/rover_proof.jpg", frame)  # the settle photo
                    return {
                        "winner": tag_to_robot[int(tag_id)],
                        "tagId": int(tag_id),
                        "finishedAt": ts,
                        "photo": "/tmp/rover_proof.jpg",
                    }
        return {"winner": None, "reason": "timeout"}
    finally:
        cap.release()
