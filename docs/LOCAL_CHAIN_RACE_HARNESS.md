# Local Chain Race Harness

This is the local development harness for the two-driver rover race economy.
It runs a Hardhat 3 chain, deploys a local race token and `RaceEscrow`, exports
addresses for the sidecar, and proves the entry/fee/payout path without robots.

## Pieces

- `chain/`: Hardhat 3 project with local contracts, deploy/export scripts, and tests.
- `chain/contracts/MockRaceToken.sol`: local-only 6-decimal test asset.
- `chain/contracts/RaceEscrow.sol`: two-driver stake escrow with typed race-entry authorization, permit-based funding, treasury fee collection, winner payout, and cancel refunds.
- `sidecar/src/chain.ts`: local-chain client used by the HTTP routes.
- `sidecar/src/rounds.ts`: in-memory race coordinator with chain status and tx hashes.
- `sidecar/src/robot-link.ts`: sidecar-owned robot bridge for phone controls, telemetry, and deadman stop behavior.
- `sidecar/src/sim-robot.ts`: simulator client that connects to the sidecar bridge as `guard` or `courier`.
- `sidecar/src/evidence.ts`: canonical race evidence packets and SHA-256 proof hashes.
- `sidecar/src/race-store.ts`: local durable race ledger under `sidecar/data/races`.
- `sidecar/web-src/pilot-app.ts`: camera-first phone UI; race payment appears only as a modal when a `round` query parameter is present.

## Commands

```bash
npm --prefix chain install
npm run chain:compile
npm run chain:test
npm run e2e:local-race
npm run e2e:sidecar-round
npm run e2e:dev-join
npm run e2e:harness-bridge
npm run e2e:field-sim
```

## Docker Compose

Use the root compose file when the sidecar should own the local chain lifecycle:

```bash
docker compose up --wait
```

This starts:

- `chain`: Hardhat on `0.0.0.0:8545`, then deploys `MockRaceToken` and
  `RaceEscrow`.
- `sidecar`: Express on `:4021`, after the chain deployment is healthy.

The chain service writes `sidecar/src/generated/contracts.local.json` after
deployment. Inside Docker, sidecar uses `LOCAL_CHAIN_RPC_URL=http://chain:8545`;
the exported deployment still points host tools at `http://127.0.0.1:8545`.

The compose defaults are public-safe: `ALLOW_FREE_PILOT=0` and
`ALLOW_LOCAL_DEV_WALLETS=0`. For laptop-only rehearsals, opt in explicitly:

```bash
COMPOSE_ALLOW_LOCAL_DEV_WALLETS=1 COMPOSE_ALLOW_FREE_PILOT=1 docker compose up --wait
```

If port `4021` is already used by a local sidecar, run the composed sidecar on
another host port:

```bash
COMPOSE_SIDECAR_PORT=4026 \
COMPOSE_PUBLIC_SIDECAR_URL=http://127.0.0.1:4026 \
docker compose up --wait
```

For internet visibility, put a stable HTTPS tunnel in front of the sidecar and
set `COMPOSE_PUBLIC_SIDECAR_URL` to that URL before starting compose. Do not set
`COMPOSE_ALLOW_FREE_PILOT=1` on a public tunnel.

For manual sidecar development:

```bash
npm run chain:node
npm run chain:deploy
cd sidecar
npm run build:pilot
npm start
```

For robot-link testing without hardware:

```bash
cd sidecar
ALLOW_FREE_PILOT=1 npm start
SIDECAR_URL=ws://127.0.0.1:4021 npm run sim:robot -- guard
SIDECAR_URL=ws://127.0.0.1:4021 npm run sim:robot -- courier
```

To auto-finish a race from simulated telemetry:

```bash
cd sidecar
SIDECAR_URL=http://127.0.0.1:4021 FINISH_ROBOTS=guard,courier \
  FINISH_ODOMETRY=6 npm run sim:finish -- <roundId>
```

