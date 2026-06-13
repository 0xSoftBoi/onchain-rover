"""
World ID 4.0 backend verification (Track B gate).

Forward the IDKit result AS-IS to POST developer.world.org/api/v4/verify/{rp_id}.
Store (nullifier, action) unique — nullifier is a huge decimal, keep as string.
⚠️ rp_id (rp_...) != app_id (app_...); RP signature is generated server-side in
the sidecar/web layer — this module only does the backend verify + replay check.
"""
import json
import os
import pathlib

import requests

RP_ID = os.environ.get("WORLD_RP_ID", "")
SEEN_PATH = pathlib.Path("/tmp/world_nullifiers.json")


def _seen():
    if SEEN_PATH.exists():
        return json.loads(SEEN_PATH.read_text())
    return {}


def verify(idkit_result: dict, action: str):
    r = requests.post(
        f"https://developer.world.org/api/v4/verify/{RP_ID}",
        json=idkit_result, timeout=30)
    if r.status_code != 200:
        return {"ok": False, "status": r.status_code, "body": r.text[:300]}
    body = r.json()
    nullifier = str(
        (body.get("responses") or [{}])[0].get("nullifier", ""))

    seen = _seen()
    key = f"{nullifier}:{action}"
    if key in seen:
        return {"ok": False, "reason": "replay", "nullifier": nullifier}
    seen[key] = True
    SEEN_PATH.write_text(json.dumps(seen))
    return {"ok": True, "nullifier": nullifier, "action": action}
