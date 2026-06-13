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
- `sidecar/web-src/pilot-app.ts`: camera-first phone UI; race payment appears only as a modal when a `round` query parameter is present.

## Commands

```bash
npm --prefix chain install
npm run chain:compile
npm run chain:test
npm run e2e:local-race
```

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

The deploy step writes `sidecar/src/generated/contracts.local.json`. Re-run it
whenever the local chain is reset.

## Sidecar Routes

- `GET /chain/config`: public local chain metadata and contract addresses.
- `GET /chain/health`: RPC and deployed-code check.
- `POST /race/round/:id/chain/open`: open a race escrow for an existing round.
- `POST /race/round/:id/chain/authorization-request`: build race entry and permit typed data for one driver slot.
- `POST /race/round/:id/chain/join`: submit signed typed data through the facilitator.
- `POST /race/round/:id/chain/lock`: lock escrow once both drivers joined.
- `POST /race/round/:id/chain/start`: mark the on-chain race started.
- `POST /race/round/:id/chain/settle`: finish and settle payout after the local round has a winner.
- `POST /race/round/:id/chain/cancel`: cancel and refund stakes.
- `GET /treasury/local`: local treasury fee balance.
- `GET /race/round/:id/evidence`: canonical evidence packet, lifecycle snapshots, and telemetry windows.
- `GET /race/round/:id/evidence/hash`: stable result proof hash plus current packet hash.
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
```

`/chain/config` never returns private keys.

Phones need the public RPC URL, not `127.0.0.1`. `npm run chain:node` binds
Hardhat to `0.0.0.0` by default; set `PUBLIC_LOCAL_CHAIN_RPC_URL` to the
laptop LAN address so mobile wallets can reach it.

## Local Lifecycle

1. `challenge`: challenger creates the round in sidecar.
2. `accepted`: opponent joins the round in sidecar.
3. `opened`: sidecar opens the escrow on the local chain.
4. `joined`: each phone signs entry; facilitator submits both joins.
5. `locked`: escrow locks; sidecar can authorize robot sessions.
6. `started`: chain race starts when the local race starts.
7. `finished`: local finish records the winner, telemetry evidence, and immutable SHA-256 `proofHash`.
8. `settled`: facilitator pays the winner and leaves fees in treasury.

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