To prove the sidecar, local chain, robot bridge, detector ingestion, evidence,
settlement path, and durable race ledger together against an already running
sidecar and Hardhat node:

```bash
SIDECAR_URL=http://127.0.0.1:4021 npm run e2e:sidecar-round
```

To prove the laptop-only wallet rehearsal path, where the sidecar opens,
funds, signs, joins, and locks escrow with local Hardhat wallets:

```bash
SIDECAR_URL=http://127.0.0.1:4021 npm run e2e:dev-join
```

To prove the sidecar bridge against the Rust `robot-harness` simulator:

```bash
SIDECAR_URL=http://127.0.0.1:4021 npm run e2e:harness-bridge
```

To prove the closest no-hardware field path, including two Rust rover
simulators, two bridge adapters, two delegated pilot sessions, finish evidence,
settlement, and persisted proof:

```bash
SIDECAR_URL=http://127.0.0.1:4021 npm run e2e:field-sim
```

The deploy step writes `sidecar/src/generated/contracts.local.json`. Re-run it
whenever the local chain is reset.

## Durable Race Ledger

The sidecar writes local race history to `sidecar/data/races/<roundId>/`:

- `round.json`: latest replayable round state, without pilot tokens.
- `evidence.json`: lifecycle snapshots, finish detections, proof hash, and packet hash.
- `events.jsonl`: append-only event log for round and evidence transitions.

Set `RACE_DATA_DIR=/tmp/onchain-rover-races` to keep test runs isolated. On
boot, the sidecar reloads persisted rounds and evidence records so
`GET /race/rounds`, `GET /race/round/:id`, and the evidence routes still work
after a restart.

## Sidecar Routes

- `GET /chain/config`: public local chain metadata and contract addresses.
- `GET /chain/health`: RPC and deployed-code check.
- `POST /race/round/:id/join` or `POST /race/:id/join`: x402-gated fixed fleet fee for one driver slot; records source, payer, amount, treasury, network, and payment proof in the fee ledger.
- `POST /race/round/:id/chain/open`: open a race escrow for an existing round.
- `POST /race/round/:id/chain/authorization-request`: build race entry and permit typed data for one driver slot.
- `POST /race/round/:id/chain/join`: submit signed typed data through the facilitator.
- `POST /race/round/:id/chain/lock`: lock escrow once both drivers joined.
- `POST /race/round/:id/dev/join-local-wallets`: local-only rehearsal route that claims the two Hardhat wallets, funds them, signs both driver entries in the sidecar, joins them, and optionally locks escrow.
- `POST /race/round/:id/stake/prepare`: build the Base SpendPermission typed data for one driver stake.
- `POST /race/round/:id/stake/verify`: verify and record the signed driver stake permission.
- `GET /race/round/:id/stake/settlement-plan`: after finish, return the loser-only charge, winner payout, and spender execution plan for the verified stake permission.
- `POST /race/round/:id/chain/start`: mark the on-chain race started.
- `POST /race/round/:id/chain/settle`: finish and settle payout after the local round has a winner.
- `POST /race/round/:id/chain/cancel`: cancel and refund stakes.
- `POST /race/round/:id/cancel`: local cancel with explicit `code` and `reason`; stores fee policy and per-driver stake authorization status.
- `GET /treasury/local`: local treasury fee balance.
- `GET /race/round/:id/evidence`: canonical evidence packet, lifecycle snapshots, and telemetry windows.
- `GET /race/round/:id/evidence/hash`: stable result proof hash plus current packet hash.
- `GET /race/round/:id/telemetry-trace`: persisted per-round telemetry summary; add `?frames=1` to include compact frames.
- `POST /race/round/:id/finish-detection`: finish camera, robot, lidar, or simulator event; auto-finishes by default.
- `GET /race/round/:id/finish-detections`: recorded finish detector events for the round.
- `GET /robot-link/state`: current bridge sessions, attached robots, telemetry, and last command.
- `WS /ws/drive?robot=<guard|courier>&token=<token>`: phone control socket issued by `/pilot/dev-authorize`.
- `WS /ws/telemetry?robot=<guard|courier>`: phone telemetry stream.
- `WS /ws/robot?robot=<guard|courier>`: robot or simulator attachment point.
- `POST /robot/:robot/stop`: sidecar stop command for an active pilot session.
- `POST /robot/:robot/pilot/speed-mode`: switch low, medium, or high speed caps.

