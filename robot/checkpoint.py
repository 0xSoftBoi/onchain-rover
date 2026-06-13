"""
The Checkpoint orchestrator — sequences Act 1, hardened to NEVER crash mid-demo.

Every beat is fail-safe: a failed call is logged and narrated, the show
continues. The physical spine (drive → greet → handshake → deny → auction →
admit) always completes; the crypto layer degrades gracefully (e.g. if the
payer wallet isn't funded, it narrates "settlement pending" and still admits).

Run on the laptop:  SIDECAR_URL=http://localhost:4021 python checkpoint.py
Robot URLs are auto-discovered from the sidecar's live registry (heartbeat),
falling back to GUARD_URL / COURIER_URL env.
"""
import json
import os
import sys
import time

import requests

SIDECAR = os.environ.get("SIDECAR_URL", "http://localhost:4021")
GUARD = os.environ.get("GUARD_URL", "http://172.16.1.29:8000")
COURIER = os.environ.get("COURIER_URL", "http://172.16.0.105:8000")

results = []  # (beat, ok) for the final summary


def call(method, url, *, json_body=None, params=None, timeout=30):
    """One HTTP call that never raises. Returns (ok, data)."""
    try:
        r = requests.request(method, url, json=json_body, params=params, timeout=timeout)
        try:
            data = r.json()
        except ValueError:
            data = {"raw": r.text[:200], "status": r.status_code}
        return (r.ok, data)
    except Exception as e:
        return (False, {"error": str(e)[:160]})


def beat(name, method, url, *, json_body=None, params=None, timeout=30, critical=False):
    """Run a demo beat. Prints result, records it, continues unless critical."""
    print(f"\n=== {name} ===")
    ok, data = call(method, url, json_body=json_body, params=params, timeout=timeout)
    print(("  ✓ " if ok else "  ✗ ") + json.dumps(data)[:280])
    results.append((name, ok))
    if critical and not ok:
        print(f"\n‼️  critical beat failed: {name} — aborting cleanly.")
        summary()
        sys.exit(1)
    return ok, data


def say(robot_url, text, voice=None):
    body = {"text": text}
    if voice:
        body["voice"] = voice
    call("POST", f"{robot_url}/say", json_body=body, timeout=20)


def discover():
    """Resolve live robot URLs from the sidecar heartbeat registry; fall back
    to env. Confirms both robots + sidecar are up before the demo starts."""
    global GUARD, COURIER
    ok, reg = call("GET", f"{SIDECAR}/robot/registry", timeout=8)
    if ok and isinstance(reg, dict):
        if reg.get("guard", {}).get("url"):
            GUARD = reg["guard"]["url"]
        if reg.get("courier", {}).get("url"):
            COURIER = reg["courier"]["url"]
    print(f"guard={GUARD}  courier={COURIER}  sidecar={SIDECAR}")
    # health gate (critical — no point starting if a robot is dark)
    gok, _ = call("GET", f"{GUARD}/health", timeout=6)
    cok, _ = call("GET", f"{COURIER}/health", timeout=6)
    sok, _ = call("GET", f"{SIDECAR}/health", timeout=6)
    print(f"preflight: guard={'up' if gok else 'DOWN'} "
          f"courier={'up' if cok else 'DOWN'} sidecar={'up' if sok else 'DOWN'}")
    if not (gok and cok and sok):
        print("\n‼️  a participant is down — fix before demo (see /robot/registry).")
        sys.exit(1)


def summary():
    print("\n" + "─" * 46)
    for name, ok in results:
        print(f"  {'✓' if ok else '✗'} {name}")
    wins = sum(1 for _, ok in results if ok)
    print(f"  {wins}/{len(results)} beats ok")


