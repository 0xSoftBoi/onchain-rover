# The Onchain Rover — ETHGlobal NYC 2026

**"Give your AI agent a body."** Two Waveshare UGV rovers (Jetson Orin NX) as a
physical agent fleet you can hire over HTTP: x402 USDC payments on Arc, ENS
fleet identity, ERC-8004 reputation, World-ID human backing, Gemini-verified
proof on Walrus, Ledger-governed treasury.

- **Act 1 — The Checkpoint:** courier robot is hired, drives to the guard
  robot, they handshake over GibberLink sound, on-chain verify → reject → pay →
  pass minted → admitted → proof → reputation. (`robot/checkpoint.py`)
- **Act 2 — Rover GP:** spectators pay to pilot the rovers ($1 x402 sessions)
  and bet USDC on races (parimutuel `contracts/RaceMarket.sol` on Arc, settled
  by the guard robot's Gemini-verified finish-line attestation; one bet per
  World-ID human).

## Layout
- `robot/` — Python, runs on each Jetson. `api.py` (FastAPI :8000, LAN-only
  interface contract), `rover.py` (serial bridge, tested), `agent.py` (LLM task
  loop, tested), `perception.py` (Gemini seek + AprilTag fallback), `proof.py`
  (Walrus + Gemini verdicts), `gibber.py` (ggwave + network fallback),
  `checkpoint.py` (demo orchestrator). `x402_server_legacy.py` is superseded.
- `sidecar/` — Node 22 + TS, runs on the laptop (:4021). PUBLIC paid surface:
  Circle x402 Gateway middleware (Arc testnet), ERC-8004, ENS/NameStone,
  BigQuery leaderboard, pilot-session safety layer, race coordinator.
- `web/` — Next.js (partner track): IDKit, Dynamic wallets, pilot gamepad,
  betting UI, Ledger clear-sign climax, leaderboard. See `web/README.md`.
- `contracts/` — `RaceMarket.sol` (+ EventPass TODO) + ERC-7730 descriptors.
- `docs/JETSON_BRIDGE.md` — full robot↔rails bridge spec (ports, serial
  protocol, provisioning checklist for Robot B).

## Run
```bash
# Jetson (each robot; stop the stock app first):
pgrep -f '[a]pp.py' | xargs -r kill
ROBOT_ROLE=guard ~/ugv_jetson/ugv-env/bin/python -m uvicorn api:app --host 0.0.0.0 --port 8000

# Laptop:
cd sidecar && npm i && cp ../.env.example .env  # fill keys
npm run dev

# Demo:
python3 robot/checkpoint.py
```

Master plan (tiers, cut order, verified addresses/gotchas): see the
ethnyc2026-rover-plan memory note.