## Phone Flow

Use the pilot page with a round and slot:

```text
/pilot.html?robot=guard&round=<roundId>&slot=challenger
/pilot.html?robot=courier&round=<roundId>&slot=opponent
```

The Start modal:

1. Connects the wallet.
2. Opens the local escrow if needed.
3. Requests typed data from the sidecar.
4. Signs race entry and permit typed data.
5. Submits the signatures to the sidecar facilitator.
6. Continues into the camera/control session after confirmation.

The main UI remains the camera view. Payment and entry states stay inside the
modal.

When `camera=local` is present, the UI uses the phone or laptop camera for the
main video surface while controls and telemetry still run through the sidecar
bridge. This keeps pre-hardware testing close to the final phone-shaped flow.

## Robot Link Contract

Phone controls send JSON to `/ws/drive`:

```json
{ "left": 0.2, "right": 0.2, "token": "...", "speed_mode": "medium", "t": 1760000000000 }
```

The sidecar clamps commands by speed mode and forwards this frame shape to the
robot socket:

```json
{
  "type": "control",
  "robot": "courier",
  "token": "...",
  "ts_ms": 1760000000000,
  "left": 0.35,
  "right": 0.35,
  "speed_mode": "medium",
  "max_speed": 0.35,
  "deadman_ms": 650
}
```

Robots send telemetry back on `/ws/robot`:

```json
{
  "type": "telemetry",
  "source": "sim",
  "ts_ms": 1760000000000,
  "robot": "courier",
  "battery_v": 12.3,
  "left_cmd": 0.1,
  "right_cmd": 0.1,
  "deadman_ok": true,
  "speed_mode": "medium",
  "max_speed": 0.35,
  "camera": { "status": "simulated" },
  "lidar": { "front_m": 1.2, "min_m": 1.0, "blocked": false }
}
```

If the phone disconnects or command frames stop for more than `deadman_ms`, the
sidecar forwards a zero-speed command and marks telemetry as stopped.

## Finish Detection

The finish detector contract is HTTP so it can be called by a camera process,
robot-side lidar process, simulator, or the operator harness:

```bash
curl -s -X POST http://127.0.0.1:4021/race/round/<roundId>/finish-detection \
  -H 'content-type: application/json' \
  -d '{
    "robot": "guard",
    "source": "finish-camera",
    "method": "line-crossing",
    "confidence": 0.93,
    "detectedAtMs": 1760000000000,
    "metrics": { "x": 412, "line": 390 }
  }'
```

The sidecar maps `robot` to the assigned driver slot, records the detection in
the evidence packet, and auto-finishes the local round unless
`"autoFinish": false` is supplied. A detector may also send `slot` directly
instead of `robot`.

Detection events are included in the result proof before the SHA-256
`proofHash` is generated. This means settlement can reference a proof that was
created from detector input rather than an operator winner click.

For local simulation, `npm run sim:finish -- <roundId>` connects to
`/ws/telemetry` for one or both robots and posts a finish detection when a
threshold is crossed.

Environment knobs:

- `SIDECAR_URL`: sidecar HTTP or WS base URL, defaults to `http://127.0.0.1:4021`
- `FINISH_ROBOTS`: comma-separated `guard,courier`, defaults to both
- `FINISH_MODE`: `odometry` or `lidar`, defaults to `odometry`
- `FINISH_ODOMETRY`: odometry threshold for simulated line crossing, defaults to `6`
- `FINISH_LIDAR_FRONT_M`: lidar front-distance threshold, defaults to `0.3`
- `DETECTOR_ONCE=0`: keep watching after the first detection

