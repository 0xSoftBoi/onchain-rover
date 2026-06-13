# Jetson Bridge Spec — robot ↔ crypto rails

How the physical rovers plug into the payment/identity stack. Two identical
Waveshare UGV Rovers (Jetson Orin NX). Robot A = GUARD (stationary), Robot B =
COURIER (mobile).

## Process & port model (one diagram to rule the demo)

```
                    venue WiFi / travel router LAN
                               │
   laptop (operator) ──────────┼──────────────────────────────┐
                               │                              │
┌── JETSON (each robot) ───────┴────────────┐   ┌─ LAPTOP ────┴───────────┐
│ robot-harness Rust :8000  (LAN only)      │   │ sidecar/  Express :4021 │
│   owns motors, sensors, camera hooks       │◄──┤   x402 Gateway middleware│
│   owns /dev/ttyTHS1 + /dev/video0         │   │   (PUBLIC paid surface)  │
│ ollama :11434 (gemma3:1b planner)         │   │ web/      Next.js :3000 │
│ piper-tts (voice), ggwave (GibberLink)    │   └─────────────────────────┘
└────────────────────────────────────────────┘
```

- **Public entry point is the sidecar (`:4021`)** — every paid route sits behind
  Circle's `createGatewayMiddleware` (x402 nanopayments, Arc testnet
  `eip155:5042002`). On successful payment it proxies to the robot's FastAPI.
- **Robot FastAPI (`:8000`) is LAN-only, never exposed** — it has no auth; the
  payment layer IS the auth. Bind it to the LAN interface, firewall from venue.
- Sidecar runs on the **laptop**, not the Jetson (Node 22 + keys stay off the
  robots; robots stay swappable).

## Serial bridge (ESP32 lower board)

- Port **`/dev/ttyTHS1`** @ **115200**, newline-terminated JSON. ONE process at
  a time — the stock Waveshare `app.py` also claims it (and the camera).
- Kill the stock app before starting ours: `pgrep -f '[a]pp.py' | xargs -r kill`
  (⚠️ never `pkill -f app.py` over SSH — kills your own session).
- Protocol (verified live):
  - drive `{"T":1,"L":-1..1,"R":-1..1}` · telemetry req `{"T":130}` → stream
    `{"T":1001, ax..mz, odl, odr, v}` (`v` = centivolts, 1203 = 12.03 V)
  - attitude `{"T":126}` → `{"T":1002, r,p,y,q0..q3}`
  - gimbal `{"T":133,"X","Y","SPD","ACC"}` · lights `{"T":132,"IO4","IO5"}`
  - OLED `{"T":3,"lineNum":0-3,"Text":...}` · emergency `{"T":0}`
- All of this is wrapped by `robot/rover.py` (tested). Do not hand-roll frames.

## Camera & perception

- `/dev/video0` (USB cam) via OpenCV. Shared with stock app — same kill rule.
- Seek loop = HYBRID (locked): Gemini open-vocab locate (`gemini-2.5-flash`,
  bbox+confidence ≥ 0.6) with **AprilTag fallback every frame** (cv2.aruco
  `DICT_APRILTAG_36h11`; printed tags on all demo targets). Gemini also issues
  the final proof verdict that feeds ERC-8004.
- 🚨 USB camera/audio init can reset the USB bus and drop USB-net SSH. Get the
  robots on WiFi (travel router) before the demo; USB-net is provisioning-only.

## Audio (GibberLink + voice)

- Out: piper-tts (`en_US-lessac-medium.onnx`) → speaker. In: USB mic.
- GibberLink handshake = `ggwave` (PyPI 0.4.3) FSK tones: exchange wallet addr,
  signed challenge, payment confirmation acoustically. **Network fallback**: the
  same payloads over HTTP between the two robot APIs if venue noise wins.

## Interface contract (the two-builder boundary — frozen)

Rust rover server exposes (each robot):
`GET /capabilities` · `GET /health` · `GET /telemetry` · `GET /sensors` ·
`GET /camera/status` · `GET /camera/snapshot` · `GET /stream` ·
`POST /pilot/authorize` · `POST /pilot/speed-mode` · `POST /drive` ·
`POST /motors/drive` · `POST /motors/stop` · `POST /estop` ·
`POST /estop/reset` · `WS /ws/drive` · `WS /ws/telemetry`

Legacy Python FastAPI may still expose:
`POST /seek {target}` · `POST /capture` → jpg+sha256 · `POST /verify-photo` →
Gemini verdict · `POST /store-proof` → Walrus blobId · `POST /gibber/send` /
`GET /gibber/recv` · `POST /worldid/verify` → {ok,nullifier} · `POST /say` ·
`POST /admit` / `POST /deny` (LED+OLED+voice)

Node sidecar exposes:
`POST /pay {from,to,amt}` → tx (x402 Gateway) · `POST /mint-pass {to}` ·
`POST /register-agent` → agentId · `POST /give-feedback {agentId,skill,score,blobId}` ·
`GET /ens/resolve` · `POST /ens/issue` · `GET /nft/holds/:addr` · `GET /leaderboard`
plus the **paid public routes** `POST /task/:robot` (x402-gated → proxies to
that robot's `/seek`+`/capture`+proof pipeline).

The checkpoint orchestrator (`robot/checkpoint.py`, runs on GUARD) sequences the
locked 90-second demo by calling both APIs.

## Networking

- Bring a **travel router**; robots + laptop on its LAN, router uplinks to venue
  WiFi. Only chain RPCs leave the LAN. Static leases: GUARD `.71`, COURIER `.72`,
  laptop `.10` (set envs accordingly).
- Provisioning path: USB-net (Jetson `192.168.55.1`, login `jetson`/`jetson`,
  SSH key installed on A). WiFi join via `nmcli dev wifi connect <ssid> password <pw>`.

## Autostart / recovery

- Robot A already has `~/ugv_jetson/start_ugv_web.sh` + `@reboot` cron (setsid).
  Replace its target with `robot-harness` for the event (stock web UI, Python
  API, and Rust stack cannot all own serial/camera at once).
- Hard-stop: `{"T":0}` + `drive(0,0)`; geofence via wheel odometry (odl/odr) in
  the Rust telemetry contract; speed caps and deadman are enforced by
  `robot-harness`.

## Robot B provisioning checklist (clone of A, ~30 min)

1. USB-net in → `ssh jetson@192.168.55.1` (pw `jetson`), install SSH key.
2. Join travel-router WiFi; note IP; disable `audio_output` in
   `~/ugv_jetson/config.yaml` (as on A); kill voice/capture/read_serial hogs.
3. `scp robot/*.py` over; venv = `~/ugv_jetson/ugv-env/bin/python`;
   `pip install pyserial requests fastapi uvicorn google-genai ggwave`.
4. Confirm: telemetry frame, 0.5 s drive, photo capture, `piper` speaks.
5. Crypto identity (sidecar does this): own Privy server-wallet EOA → fund Arc
   USDC → Gateway deposit → `courier.rover.eth` subname → ERC-8004 register →
   AgentBook register (World App QR).
