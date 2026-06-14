"""
Reasoning emitter — streams a robot's LOCAL-LLM thoughts to the sidecar so the
dashboard can show what's actually happening inside the agent during the
negotiation (the "agent thinking" panel, DimOS-style). Fire-and-forget; never
blocks or breaks the demo.
"""
import os
import threading

import requests

SIDECAR = os.environ.get("SIDECAR_URL")
ROLE = os.environ.get("ROBOT_ROLE", "guard")
_S = requests.Session()


def emit(phase, text, kind="thought"):
    """Push one reasoning line to the dashboard. kind: thought|offer|decision|plan."""
    print(f"[{ROLE}:{phase}] {text}")          # still logs locally (terminal TUI)
    if not SIDECAR:
        return
    def _send():
        try:
            _S.post(f"{SIDECAR}/reason",
                    json={"robot": ROLE, "phase": phase, "text": text, "kind": kind},
                    timeout=3)
        except Exception:
            pass
    threading.Thread(target=_send, daemon=True).start()
