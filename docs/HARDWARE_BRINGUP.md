# Hardware Bring-Up Runbook

Use this when a new operator needs to bring both rovers from cold boot to a
race-ready state without reverse-engineering commands.

The target topology is:

- operator laptop runs `sidecar` on port `4021`
- GUARD Jetson runs `robot-harness` on port `8000`
- COURIER Jetson runs `robot-harness` on port `8000`
- all devices are on the same travel-router LAN
- each robot owns its serial, lidar, and camera devices through the Rust harness

## 0. Set The Event Network

Use the travel router as the private LAN for the demo. Join the laptop and both
Jetsons to that router before opening the venue WiFi dependency chain.

Recommended leases:

```text
laptop  192.168.8.10
guard   192.168.8.71
courier 192.168.8.72
```

On each Jetson, confirm WiFi and IP:

```bash
nmcli dev status
ip -4 addr show wlan0
```

Expected pass:

```text
wlan0 connected <travel-router-ssid>
inet 192.168.8.71/24 ...
```

Expected fail:

```text
wlan0 disconnected
```

Fix: connect to the travel router:

```bash
nmcli dev wifi connect '<ssid>' password '<password>'
```

USB-net at `192.168.55.1` is only for provisioning. Do not depend on it during
the race; camera and audio init can reset USB and drop that SSH session.

## 1. Prepare The Laptop

From the repo root:

```bash
cd sidecar
npm ci
npm run build:pilot
npm run build:ledger
```

Export the LAN URLs before starting sidecar:

```bash
export PUBLIC_SIDECAR_URL=http://192.168.8.10:4021
export GUARD_URL=http://192.168.8.71:8000
export COURIER_URL=http://192.168.8.72:8000
```

For a local rehearsal without phone wallets:

```bash
export ALLOW_FREE_PILOT=1
export ALLOW_LOCAL_DEV_WALLETS=1
```

For local chain entry and faucet buttons, also set:

```bash
export LOCAL_FACILITATOR_PRIVATE_KEY=0x...
export LOCAL_TOKEN_OWNER_PRIVATE_KEY=0x...
```

Do not print private keys in the venue terminal.

Start sidecar:

```bash
npm start
```

Expected pass:

```text
sidecar on :4021
```

Expected fail:

```text
EADDRINUSE: address already in use :::4021
```

Fix: stop the old sidecar process or set a different `PORT`.

## 2. Stop Stock Robot Processes

The stock Waveshare app and older Python services can own `/dev/ttyTHS1`,
`/dev/video0`, or other robot devices. Stop them before starting Rust.

On each Jetson:

```bash
pgrep -af 'app.py|uvicorn|read_serial|capture|voice'
pgrep -f '[a]pp.py' | xargs -r kill
pgrep -f '[u]vicorn.*api:app' | xargs -r kill
pgrep -f '[r]ead_serial|[c]apture|[v]oice' | xargs -r kill
```

Expected pass after stopping:

```bash
pgrep -af 'app.py|uvicorn|read_serial|capture|voice'
```

prints nothing, or only the current `pgrep` command.

Expected fail:

```text
1234 python3 app.py
```

Fix: kill the listed process. Avoid `pkill -f app.py` over SSH because it can
match your own shell command and drop the session.

## 3. Confirm Device Ownership

On each Jetson:

```bash
ls -l /dev/ttyTHS1 /dev/video0
ls -l /dev/ttyACM0 2>/dev/null || true
fuser -v /dev/ttyTHS1 /dev/video0 /dev/ttyACM0 2>/dev/null || true
```

Expected pass:

```text
/dev/ttyTHS1
/dev/video0
```

and `fuser` shows no owning process for devices the Rust harness should own.

Expected fail:

```text
                     USER        PID ACCESS COMMAND
/dev/ttyTHS1:        jetson     1234 F.... python3
```

Fix: stop that process before continuing.

## 4. Start Rust Rover Service

Preferred install/update path from the repo root on each Jetson:

```bash
ROBOT_ROLE=guard SIDECAR_URL=http://192.168.8.10:4021 \
  ./robot-harness/deploy/jetson-install.sh --profile wifi --start
```

```bash
ROBOT_ROLE=courier SIDECAR_URL=http://192.168.8.10:4021 \
  ./robot-harness/deploy/jetson-install.sh --profile wifi --start
```

Expected pass:

```text
Active: active (running)
```

Check logs:

```bash
systemctl --user status robot-harness --no-pager
journalctl --user -u robot-harness -n 80 --no-pager
```

Use `robot-harness/deploy/README.md` for USB-net profiles, env rewrites, and
reboot-persistent service setup. For foreground debugging, run the binary
directly:

