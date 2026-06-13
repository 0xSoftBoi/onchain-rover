# The Onchain Rover — ETHGlobal NYC 2026

### Give your AI agent a body.

Every agent at this hackathon is trapped behind a screen. We gave two of them
bodies: a fleet of **Waveshare UGV rovers (Jetson Orin NX)** that you **hire over
HTTP**, that earn an **on-chain reputation**, and whose **treasury only a human
can unlock with a Ledger**. Identity, payments, reputation, a labor market, and
human governance — every sponsor doing real work, with a robot on the table the
whole time.

```
   hire (x402/Arc) → robot acts → Gemini verifies → proof on Walrus
         ▲                                                │
    BigQuery rank ◄── ERC-8004 reputation ◄── requester rates the job
```

## The two acts
- **Act 1 — The Checkpoint:** a courier robot is hired, drives to the guard
  robot, they greet in speech then **switch to GibberLink** (data-over-sound);
  the guard verifies it **on-chain** (signed challenge + AgentBook human-backing +
  ERC-8004 + EventPass) → rejects it → the robots run a **Texas-auctioneer Dutch
  auction** to negotiate the pass price → pay + mint on Arc → admitted → proof to
  Walrus → reputation ticks up.
- **Act 2 — Rover GP:** spectators **pay to pilot** the rovers ($1 x402 sessions,
  WebSocket joystick + deadman) and **bet USDC** on a fruit-obstacle drag race
  (parimutuel, **one bet per human via real World ID**), settled on-chain by the
  guard robot's Walrus-anchored finish photo.
- **Climax:** withdrawing the fleet's earnings **blocks** until a human
  clear-signs on a **Ledger** (ERC-7730: "Withdraw N USDC → recipient").

## What's real (not mocked)
Every integration is real code — on-chain reads/writes or real signatures, no
fake data (`grep` the repo: no `Math.random` nullifiers, no stubs):
- **Identity** — robots sign challenges with their own EOA keys (verified by
  recovery); **live AgentBook reads** on World Chain for human-backing.
- **World ID** — real IDKit proof → World cloud verifier → real nullifier; every
  bet requires it (no proof = no bet).
- **ENS** — real on-chain registration on Sepolia (`roverfleet.eth` + guard/
  courier subnames + ENSIP-25 `agent-registration` records), resolved live via viem.
- **Payments / settlement** — real USDC transfers, EventPass mint, RaceMarket
  bets + settle on **Arc** (USDC-as-gas), via viem.
- **Reputation** — ERC-8004-compatible `ReputationRegistry` on Arc, requester
  rates the agent, feeds the leaderboard.
- **Proof** — finish/job photos stored on **Walrus** (real blobId, read-back
  verified), hash anchored on-chain.
- **Governance** — `Treasury` withdrawable only by the Ledger-held owner,
  clear-signed via an ERC-7730 descriptor. (Owner transferred to a real Ledger
  device; gas-funded so the device-signed withdrawal broadcasts.)
- **Decentralized verification (Chainlink CRE)** — a DON independently calls the
  robot's `GET /attest`, reaches **median consensus** on the verification score,
  and `writeReport`s the verdict to `AttestationConsumer` on Sepolia. The robot's
  self-claim never settles — `isVerified(job)` gates the mint/payment/reputation.
- **Custody (Privy)** — robot signing keys live in Privy's TEE, not on the host;
  `settle.pay()` signs through the enclave (`CUSTODY=privy`). **LIVE**: real Arc
  tx signed in the TEE (`0x6a9b8fdd…`).
- **Network reputation (BigQuery)** — ranks every on-chain agent by ERC-8004
  `NewFeedback` volume on the canonical mainnet registry (partition-pruned,
  dry-run guarded); the rover's local Arc reputation shown alongside.

Things that need credentials/funds to *execute* and fail loudly without them
(no mock fallback): **Arc USDC** (Circle), **`WORLD_APP_ID`** (live ✓),
**Sepolia ETH** (ENS + CRE consumer), **`cre login`** (CRE simulate),
**`PRIVY_APP_ID/SECRET`** (live ✓), **GCP creds** (BigQuery).

## Layout
- `robot/` — Python on each Jetson. `api.py` (FastAPI :8000 + MJPEG `/stream` +
  pilot WS + heartbeat), `rover.py` (serial bridge), `agent.py` (LLM task loop),
  `camera.py` (shared capture), `perception.py` (Gemini seek + AprilTag),
  `negotiate.py` (Dutch auction), `finish_line.py` (race judge), `gibber.py`
  (GibberLink), `voice.py` (espeak), `proof.py` (Walrus), `checkpoint.py` (Act 1).
- `sidecar/` — Node 22 + TS (:4021). x402 Gateway paid surface, `identity.ts`
  (signed challenge + AgentBook), `worldid.ts` (real verify), `settle.ts`
  (Arc pay/mint/reputation/race/treasury), `ens.ts` (live resolution),
  `register-ens.ts` / `go-live.ts` / `preflight.ts` scripts. Serves the dashboards.
- `sidecar/public/` — `index.html` mission control (live feeds, balances, ENS,
  reputation, 1-click auction+settle), `race.html` (betting), `pilot.html`
  (joystick), `ledger.html` (clear-sign treasury).
- `contracts/` — `EventPass.sol`, `ReputationRegistry.sol`, `RaceMarket.sol`,
  `Treasury.sol`, `erc7730/treasury.json`.
- `DEMO_RUNBOOK.md` — the timed 3-minute script. `docs/JETSON_BRIDGE.md` — bridge spec.

## Run
```bash
# each Jetson (stop the stock app first):
pgrep -f '[a]pp.py' | xargs -r kill
ROBOT_ROLE=guard SIDECAR_URL=http://<laptop-ip>:4021 \
  ~/ugv_jetson/ugv-env/bin/python -m uvicorn api:app --host 0.0.0.0 --port 8000

# laptop:
cd sidecar && npm i && npm run build:ledger
node --import tsx src/preflight.ts      # readiness board
node --import tsx src/index.ts          # sidecar + dashboards on :4021

# once funded (Circle booth / faucets):
npx tsx src/register-ens.ts             # real ENS on Sepolia
npx tsx src/go-live.ts                  # deploy contracts + run the full on-chain loop
```

Demo at `http://<laptop>:4021/` (mission control) · `/race.html` · `/pilot.html` · `/ledger.html`.
