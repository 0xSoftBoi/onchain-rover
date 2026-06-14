"""
Phase 4 — RoboOS Cerebellum SKILL LIBRARY for the Waveshare wheeled rover.

RoboOS (FlagOpen, Apache-2.0) is a Brain-Cerebellum hierarchy: a master MLLM
(Brain) decomposes a task across robots; each robot runs a slaver (Cerebellum)
that exposes a plug-and-play skill library and coordinates via Real-Time Shared
Memory (Redis). This file is the skill library for our rover — drop it in as a
slaver profile (it mirrors slaver/profile/robot_tools.py: each skill is a function
whose typed docstring becomes the tool schema the Brain calls).

Embodiment = WHEELED chassis (RoboOS @chasis_class_decorator). Skills wrap the
endpoints we already run: the per-robot FastAPI (api.py, :8000) and the crypto
sidecar (x402 on Arc, :4021). Role-tagged so the Brain assigns Guard vs Courier
skills emergently (cf. EMOS 'robot resume') instead of a hardcoded script.

Coordinate via roboos_memory.SharedMemory so both agents see each other's pose +
state. Each skill returns a short observation string (what RoboOS tools return).

Wire into RoboOS:
    git clone https://github.com/FlagOpen/RoboOS      # stand-alone branch = v2.0
    # point slaver/profile at this module's SKILLS; run redis + master + 2 slavers
    redis-server & python master/run.py & ROLE=courier python slaver/run.py
"""
import os

import requests

ROBOT_API = os.environ.get("ROBOT_API", "http://localhost:8000")
SIDECAR = os.environ.get("SIDECAR_URL", "http://localhost:4021")
ROLE = os.environ.get("ROVER", "courier")        # courier | guard

EMBODIMENT = "wheeled"                            # RoboOS chassis class


def _call(method, url, *, json_body=None, params=None, timeout=60):
    """One HTTP call that never raises — returns a dict (RoboOS skills must not
    crash the Cerebellum loop; a failed skill is an observation, not an abort)."""
    try:
        r = requests.request(method, url, json=json_body, params=params, timeout=timeout)
        try:
            return r.json()
        except ValueError:
            return {"raw": r.text[:200], "status": r.status_code}
    except Exception as e:
        return {"error": str(e)[:160]}


# --- shared (any embodiment) ----------------------------------------------
def navigate_to_target(target: str) -> str:
    """Autonomously drive the wheeled rover to a target using the onboard visual
    navigation stack (NoMaD foundation model + RoboBrain goal-direction).
    Args:
        target: String, the natural-language navigation destination (e.g. "the
            checkpoint", "booth 12").
    """
    r = _call("POST", f"{ROBOT_API}/task",
              json_body={"task": f"go to {target} and stop", "autonomous": True})
    return f"navigate_to_target({target}) -> {r.get('telemetry', r)}"


def capture_proof(subject: str = "the scene") -> str:
    """Photograph the current view as proof-of-action and hash it.
    Args:
        subject: String, what the photo should show (for the verifier prompt).
    """
    r = _call("POST", f"{ROBOT_API}/capture")
    return f"capture_proof({subject}) -> {r}"


def speak(text: str) -> str:
    """Say something out loud through the rover's speaker.
    Args:
        text: String, the utterance.
    """
    _call("POST", f"{ROBOT_API}/say", json_body={"text": text})
    return f"speak -> {text!r}"


def store_proof_onchain() -> str:
    """Upload the latest captured proof to Walrus and return its blob id."""
    return f"store_proof_onchain -> {_call('POST', f'{ROBOT_API}/store-proof', timeout=120)}"


# --- courier skills --------------------------------------------------------
def announce_identity() -> str:
    """(Courier) Chirp a signed identity challenge over GibberLink so the guard
    can verify the courier is a registered agent."""
    ch = _call("POST", f"{SIDECAR}/challenge", json_body={"robot": "courier"})
    _call("POST", f"{ROBOT_API}/gibber/send", json_body={"payload": str(ch)}, timeout=40)
    return f"announce_identity -> {ch}"


def pay_for_passage(amount: float, to: str = "guard") -> str:
    """(Courier) Settle a USDC payment to the guard over x402/Arc.
    Args:
        amount: Float, the agreed price in USDC.
        to: String, the recipient role (default "guard").
    """
    r = _call("POST", f"{SIDECAR}/pay",
              json_body={"from": "courier", "to": to, "amt": str(amount)}, timeout=120)
    return f"pay_for_passage({amount}->{to}) -> {r}"


# --- guard skills ----------------------------------------------------------
def verify_agent(wallet: str = "", agent_id: str = "1") -> str:
    """(Guard) Verify a courier on-chain: signature + AgentBook + ERC-8004 +
    EventPass NFT. Returns whether the agent holds a valid pass.
    Args:
        wallet: String, the courier wallet address (from the heard challenge).
        agent_id: String, the courier's ERC-8004 agent id.
    """
    r = _call("POST", f"{SIDECAR}/verify-agent",
              json_body={"wallet": wallet, "agentId": agent_id}, timeout=60)
    return f"verify_agent -> holdsPass={r.get('holdsPass')}"


def admit() -> str:
    """(Guard) Open the checkpoint and admit the courier (physical payoff)."""
    return f"admit -> {_call('POST', f'{ROBOT_API}/admit')}"


def deny() -> str:
    """(Guard) Refuse passage to an unverified courier."""
    return f"deny -> {_call('POST', f'{ROBOT_API}/deny')}"


def negotiate_price(start: float = 2.0, floor: float = 0.5) -> str:
    """(Guard) Run a Dutch auction over GibberLink to settle a passage price.
    Args:
        start: Float, opening ask in USDC.
        floor: Float, lowest acceptable price.
    """
    r = _call("POST", f"{ROBOT_API}/negotiate/sell",
              json_body={"item": "EventPass", "start": start, "floor": floor,
                         "step": 0.25, "tick_secs": 4.0})
    return f"negotiate_price({start}->{floor}) -> {r}"


# Skill registry the slaver profile loads. Role-tagged so the Brain only offers
# each rover the skills its embodiment + role can perform.
SHARED = [navigate_to_target, capture_proof, speak, store_proof_onchain]
COURIER = [announce_identity, pay_for_passage]
GUARD = [verify_agent, admit, deny, negotiate_price]

SKILLS = SHARED + (GUARD if ROLE == "guard" else COURIER)

ROBOT_PROFILE = {
    "name": f"waveshare-ugv-{ROLE}",
    "embodiment": EMBODIMENT,                     # wheeled chassis
    "role": ROLE,
    "skills": [f.__name__ for f in SKILLS],
}


if __name__ == "__main__":
    import json
    print(json.dumps(ROBOT_PROFILE, indent=2))