On GUARD:

```bash
cd ~/onchain-rover/robot-harness
ROBOT_ROLE=guard \
ROVER_MODE=serial \
ROVER_SERIAL_PORT=/dev/ttyTHS1 \
ROVER_LIDAR_PORT=/dev/ttyACM0 \
ROVER_LIDAR_BAUD=230400 \
ROVER_CAMERA_DEVICE=/dev/video0 \
cargo run --release -- --listen 0.0.0.0:8000
```

On COURIER:

```bash
cd ~/onchain-rover/robot-harness
ROBOT_ROLE=courier \
ROVER_MODE=serial \
ROVER_SERIAL_PORT=/dev/ttyTHS1 \
ROVER_LIDAR_PORT=/dev/ttyACM0 \
ROVER_LIDAR_BAUD=230400 \
ROVER_CAMERA_DEVICE=/dev/video0 \
cargo run --release -- --listen 0.0.0.0:8000
```

If lidar is absent:

```bash
ROVER_LIDAR_ENABLED=false
```

If camera is proxied by another local capture service:

```bash
ROVER_CAMERA_STREAM_URL=http://127.0.0.1:<port>/stream
ROVER_CAMERA_SNAPSHOT_URL=http://127.0.0.1:<port>/camera/snapshot
```

Expected pass:

```text
listening on 0.0.0.0:8000
```

Expected fail:

```text
Address already in use
Permission denied: /dev/ttyTHS1
```

Fix: stop the process using port `8000`, add the user to the device group, or
run with the permissions already used for the Waveshare stack.

## 5. Robot API Checks

From the laptop:

```bash
curl -s http://192.168.8.71:8000/health | python3 -m json.tool
curl -s http://192.168.8.72:8000/health | python3 -m json.tool
curl -s http://192.168.8.71:8000/capabilities | python3 -m json.tool
curl -s http://192.168.8.71:8000/sensors | python3 -m json.tool
curl -s http://192.168.8.71:8000/camera/status | python3 -m json.tool
curl -s http://192.168.8.72:8000/sensors | python3 -m json.tool
curl -s http://192.168.8.72:8000/camera/status | python3 -m json.tool
```

Expected pass:

```json
{
  "ok": true,
  "role": "guard"
}
```

`/sensors` should include grouped fields for `battery`, `odometry`, `imu`,
`lidar`, `camera`, and `raw_frame`. Missing lidar or camera is allowed only when
reported explicitly as unavailable, configured, stale, or absent.

Expected fail:

```text
curl: (7) Failed to connect
```

Fix: check Jetson IP, firewall, service logs, and that the harness is listening
on `0.0.0.0:8000`.

## 6. Attach Robots To The Sidecar Bridge

The sidecar must see live robot bridge telemetry before the phone controls are
trusted. If the Rust server is already configured to attach to the sidecar, use
that service profile. For laptop-driven bridge testing, run one adapter per
robot in separate terminals:

```bash
cd sidecar
ROBOT=guard ROBOT_URL=http://192.168.8.71:8000 \
  SIDECAR_URL=http://192.168.8.10:4021 npm run bridge:harness
ROBOT=courier ROBOT_URL=http://192.168.8.72:8000 \
  SIDECAR_URL=http://192.168.8.10:4021 npm run bridge:harness
```

Then check:

```bash
curl -s http://192.168.8.10:4021/robot-link/state | python3 -m json.tool
```

Expected pass:

```json
{
  "robots": {
    "guard": {
      "robotConnected": true
    },
    "courier": {
      "robotConnected": true
    }
  }
}
```

Expected fail:

```json
{
  "robots": {
    "courier": {
      "robotConnected": false
    }
  }
}
```

Fix: start the bridge adapter, confirm `PUBLIC_SIDECAR_URL`, and confirm the
robot can reach the laptop over the travel-router LAN.

## 7. Run Operator Preflight

Use the browser first:

```text
http://192.168.8.10:4021/field.html
```

Use the command-line board when the browser is not available:

```bash
cd sidecar
npm exec tsx -- src/preflight.ts
```

Use the machine-readable endpoint for logs:

```bash
curl -s http://192.168.8.10:4021/field/preflight | python3 -m json.tool
```

Expected pass:

```json
{
  "ok": true,
  "summary": {
    "fail": 0
  }
}
```

Expected fail:

```json
{
  "status": "fail",
  "name": "courier service",
  "remediation": "Check robot power, WiFi or USB-net, service port, and stale ROBOT_URL values."
}
```

Treat any `fail` as a blocker. Treat `warn` as acceptable only when it matches a
deliberate rehearsal mode, such as no active round before drivers arrive.

