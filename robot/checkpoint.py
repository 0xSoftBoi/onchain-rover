"""
The Checkpoint orchestrator — sequences the LOCKED 90-second demo.
Runs on the laptop (or GUARD); calls both robot APIs + the Node sidecar.

Beats: hire courier (x402) -> courier drives to checkpoint -> speech greet ->
GibberLink handshake -> on-chain verify (REJECT: no pass) -> robot-to-robot
USDC payment -> mint pass -> re-check ADMIT -> task + Gemini/Walrus proof ->
ERC-8004 feedback -> leaderboard tick.
"""
import json
import os
import time

import requests

GUARD = os.environ.get("GUARD_URL", "http://192.168.8.71:8000")
COURIER = os.environ.get("COURIER_URL", "http://192.168.8.72:8000")
SIDECAR = os.environ.get("SIDECAR_URL", "http://192.168.8.10:4021")


def step(name, fn):
    print(f"\n=== {name} ===")
    out = fn()
    print(json.dumps(out, indent=2)[:400])
    return out


def run():
    # 1. courier drives to the checkpoint (guard wears an AprilTag)
    step("courier: seek checkpoint", lambda: requests.post(
        f"{COURIER}/seek", json={"target": "tag:0", "timeout_secs": 45},
        timeout=60).json())

    # 2. speech greet -> recognize AI -> switch to GibberLink
    step("greet", lambda: requests.post(
        f"{COURIER}/say", json={"text": "Hello, I have a delivery."},
        timeout=30).json())
    step("guard greets back", lambda: requests.post(
        f"{GUARD}/say",
        json={"text": "You sound like an agent. Switching to GibberLink."},
        timeout=30).json())

    # 3. GibberLink: courier chirps its wallet + signed challenge
    challenge = step("sidecar: build challenge", lambda: requests.post(
        f"{SIDECAR}/challenge", json={"robot": "courier"}, timeout=30).json())
    step("courier: chirp identity", lambda: requests.post(
        f"{COURIER}/gibber/send",
        json={"payload": json.dumps(challenge)}, timeout=60).json())
    heard = step("guard: listen", lambda: requests.get(
        f"{GUARD}/gibber/recv", params={"timeout_secs": 20}, timeout=30).json())

    # 4. guard verifies on-chain: ERC-8004 + World human-backing + pass NFT
    verify = step("guard: on-chain verify", lambda: requests.post(
        f"{SIDECAR}/verify-agent",
        json=json.loads(heard["payload"]), timeout=60).json())

    if not verify.get("holdsPass"):
        step("guard: DENY (imposter beat)", lambda: requests.post(
            f"{GUARD}/deny", timeout=30).json())
        # 5. courier pays guard robot-to-robot (x402 on Arc) -> mint pass
        step("courier pays guard (x402/Arc)", lambda: requests.post(
            f"{SIDECAR}/pay",
            json={"from": "courier", "to": "guard", "amt": "0.50"},
            timeout=120).json())
        step("mint EventPass", lambda: requests.post(
            f"{SIDECAR}/mint-pass", json={"robot": "courier"},
            timeout=120).json())

    # 6. re-check -> ADMIT
    step("guard: ADMIT", lambda: requests.post(
        f"{GUARD}/admit", timeout=30).json())

    # 7. courier completes task -> Gemini verdict -> Walrus proof
    step("courier: capture proof", lambda: requests.post(
        f"{COURIER}/capture", timeout=30).json())
    verdict = step("gemini verdict", lambda: requests.post(
        f"{COURIER}/verify-photo",
        json={"target": "delivery at the checkpoint"}, timeout=60).json())
    blob = step("walrus store", lambda: requests.post(
        f"{COURIER}/store-proof", timeout=120).json())

    # 8. requester writes ERC-8004 feedback -> leaderboard ticks
    step("ERC-8004 giveFeedback", lambda: requests.post(
        f"{SIDECAR}/give-feedback",
        json={"robot": "courier", "skill": "deliver",
              "score": int(verdict.get("confidence", 0.9) * 100),
              "blobId": blob["blobId"], "sha256": blob["sha256"]},
        timeout=120).json())
    step("leaderboard", lambda: requests.get(
        f"{SIDECAR}/leaderboard", timeout=60).json())

    print("\n=== DEMO COMPLETE — Ledger withdrawal climax runs in the web UI ===")


if __name__ == "__main__":
    run()
