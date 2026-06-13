"""
The Onchain Rover — x402 paid task endpoint.

A robot you can pay over HTTP. POST a task; the server replies 402 Payment
Required with USDC payment terms; the client pays (signed EIP-3009 USDC transfer
on Base Sepolia) and retries with an X-PAYMENT header; the server verifies via
the x402 facilitator, runs the rover, settles payment, and returns the
proof-of-action (photo SHA-256 + telemetry).

Stack: Circle USDC on Base Sepolia, x402 protocol, hash-on-chain proof (MVP).

Run on the Jetson (stop app.py first to free camera+serial):
    ROVER_WALLET=0xYourRoverAddr ./ugv-env/bin/python x402_server.py
"""
import base64
import json
import os

import requests
from flask import Flask, request, jsonify

from agent import execute_task

app = Flask(__name__)

# --- x402 config (Base Sepolia testnet) ----------------------------------
FACILITATOR = os.environ.get("X402_FACILITATOR", "https://x402.org/facilitator")
NETWORK = "base-sepolia"
# Circle USDC on Base Sepolia (6 decimals)
USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
USDC_DECIMALS = 6
ROVER_WALLET = os.environ.get("ROVER_WALLET", "0x0000000000000000000000000000000000000000")
PRICE_USDC = float(os.environ.get("TASK_PRICE_USDC", "0.50"))


def payment_requirements(task, resource="/task"):
    """The 402 body: what the client must pay to run a rover task."""
    return {
        "x402Version": 1,
        "accepts": [{
            "scheme": "exact",
            "network": NETWORK,
            "maxAmountRequired": str(int(PRICE_USDC * 10 ** USDC_DECIMALS)),
            "resource": resource,
            "description": f"Onchain Rover task: {task}",
            "mimeType": "application/json",
            "payTo": ROVER_WALLET,
            "maxTimeoutSeconds": 120,
            "asset": USDC,
            "extra": {"name": "USDC", "version": "2"},
        }],
    }


def facilitator(path, payload):
    r = requests.post(f"{FACILITATOR}/{path}", json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


@app.route("/task", methods=["POST"])
def task():
    body = request.get_json(force=True, silent=True) or {}
    task_text = body.get("task", "look around and take a photo")

    pay_header = request.headers.get("X-PAYMENT")
    reqs = payment_requirements(task_text)

    # --- unpaid: ask for payment -----------------------------------------
    if not pay_header:
        return jsonify(reqs), 402

    # --- paid: verify the signed USDC authorization ----------------------
    try:
        payment = json.loads(base64.b64decode(pay_header))
    except Exception:
        return jsonify({"error": "malformed X-PAYMENT"}), 400

    selected = reqs["accepts"][0]
    verify = facilitator("verify", {
        "x402Version": 1, "paymentPayload": payment,
        "paymentRequirements": selected,
    })
    if not verify.get("isValid"):
        return jsonify({"error": "payment invalid",
                        "reason": verify.get("invalidReason")}), 402

    # --- payment good: run the rover -------------------------------------
    proof = execute_task(task_text)

    # --- settle the USDC transfer on Base Sepolia ------------------------
    settle = facilitator("settle", {
        "x402Version": 1, "paymentPayload": payment,
        "paymentRequirements": selected,
    })

    resp = jsonify({
        "status": "completed",
        "task": task_text,
        "proof": {
            "photo_sha256": proof.get("photo_sha256"),
            "telemetry": proof.get("telemetry"),
            "steps": proof.get("steps"),
        },
        "payment": {
            "settled": settle.get("success", False),
            "tx": settle.get("transaction"),
            "network": NETWORK,
            "amount_usdc": PRICE_USDC,
        },
    })
    # x402 settlement confirmation header
    resp.headers["X-PAYMENT-RESPONSE"] = base64.b64encode(
        json.dumps(settle).encode()).decode()
    return resp, 200


@app.route("/health")
def health():
    return jsonify({"ok": True, "rover_wallet": ROVER_WALLET,
                    "price_usdc": PRICE_USDC, "network": NETWORK})


if __name__ == "__main__":
    print(f"Onchain Rover x402 server — payTo={ROVER_WALLET} "
          f"price={PRICE_USDC} USDC on {NETWORK}")
    app.run(host="0.0.0.0", port=4021)