## Environment

Local defaults work after `chain:deploy`, but these can override them:

```bash
LOCAL_CHAIN_RPC_URL=http://127.0.0.1:8545
PUBLIC_LOCAL_CHAIN_RPC_URL=http://<laptop-ip>:8545
PUBLIC_SIDECAR_URL=http://<laptop-ip>:4021
LOCAL_CHAIN_ID=31337
RACE_TOKEN_ADDRESS=0x...
RACE_ESCROW_ADDRESS=0x...
LOCAL_TREASURY_ADDRESS=0x...
LOCAL_FACILITATOR_PRIVATE_KEY=0x...
LOCAL_TOKEN_OWNER_PRIVATE_KEY=0x...
LOCAL_RACE_AUTH_TTL_SECS=3600
RACE_NETWORK_FEE_USDC=0.25
STAKE_CHAIN_ID=8453
SPEND_PERMISSION_MANAGER_ADDRESS=0x...
STAKE_TOKEN_ADDRESS=0x...
STAKE_SPENDER_ADDRESS=0x...
STAKE_PERMISSION_TTL_SECS=600
ALLOW_LOCAL_DEV_WALLETS=1
```

`/chain/config` never returns private keys.

Phones need the public RPC URL, not `127.0.0.1`. `npm run chain:node` binds
Hardhat to `0.0.0.0` by default; set `PUBLIC_LOCAL_CHAIN_RPC_URL` to the
laptop LAN address so mobile wallets can reach it.

## Local Lifecycle

1. `challenge`: challenger creates the round in sidecar.
2. `accepted`: opponent joins the round in sidecar.
3. `fee paid`: each driver pays the fixed fleet fee through the x402 join route, or the local chain harness records the treasury fee during local rehearsal.
4. `stake authorized`: each driver signs a scoped Base SpendPermission for the matched stake, or the local escrow path records the upfront stake lock.
5. `opened`: sidecar opens the escrow on the local chain.
6. `joined`: each phone signs entry; facilitator submits both joins.
7. `locked`: escrow locks; sidecar can authorize robot sessions.
8. `started`: chain race starts when the local race starts.
9. `finished`: local finish records the winner, telemetry evidence, and immutable SHA-256 `proofHash`.
10. `settled`: facilitator pays the winner and leaves fees in treasury.

Canceled rounds include a `cancellation` summary with a stable code, reason,
fee policy, stake policy, and per-driver fee/stake status. Delegated stake
permissions remain visible as active or expired, but settlement planning rejects
canceled rounds.

For local rehearsal, `POST /race/round/:id/dev/join-local-wallets` can replace
steps 2 through 7 with the known Hardhat wallets. It is gated by
`ALLOW_LOCAL_DEV_WALLETS=1` or `ALLOW_FREE_PILOT=1` and never returns private
keys to the browser.

## Sensor Replay Fixtures

Recorded fixtures let the frontend, pilot HUD, minimap, perception events, and
trace summaries move without live cameras, motors, or lidar attached.

The default fixture is:

```text
sidecar/fixtures/sensor-replay/two-lane-heat.json
```

With the sidecar and local chain running, replay it into a real local round:

```sh
npm --prefix sidecar run replay:sensors
```

The replay runner creates a round, uses the local dev wallets to join and lock
escrow, attaches simulated `guard` and `courier` robot websocket clients, starts
the countdown, and streams the fixture frames through `WS /ws/robot`. The
resulting `GET /race/round/:id/telemetry-trace` output drives the same
HUD-facing state as live telemetry: camera status, lidar status, lane-aware
progress, safety events, and the event sequence.