## 8. Create And Calibrate The Round

Open:

```text
http://192.168.8.10:4021/round.html
```

In Stage Calibration, verify:

```text
Lane length ft: 60
Lane width ft: 4
Start line ft: 0
Finish line ft: 60
Challenger: guard / left
Opponent: courier / right
Default speed: medium
Max speed: medium
Stop distance ft: 2
Warning distance ft: 5
```

Click `Save Calibration`.

Expected pass in Round State:

```text
stage 60ft run · 4ft lane · medium/medium
```

Expected fail:

```text
challenger and opponent must use different robots
challenger and opponent must use different lanes
```

Fix: assign unique robots and lanes, then save again.

## 9. Phone Connection

After creating the round, use the QR codes or links from `round.html`:

```text
http://192.168.8.10:4021/pilot.html?robot=guard&round=<roundId>&slot=challenger&camera=local
http://192.168.8.10:4021/pilot.html?robot=courier&round=<roundId>&slot=opponent&camera=local
```

Expected pass on each phone:

```text
Enter Race
Wallet signature required
```

After entry and lock:

```text
drive + telemetry
```

Expected fail:

```text
round must be locked before pilot delegation
round has not started
```

Fix: use `round.html` to join/fund, lock escrow, authorize robots, and start the
countdown before trying to drive.

## 10. Emergency Stop

From the sidecar:

```bash
curl -s -X POST http://192.168.8.10:4021/robot/guard/stop \
  -H 'content-type: application/json' \
  -d '{"token":"<active-token>"}'
curl -s -X POST http://192.168.8.10:4021/robot/courier/stop \
  -H 'content-type: application/json' \
  -d '{"token":"<active-token>"}'
```

From the robot directly:

```bash
curl -s -X POST http://192.168.8.71:8000/estop
curl -s -X POST http://192.168.8.72:8000/estop
```

Expected pass:

```json
{
  "stopped": true
}
```

or the robot reports an estop state in `/health` or `/telemetry`.

Reset only after the robot is physically safe:

```bash
curl -s -X POST http://192.168.8.71:8000/estop/reset
curl -s -X POST http://192.168.8.72:8000/estop/reset
```

## 11. Physical Drive Smoke

Run this only with the robot lifted, blocked, or otherwise safe.

```bash
cd robot-harness
ALLOW_PHYSICAL_MOTION=1 ROVER_URL=http://192.168.8.72:8000 \
  ./scripts/drive_smoke.py --speed-mode low --left 0.05 --right 0.05 --duration-ms 250
```

Expected pass:

```json
{
  "ok": true,
  "speed_mode": "low",
  "delta": 0.001,
  "stopped": true
}
```

Expected fail:

```text
refusing to move: set ALLOW_PHYSICAL_MOTION=1 after making the robot safe
drive smoke failed: odometry did not change enough
POST /drive failed with HTTP 400
```

Fix: confirm the explicit motion gate, pilot token acceptance, serial telemetry,
and that estop is reset.

## 12. Recovery Matrix

| Symptom | Check | Fix |
| --- | --- | --- |
| Phone cannot open page | `curl http://<laptop-ip>:4021/field/preflight` from another LAN device | Set `PUBLIC_SIDECAR_URL`, join the travel-router LAN, allow port `4021`. |
| Robot service unreachable | `curl http://<robot-ip>:8000/health` | Check robot IP, harness process, `--listen 0.0.0.0:8000`, and router lease. |
| Serial busy | `fuser -v /dev/ttyTHS1` | Stop stock Waveshare app or old Python serial reader. |
| Camera missing | `curl /camera/status` and `fuser -v /dev/video0` | Stop camera owner, set proxy URLs, or mark camera unavailable before racing. |
| Lidar absent | `curl /sensors` | Check `/dev/ttyACM0`, baud `230400`, or set `ROVER_LIDAR_ENABLED=false`. |
| Pilot says round not locked | `round.html` Round State | Join both drivers, lock escrow, authorize robots, then countdown. |
| Robot moves after release | `/robot-link/state` deadman fields | Hit STOP, then inspect sidecar bridge logs and Rust deadman settings. |
| Estop blocks drive | `curl /health` on robot | Only reset with `/estop/reset` after physical inspection. |

## 13. Final Go/No-Go

Before judges or drivers arrive, require:

- `/field/preflight` has `summary.fail: 0`
- both robot services pass `/health`
- both robot bridges show `robotConnected: true`
- stage calibration is saved for the active round
- both phones can open their pilot links
- operator has tested STOP and knows the direct `/estop` URLs
- physical smoke has passed only under the explicit motion gate
