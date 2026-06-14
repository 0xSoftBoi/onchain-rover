"""Real on-device gemma3 negotiation driver — runs both roles' actual LLM
decisions on one robot (for a single-robot test). Prints the genuine reasoning
+ inference latency, and emits to the dashboard via reason.emit if SIDECAR_URL set.
"""
import os
import sys
import time

import requests

import brain
import reason

SIDECAR = os.environ.get("SIDECAR_URL")
budget = float(sys.argv[1]) if len(sys.argv) > 1 else 1.25

# LEARNING: read the demand the seller has learned from past auctions
demand = 0.5
if SIDECAR:
    try:
        d = requests.get(f"{SIDECAR}/learning", timeout=5).json()
        demand = float(d.get("demand", 0.5))
        print(f"[learned demand {demand:.2f}] {d.get('note','')}")
    except Exception:
        pass

print(f"=== REAL gemma3 negotiation · buyer budget ${budget:.2f} ===\n")
t0 = time.time()
plan = brain.seller_reserve(2.00, 0.50, demand)
dt = time.time() - t0
print(f"[SELLER gemma3 {dt:.1f}s] reserve=${plan['reserve']} step=${plan['step']} [via {plan.get('via','?')}]")
print(f"           rationale: {plan['reason']}\n")
reason.ROLE = "guard"
reason.emit("reserve", f"reserve ${plan['reserve']}, step ${plan['step']} — {plan['reason']}", "plan")

hist = []
price = 2.00
step = plan["step"] or 0.25
sold = False
deal_price = 0.0
reason.ROLE = "courier"
while price >= (plan["reserve"] - 1e-9):
    hist.append(round(price, 2))
    reason.ROLE = "guard"
    reason.emit("offer", f"${price:.2f} — going once. reserve ${plan['reserve']}.", "offer")
    t1 = time.time()
    reason.ROLE = "courier"
    d = brain.buyer_decision(price, budget, hist, 30)
    dt = time.time() - t1
    print(f"[BUYER gemma3 {dt:.1f}s] @${price:.2f} (budget ${budget}) -> {d['action'].upper()} [via {d.get('via','?')}]")
    print(f"          rationale: {d['reason']}")
    reason.emit("decide", f"${price:.2f} @ budget ${budget}: {d['action'].upper()} — {d['reason']}",
                "decision" if d["action"] == "accept" else "thought")
    if d["action"] == "accept":
        sold = True; deal_price = price
        print(f"\n>>> DEAL: gemma3 buyer accepted at ${price:.2f}")
        reason.ROLE = "guard"
        reason.emit("settle", f"SOLD for ${price:.2f}. above reserve ✓", "decision")
        break
    price -= step

if not sold:
    print(f"\n>>> NO DEAL: buyer (budget ${budget}) never met reserve ${plan['reserve']}")

# LEARNING: report the outcome so the seller adapts demand next auction
if SIDECAR:
    try:
        r = requests.post(f"{SIDECAR}/learning/outcome",
                          json={"price": deal_price, "sold": sold, "rounds": len(hist)},
                          timeout=5).json()
        print(f"[outcome recorded] new learned demand -> {r.get('demand')}: {r.get('note','')}")
    except Exception as e:
        print(f"outcome post failed: {e}")
print(f"\ntotal wall time: {time.time() - t0:.1f}s")
