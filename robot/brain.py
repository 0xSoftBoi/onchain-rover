"""
Negotiation reasoning — the robots actually THINK. Dual-backend:
  - local Ollama (gemma3:1b) on the Jetson — true edge autonomy, no network.
  - Gemini Flash (cloud) — faster (~1-2s) + much smarter reasoning.
NEGOTIATE_BACKEND picks the primary ("ollama" default | "gemini"); the OTHER is
the automatic fallback if the primary errors/times out (survives WiFi drops).
A deterministic heuristic is the final fallback so the demo never stalls.
"""
import json
import os

import requests

OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/generate")
MODEL = os.environ.get("NEGOTIATE_MODEL", "gemma3:1b")
BACKEND = os.environ.get("NEGOTIATE_BACKEND", "ollama").lower()  # ollama | gemini
GEMINI_KEY = os.environ.get("GEMINI_API_KEY")          # AI Studio path (AIza…)
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
# Vertex path (Google Cloud booth project): service account via
# GOOGLE_APPLICATION_CREDENTIALS + VERTEX_PROJECT + VERTEX_REGION.
VERTEX_PROJECT = os.environ.get("VERTEX_PROJECT")
VERTEX_REGION = os.environ.get("VERTEX_REGION", "us-central1")
_genai_client = None


def _gemini_client():
    """google-genai client — Vertex (service account) if VERTEX_PROJECT set,
    else AI Studio (api key). Cached."""
    global _genai_client
    if _genai_client is None:
        from google import genai
        if VERTEX_PROJECT:
            _genai_client = genai.Client(vertexai=True, project=VERTEX_PROJECT,
                                         location=VERTEX_REGION)
        else:
            _genai_client = genai.Client(api_key=GEMINI_KEY)
    return _genai_client


def _ask_ollama(prompt, timeout=12):
    r = requests.post(OLLAMA, json={
        "model": MODEL, "prompt": prompt, "stream": False,
        "format": "json", "options": {"temperature": 0.4, "num_predict": 120},
    }, timeout=timeout)
    return json.loads(r.json()["response"])


def _ask_gemini(prompt, timeout=12):
    # Vertex (booth service account) OR AI Studio (api key) via google-genai —
    # one path handles both auth modes.
    if VERTEX_PROJECT or GEMINI_KEY:
        from google.genai import types
        resp = _gemini_client().models.generate_content(
            model=GEMINI_MODEL, contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json", temperature=0.3,
                max_output_tokens=200))
        return json.loads(resp.text)
    raise RuntimeError("no Gemini credential (set GEMINI_API_KEY or VERTEX_PROJECT)")


def _ask(prompt, timeout=12):
    """Try the primary backend, fall back to the other on any failure.
    Returns the model used via the parsed dict's '_via' (for the dashboard)."""
    order = (["gemini", "ollama"] if BACKEND == "gemini" else ["ollama", "gemini"])
    last = None
    for be in order:
        try:
            d = _ask_gemini(prompt, timeout) if be == "gemini" else _ask_ollama(prompt, timeout)
            if isinstance(d, dict):
                d["_via"] = be
                return d
        except Exception as e:
            last = e
    raise last or RuntimeError("no backend")


def buyer_decision(price, budget, history, secs_left):
    """Buyer reasons: ACCEPT now or WAIT for a lower price? history = prices seen
    so far (descending). Real trade-off: waiting may get a better price, but the
    item could be taken or the auction could end. Returns {action, reason}."""
    if price > budget:
        return {"action": "wait", "via": "rule",
                "reason": f"{price:.2f} is over my {budget:.2f} budget"}
    drop = (history[-2] - history[-1]) if len(history) >= 2 else 0.0
    prompt = (
        f"You are a buyer agent in a Dutch auction (price falls each round). "
        f"Current price ${price:.2f}. Your max budget ${budget:.2f}. "
        f"Price history (high->low): {history}. Last drop ${drop:.2f}/round. "
        f"~{secs_left:.0f}s left. If you WAIT you might pay less, but a rival "
        f"buyer could take it or the auction could close at the floor. "
        f'Decide. Respond JSON: {{"action":"accept"|"wait","reason":"<8 words>"}}.')
    try:
        d = _ask(prompt)
        action = "accept" if str(d.get("action", "")).lower().startswith("a") else "wait"
        txt = str(d.get("reason", "")).strip()[:60] or (
            "at budget, low risk in waiting" if action == "accept"
            else "price still falling, hold")
        return {"action": action, "reason": txt, "via": d.get("_via", "?")}
    except Exception:
        # fallback: accept once we're within ~one decrement of budget or low on time
        margin = budget - price
        if margin <= drop or secs_left < 8:
            return {"action": "accept", "reason": "good price, low risk of waiting", "via": "rule"}
        return {"action": "wait", "reason": "price still falling, hold", "via": "rule"}


def seller_reserve(start, floor, demand):
    """Seller reasons about a reserve price given demand (0..1). High demand =>
    hold value (higher reserve, slower drops); low demand => move it. Returns
    {reserve, step, reason}."""
    prompt = (
        f"You are a seller agent running a Dutch auction for an event pass. "
        f"Start price ${start:.2f}, hard floor ${floor:.2f}. Demand signal "
        f"{demand:.2f} (0=nobody waiting, 1=crowd). Pick a reserve price (won't "
        f"sell below) and a per-round price step. High demand: hold value, small "
        f'steps. Low demand: move it. JSON: {{"reserve":<num>,"step":<num>,"reason":"<8 words>"}}.')
    # A Dutch auction MUST descend AND land in the buyer's range, so bound the
    # reserve low (gemma3:1b tends to "maintain value" = no deal) and keep the
    # step fine enough that an offer can hit the buyer's budget. The LLM still
    # picks within these guardrails (demand-sensitive) — real, but terminating.
    reserve_cap = floor + (start - floor) * 0.35  # reserve in [floor, ~35% of range]
    try:
        d = _ask(prompt)
        reserve = max(floor, min(reserve_cap, float(d.get("reserve", floor))))
        step = max(0.15, min(0.25, float(d.get("step", 0.25))))
        return {"reserve": round(reserve, 2), "step": round(step, 2),
                "reason": str(d.get("reason", ""))[:60], "via": d.get("_via", "?")}
    except Exception:
        reserve = floor + (start - floor) * demand * 0.4
        return {"reserve": round(reserve, 2), "step": 0.25,
                "reason": "demand-scaled reserve", "via": "rule"}


def warmup():
    """Load gemma3 into RAM with a tiny prompt so the first real decision isn't
    a ~9s cold-load. Call at robot startup (we now have the headroom)."""
    try:
        requests.post(OLLAMA, json={"model": MODEL, "prompt": "ok", "stream": False,
                                    "options": {"num_predict": 1}}, timeout=60)
    except Exception:
        pass
