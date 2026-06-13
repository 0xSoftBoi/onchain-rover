"""
Proof pipeline: Gemini perception/verdicts + Walrus storage. Pure Python.

Walrus (verified live): PUT publisher returns EITHER newlyCreated.blobObject.blobId
OR alreadyCertified.blobId — handle both. Gemini: google-genai, gemini-2.5-flash,
pydantic response_schema (NOT the OpenAI 'response_format' shape).
"""
import os

import cv2
import requests
from pydantic import BaseModel

WALRUS_PUBLISHER = os.environ.get(
    "WALRUS_PUBLISHER", "https://publisher.walrus-testnet.walrus.space")
WALRUS_AGGREGATOR = os.environ.get(
    "WALRUS_AGGREGATOR", "https://aggregator.walrus-testnet.walrus.space")
GEMINI_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_MODEL = "gemini-2.5-flash"

_client = None
def _gemini():
    global _client
    if _client is None:
        from google import genai
        _client = genai.Client(api_key=GEMINI_KEY)
    return _client


# --- Walrus ---------------------------------------------------------------
def walrus_put(path, epochs=5):
    """Store a file; return blobId (handles both response shapes)."""
    with open(path, "rb") as f:
        r = requests.put(f"{WALRUS_PUBLISHER}/v1/blobs?epochs={epochs}",
                         data=f.read(), timeout=60)
    r.raise_for_status()
    j = r.json()
    if "newlyCreated" in j:
        return j["newlyCreated"]["blobObject"]["blobId"]
    return j["alreadyCertified"]["blobId"]


def walrus_get(blob_id):
    r = requests.get(f"{WALRUS_AGGREGATOR}/v1/blobs/{blob_id}", timeout=60)
    r.raise_for_status()
    return r.content


# --- Gemini ----------------------------------------------------------------
class Locate(BaseModel):
    present: bool
    confidence: float       # 0..1
    x_frac: float           # bbox center x as fraction of width
    area_frac: float        # bbox area as fraction of frame


class Verdict(BaseModel):
    task_completed: bool
    confidence: float
    scene: str


def gemini_locate(frame, target):
    """Locate `target` in a BGR frame. Returns Locate dict or None on failure."""
    if not GEMINI_KEY:
        return None
    try:
        from google.genai import types
        ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if not ok:
            return None
        resp = _gemini().models.generate_content(
            model=GEMINI_MODEL,
            contents=[
                types.Part.from_bytes(data=jpg.tobytes(), mime_type="image/jpeg"),
                f"Locate: {target}. Report bbox center x (fraction of width) and "
                f"bbox area (fraction of frame). present=false if not visible.",
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json", response_schema=Locate),
        )
        out = resp.parsed
        return out.model_dump() if out and out.present else None
    except Exception:
        return None  # AprilTag fallback covers us


def gemini_verdict(photo_path, task):
    """Final proof verdict — feeds the ERC-8004 reputation record."""
    from google.genai import types
    data = open(photo_path, "rb").read()
    resp = _gemini().models.generate_content(
        model=GEMINI_MODEL,
        contents=[types.Part.from_bytes(data=data, mime_type="image/jpeg"),
                  f"Does this photo show the completed task: '{task}'? "
                  f"Describe the scene briefly."],
        config=types.GenerateContentConfig(
            response_mime_type="application/json", response_schema=Verdict),
    )
    return resp.parsed.model_dump()