For deterministic regression coverage, run:

```sh
npm --prefix sidecar run e2e:sensor-replay
```

The e2e uses the same fixture in fast mode and asserts expected trace events,
camera stale counts, lidar stale detection, lane assignment, and minimum stage
progress for both drivers.

## Evidence Packet

The sidecar records round snapshots at `locked`, `started`, `finished`, and
`settled`. At finish time it builds `onchain-rover.race-result-proof.v1` from:

- sanitized round lifecycle snapshots, without pilot tokens or signatures
- start and finish telemetry windows for both driver robots
- the operator finish input
- winner, finish time, chain race id, and driver assignments

The canonical JSON for that result proof is hashed with SHA-256. The resulting
`proofHash` is stored on the round and passed to `RaceEscrow.finishRace`.

After settlement, the sidecar also updates the append-only evidence packet hash
as `evidenceHash`. The on-chain race result uses `proofHash`; `evidenceHash`
tracks the full local packet, including the later settled snapshot.

Operator finish actions store `onchain-rover.operator-finish-proof.v1`
metadata on the round. The proof includes the confirmed winner, operator action
id, optional finish-frame hash, telemetry trace id, and a `settlementState`
that moves from `blocked` to `ready` at winner confirmation and then to
`settled` after payout submission.

On finish, the sidecar tries to capture a short burst from the winner robot's
camera. Captured proof frames are stored under the round directory in
`proof-frames/`, linked from the replay panel, and included in the normalized
proof metadata with frame hash, camera source, capture time, byte length, and
blob reference. If capture fails, the proof frame status is `failed` with an
error instead of silently claiming an image exists.

Telemetry trace files are stored as `telemetry.jsonl` beside `round.json`,
`evidence.json`, and `events.jsonl`. Each frame is tagged with round id, trace
id, driver slot, robot, timestamp, command, odometry, battery, speed mode,
deadman/estop state, camera status, and lidar status. The same file also stores
trace events for `countdown-start`, `go`, `obstacle-detected`,
`boundary-warning`, `camera-stale`, `lidar-stale`, `emergency-stop`,
`deadman-stop`, `finish-proof-captured`, and `race-finish`.

The pilot HUD renders camera health in two compact fields: state (`healthy`,
`stale`, `missing`, or `degraded`) and detail (`fps`, frame age, resolution, or
reconnect state). The same camera status is preserved in telemetry traces.

The pilot minimap is derived from the saved stage calibration plus live
telemetry. Progress comes from wheel odometry, lane placement from the
challenger/opponent assignment, heading from yaw when present, and confidence
degrades when camera/lidar/yaw/odometry signals are stale or missing. The same
lane-aware stage estimate is summarized under each driver in
`GET /race/round/:id/telemetry-trace`.

## Operator Lobby

Open the lobby from a laptop on the same network:

```text
http://<laptop-ip>:4021/lobby.html
```

Open the field checklist before bringing phones and robots online:

```text
http://<laptop-ip>:4021/field.html
```

For cold-boot hardware setup, use `docs/HARDWARE_BRINGUP.md` first. It covers
Jetson WiFi, serial ownership, Rust rover launch, bridge attachment, phone
links, emergency stop, and physical smoke checks.

`/field/preflight` is the machine-readable version. It reports:

- local chain health
- treasury fee accounting
- guard/courier sidecar bridge attachment state
- latest persisted rounds
- operator URLs for lobby, pilot links, and finish camera
- local harness env values that matter for field setup

`/lobby.html` redirects to `/round.html`, which now handles:

- create and accept a local two-driver round
- copy/open phone pilot links for challenger and opponent
- QR codes for both phones
- camera detector link for the active round
- No-Phone Prep for local Hardhat wallet entry without opening two phone wallets
- durable race history loaded from `GET /race/rounds`
- replay summary from the persisted evidence packet