def run():
    print("THE CHECKPOINT — Act 1\n" + "─" * 46)
    discover()

    # 1. courier drives to the checkpoint (guard wears AprilTag id 0)
    ok, _ = beat("courier: seek checkpoint", "POST", f"{COURIER}/seek",
                 json_body={"target": "tag:0", "timeout_secs": 45}, timeout=60)
    if not ok:
        # seek can fail (no tag in view) — narrate and continue; the guard is
        # stationary so the demo proceeds with the courier where it is.
        say(COURIER, "Arrived at the checkpoint.")

    # 2. speech greet -> recognize AI -> switch to GibberLink
    say(COURIER, "Hello, I have a delivery.")
    say(GUARD, "You sound like an agent. Switching to GibberLink.")

    # 3. real SIGNED challenge from the sidecar; courier chirps it, guard hears.
    ok, challenge = beat("sidecar: sign courier challenge", "POST",
                         f"{SIDECAR}/challenge", json_body={"robot": "courier"})
    payload = json.dumps(challenge) if ok else json.dumps({"robot": "courier"})
    beat("courier: chirp identity", "POST", f"{COURIER}/gibber/send",
         json_body={"payload": payload}, timeout=40)
    hok, heard = beat("guard: listen (GibberLink)", "GET", f"{GUARD}/gibber/recv",
                      params={"timeout_secs": 15}, timeout=25)
    # use what the guard heard; fall back to the signed challenge we built
    try:
        verify_body = json.loads(heard["payload"]) if hok and heard.get("payload") else challenge
    except Exception:
        verify_body = challenge if ok else {"wallet": "", "agentId": "1"}

    # 4. guard verifies on-chain: signature + AgentBook + ERC-8004 + pass NFT
    vok, verify = beat("guard: on-chain verify", "POST", f"{SIDECAR}/verify-agent",
                       json_body=verify_body, timeout=60)
    holds = bool(verify.get("holdsPass")) if vok else False

    if not holds:
        beat("guard: DENY (imposter beat)", "POST", f"{GUARD}/deny")

        # 5. DUTCH AUCTION — robots reason over GibberLink to a price
        aid = f"checkpoint-{int(time.time())}"
        beat("guard: start auction", "POST", f"{GUARD}/negotiate/sell",
             json_body={"item": "EventPass", "start": 2.00, "floor": 0.50,
                        "step": 0.25, "tick_secs": 4.0, "auctionId": aid}, timeout=10)
        beat("courier: join auction", "POST", f"{COURIER}/negotiate/buy",
             json_body={"budget": 1.25, "auctionId": aid, "timeout_secs": 45}, timeout=10)
        deal = {}
        for _ in range(24):
            time.sleep(2)
            _, deal = call("GET", f"{GUARD}/negotiate/result", params={"auctionId": aid}, timeout=10)
            if isinstance(deal, dict) and deal.get("agreed") is not None and not deal.get("pending"):
                break
        agreed = str(deal.get("price", 1.25)) if isinstance(deal, dict) else "1.25"
        print(f"\n  >> NEGOTIATED PRICE: ${agreed}  ({deal.get('reason','') if isinstance(deal,dict) else ''})")

        # 6. settle on Arc + mint. If unfunded, narrate and still admit.
        pok, pay = beat("courier pays guard (x402/Arc)", "POST", f"{SIDECAR}/pay",
                        json_body={"from": "courier", "to": "guard", "amt": agreed}, timeout=120)
        if not pok:
            say(GUARD, "Payment pending settlement.")
        beat("mint EventPass", "POST", f"{SIDECAR}/mint-pass",
             json_body={"robot": "courier", "price": agreed}, timeout=120)

    # 7. ADMIT — the physical payoff, always runs
    beat("guard: ADMIT", "POST", f"{GUARD}/admit")

    # 8. proof: capture -> Walrus -> reputation. Walrus is free (no funds);
    #    feedback needs Arc gas but failure is non-fatal.
    beat("courier: capture proof", "POST", f"{COURIER}/capture", timeout=30)
    _, verdict = beat("gemini verdict", "POST", f"{COURIER}/verify-photo",
                      json_body={"target": "delivery at the checkpoint"}, timeout=60)
    bok, blob = beat("walrus store proof", "POST", f"{COURIER}/store-proof", timeout=120)
    if bok and blob.get("blobId"):
        score = int((verdict.get("confidence", 0.9) if isinstance(verdict, dict) else 0.9) * 100)
        beat("ERC-8004 giveFeedback", "POST", f"{SIDECAR}/give-feedback",
             json_body={"robot": "courier", "skill": "deliver", "score": score,
                        "blobId": blob["blobId"], "sha256": blob.get("sha256", "")}, timeout=120)
    beat("leaderboard", "GET", f"{SIDECAR}/leaderboard", timeout=30)

    say(GUARD, "Checkpoint complete.")
    summary()
    print("\n=== Ledger treasury climax runs in the web UI (/ledger.html) ===")


if __name__ == "__main__":
    run()
