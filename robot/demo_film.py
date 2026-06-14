"""Full demo sequence for filming — runs the whole story on one robot, paced
with audio so it films cleanly. GibberLink → gemma3 negotiation → Walrus proof
→ admit beat. Honest single-robot version (courier offline)."""
import os, time, wave, subprocess
import numpy as np
import requests
import brain, reason, voice
from rover import Rover

SIDECAR = os.environ.get("SIDECAR_URL")
AGG = "https://publisher.walrus-testnet.walrus.space"

def chirp(msg):
    try:
        import ggwave
        w = ggwave.encode(msg, protocolId=1, volume=90)
        pcm = (np.frombuffer(w, dtype=np.float32) * 32767).astype("<i2")
        wf = wave.open("/tmp/g.wav", "w"); wf.setnchannels(1); wf.setsampwidth(2)
        wf.setframerate(48000); wf.writeframes(pcm.tobytes()); wf.close()
        subprocess.run(["aplay", "-D", "plughw:1,0", "-q", "/tmp/g.wav"],
                       stderr=subprocess.DEVNULL)
    except Exception as e:
        print("chirp:", e)

print("\n========== THE ONCHAIN ROVER — LIVE ==========\n")
voice.say("The Onchain Rover. Online.")
time.sleep(0.5)

print(">>> BEAT 1: GibberLink handshake (data over sound)")
voice.say("Greeting by GibberLink.")
chirp("guard.rover.eth|agentId:0|0xC0FFEE42")
chirp("verified: human-backed | on-chain agent")
time.sleep(0.5)

print("\n>>> BEAT 2: on-device gemma3 negotiation")
plan = brain.seller_reserve(2.00, 0.50, 0.6)
reserve, step = plan["reserve"], plan["step"]
reason.ROLE = "guard"; reason.emit("reserve", f"reserve ${reserve} — {plan['reason']}", "plan")
print(f"  SELLER gemma3: reserve ${reserve}, step ${step} [{plan.get('via')}]")
budget, price, hist, sold, dp = 1.25, 2.00, [], False, reserve
while price >= reserve - 1e-9:
    hist.append(round(price, 2))
    reason.ROLE = "guard"; reason.emit("offer", f"asking ${price:.2f} — going once…", "offer")
    voice.say(f"{int(price)} dollar{'' if int(price)==1 else 's'} {int(round((price%1)*100)) or ''} {'cents' if price%1 else ''}", voice="texas")
    d = brain.buyer_decision(price, budget, hist, 30)
    print(f"  @${price:.2f} -> {d['action'].upper()} [{d.get('via')}] — {d['reason']}")
    reason.ROLE = "courier"; reason.emit("evaluate", f"@${price:.2f}: {d['reason']}",
                                          "decision" if d["action"] == "accept" else "thought")
    if d["action"] == "accept":
        sold, dp = True, price
        reason.ROLE = "guard"; reason.emit("close", f"SOLD @ ${price:.2f} to courier.rover.eth", "decision")
        voice.say(f"Sold, for {price:.2f}.", voice="texas"); break
    price -= step
print(f"  >>> DEAL @ ${dp:.2f}" if sold else "  no deal")
# record the outcome so the seller's demand model adapts (moves the dial live)
if SIDECAR:
    try: requests.post(f"{SIDECAR}/learning/outcome",
                       json={"price": dp, "sold": sold, "rounds": len(hist)}, timeout=4)
    except Exception: pass

print("\n>>> BEAT 3: do the job + prove it on Walrus")
voice.say("Capturing proof of action.")
# use the API's shared camera (it owns /dev/video0) — /store-proof also posts
# the blob to the sidecar so the dashboard's Proof panel updates.
requests.post("http://localhost:8000/capture", timeout=20)
sp = requests.post("http://localhost:8000/store-proof", timeout=90).json()
blob, sha = sp.get("blobId"), sp.get("sha256")
print(f"  Walrus blobId: {blob}")
print(f"  sha256: {sha}")
# push to THIS sidecar so the broadcast Proof panel updates live
if SIDECAR and blob:
    try:
        requests.post(f"{SIDECAR}/proof", json={"blobId": blob, "sha256": sha,
                      "label": "guard · live proof of action"}, timeout=5)
        print(f"  -> pushed to dashboard {SIDECAR}")
    except Exception as e:
        print("  dashboard push:", e)
voice.say("Proof stored on Walrus. Tamper evident.")

print("\n>>> BEAT 4: admit (human-legible)")
with Rover() as rov:
    rov.lights(255,255); rov.oled(0,"ACCESS GRANTED")
    rov.gimbal(0,30); time.sleep(0.4); rov.gimbal(0,0)
voice.say("Access granted. Welcome in.")
print("\n========== DEMO COMPLETE ==========")