No-Phone Prep fills the two known Hardhat wallet addresses, creates a round if
needed, opens escrow, mints local test tokens, signs both typed-data payloads in
the sidecar, submits both joins, and locks escrow. Use Local Sim Lock,
Countdown, and Start Race after that for a laptop-only rehearsal.

The phone links are still camera-first:

```text
/pilot.html?robot=guard&round=<roundId>&slot=challenger&camera=local
/pilot.html?robot=courier&round=<roundId>&slot=opponent&camera=local
```

## Signers And Delegated Pilot Sessions

`sidecar/web-src/signer.ts` defines the browser wallet signer boundary. The
pilot app now creates a wallet session with:

- canonical EVM address
- wallet kind (`base-account` or `injected-eip1193`)
- wallet label
- display-name fallback from the address

Base Account is preferred when the browser exposes a Base provider. Other
browser wallets use the generic EIP-1193 path. Name resolution stays
display-only; the address is still the canonical driver identity.

The pilot app uses the signer for:

- wallet connect
- local chain switch/add
- delegated stake typed data
- race-entry typed data
- token permit typed data

The signer boundary also exposes a `payRaceFee` capability so browser x402 fee
payment can be added without changing the pilot app. Today the authoritative
x402 fee path remains the server-gated `POST /race/round/:id/join` route.

After a slot joins the race, the pilot page asks the sidecar for a delegated
round pilot session:

```text
POST /race/round/:id/pilot/session
```

The sidecar only issues that bridge token when the slot is joined/authorized and
the round is locked, counting down, or racing. If a locked round has no
scheduled start, the endpoint refuses to mint a drivable token.

## Camera And Lidar Finish Adapters

Browser camera detector:

```text
http://<laptop-ip>:4021/finish-camera.html?round=<roundId>&robot=guard&slot=challenger
```

It uses the laptop or phone camera, watches a vertical finish-line strip, hashes
the trigger frame, and posts a `finish-detection` event. It also has a manual
trigger button for operator-confirmed test runs.

Lidar telemetry detector:

```bash
cd sidecar
SIDECAR_URL=http://127.0.0.1:4021 LIDAR_ROBOTS=guard,courier \
  LIDAR_FRONT_M=0.3 npm run detector:lidar -- <roundId>
```

It listens to `/ws/telemetry`, watches `lidar.front_m` or `lidar.min_m`, and
posts a finish detection when the threshold is crossed.

AprilTag finish spike:

```bash
npm --prefix sidecar run spike:apriltag-finish -- detections.jsonl
```

The spike consumes JSON or JSONL frames from a camera/CV process. Each frame can
include `frameId`, `ts_ms`, `brightness`, and `tags` with AprilTag `id`, center
`x`/`y`, and `confidence` or `decisionMargin`. It checks a normalized vertical
finish band (`APRILTAG_FINISH_BAND`, default `0.46,0.54`), maps tag ids to
drivers (`APRILTAG_CHALLENGER_IDS`, `APRILTAG_OPPONENT_IDS`), and reports:

- detected tag id, frame id, timestamp, confidence, and inferred winner
- false-positive tag events in the finish band
- latency against an optional operator winner/time in the input
- low-light constraints from frame brightness samples
- whether the sample is reliable enough to promote later

This is a spike report only. It does not gate v1 settlement or replace operator
finish confirmation.

## Robot Harness Bridge

The Rust `robot-harness` exposes its own `/ws/drive` and `/ws/telemetry`
contract. `sidecar/src/harness-bridge.ts` adapts that to the sidecar's
`/ws/robot` bridge socket:

```bash
cd sidecar
ROBOT=guard ROBOT_URL=http://127.0.0.1:8000 \
  SIDECAR_URL=http://127.0.0.1:4021 npm run bridge:harness
```

Use `npm run e2e:harness-bridge` to start a Rust simulator, attach the adapter,
drive through the sidecar bridge, and assert telemetry/odometry flows back.
