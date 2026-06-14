# Jetson Deployment

Use this when a Jetson should boot directly into the Rust `rover-harness`
service in serial mode.

## One-Command Install

Clone or update the repo on the Jetson, then run from the repo root.

GUARD on the travel-router WiFi profile:

```bash
ROBOT_ROLE=guard SIDECAR_URL=http://192.168.8.10:4021 \
  ./robot-harness/deploy/jetson-install.sh --profile wifi --start
```

COURIER on the travel-router WiFi profile:

```bash
ROBOT_ROLE=courier SIDECAR_URL=http://192.168.8.10:4021 \
  ./robot-harness/deploy/jetson-install.sh --profile wifi --start
```

USB-net provisioning profile:

```bash
ROBOT_ROLE=guard SIDECAR_URL=http://<laptop-usbnet-ip>:4021 \
  ./robot-harness/deploy/jetson-install.sh --profile usbnet --start
```

## Reset to Good State

Use this when the Jetson has drifted into a mixed state, for example Python
`api.py` is serving port `8000`, a stale capture process owns the camera, or the
Rust harness service is stopped. This is the deployable recovery command for a
robot that should boot and run the Rust service.

Run directly on the Jetson from the repo checkout:

```bash
./robot-harness/deploy/reset-good-state.sh \
  --role guard \
  --sidecar-url http://192.168.0.100:4021 \
  --profile wifi \
  --drive-invert
```

From the laptop, once SSH key access works:

```bash
./robot-harness/deploy/reset-jetson-over-ssh.sh jetson@172.16.2.151 \
  --repo-dir ~/onchain-rover \
  --role guard \
  --sidecar-url http://192.168.0.100:4021 \
  --profile wifi \
  --drive-invert
```

The reset script:

- stops legacy Python/Waveshare/capture owners
- builds and installs `~/.local/bin/rover-harness`
- rewrites `~/.config/onchain-rover/robot-harness.env`
- installs/enables/restarts `robot-harness.service`
- verifies `/health`, `/capabilities`, `/camera/status`, `/sensors`, and
  `/ws/telemetry`
- sends a final `/motors/stop`

## Stage WiFi Boot Profile

The robots should boot onto the stage router, not whichever saved hotspot was
last used during recovery. Configure the saved NetworkManager profile once:

```bash
./robot-harness/deploy/configure-stage-wifi.sh \
  --ssid TP-Link_A768 \
  --disable AccessPopup \
  --activate \
  --install-retry-service
```

If the `TP-Link_A768` connection does not exist yet, create it without putting
the password in shell history or the repo:

```bash
read -r -s ROVER_WIFI_PASSWORD
export ROVER_WIFI_PASSWORD
./robot-harness/deploy/configure-stage-wifi.sh --ssid TP-Link_A768 --activate --install-retry-service
unset ROVER_WIFI_PASSWORD
```

The retry service stores only the SSID/interface in `/etc/default/onchain-rover-wifi`.
The WiFi secret remains in NetworkManager's saved connection.

## Deploy Checker

Use the standalone Rust checker from the laptop to prove each bot is deployed as
the Rust harness, not just serving some compatible-looking HTTP endpoint.

```bash
npm run robot:deploy-check -- \
  --bot guard=http://172.16.2.151:8000 \
  --sidecar-url http://192.168.0.100:4021
```

Or call Cargo directly:

```bash
cargo run --manifest-path robot-harness/Cargo.toml --bin rover-deploy-check -- \
  --bot guard=http://172.16.2.151:8000 \
  --bot courier=http://192.168.0.192:8000 \
  --sidecar-url http://192.168.0.100:4021
```

The checker validates:

- `GET /health`
- Rust-only `GET /capabilities`
- Rust-only `GET /sensors`
- `GET /camera/status`
- `GET /stream`
- `WS /ws/telemetry`
- final `POST /motors/stop`

If a bot is still running the legacy Python API, the checker fails and prints
the exact `reset-jetson-over-ssh.sh` command for that robot.

## Stage Reset Config

`robot-harness/deploy/stage-targets.json` records the current stage URLs and
role-specific install flags. Treat the configured URLs as hints, not proof. The
checker proves the robot role from `/health`; the reset scripts write the role
env explicitly on the Jetson.

Current stage URLs:

- `guard`: `http://172.16.2.151:8000`
- `courier`: `http://192.168.0.192:8000`

Courier USB at `http://192.168.55.1:8000` is a recovery fallback only. Put it
behind the TP-Link URL in config so sidecar and deploy checks do not settle on
USB during normal operation.

The script builds `target/release/rover-harness`, installs it to
`~/.local/bin/rover-harness`, writes
`~/.config/onchain-rover/robot-harness.env`, installs
`~/.config/systemd/user/robot-harness.service`, enables the service, and
restarts it. During `--start`, it stops any existing user `robot-harness`
service and any ad hoc `rover-harness` process already owning port `8000`.

For boot without an interactive login, enable user-service lingering once:

```bash
sudo loginctl enable-linger "$USER"
```

## Runtime Env

The generated env file contains the serial-mode defaults:

```text
ROBOT_ROLE=guard
ROVER_LISTEN=0.0.0.0:8000
ROVER_MODE=serial
ROVER_SERIAL_PORT=/dev/ttyTHS1
ROVER_SERIAL_BAUD=115200
ROVER_DRIVE_INVERT=true
ROVER_DRIVE_SWAP=false
ROVER_CAMERA_DEVICE=/dev/video0
ROVER_LIDAR_ENABLED=true
ROVER_LIDAR_PORT=/dev/ttyACM0
ROVER_LIDAR_BAUD=230400
SIDECAR_URL=http://192.168.8.10:4021
```

Use `--force-env` to rewrite the env after changing role, camera, lidar, or
profile values:

```bash
./robot-harness/deploy/jetson-install.sh --role courier --disable-lidar --force-env --start
```

## Service Commands

```bash
systemctl --user status robot-harness --no-pager
journalctl --user -u robot-harness -f
systemctl --user restart robot-harness
systemctl --user stop robot-harness
```

Expected running status includes:

```text
Active: active (running)
```

Expected startup log includes:

```text
listening on 0.0.0.0:8000
```

## API Checks After Reboot

From the Jetson:

```bash
curl -s http://127.0.0.1:8000/health | python3 -m json.tool
curl -s http://127.0.0.1:8000/capabilities | python3 -m json.tool
curl -s http://127.0.0.1:8000/camera/status | python3 -m json.tool
curl -s http://127.0.0.1:8000/sensors | python3 -m json.tool
python3 ~/onchain-rover/robot-harness/scripts/ws_telemetry_smoke.py \
  --url ws://127.0.0.1:8000/ws/telemetry
```

Expected `health` pass:

```json
{
  "ok": true,
  "role": "guard"
}
```

Expected telemetry WebSocket pass:

```json
{
  "robot": "guard",
  "deadman_ok": true,
  "sensors": {}
}
```

From the laptop, replace `127.0.0.1` with the robot LAN IP:

```bash
curl -s http://192.168.8.71:8000/health | python3 -m json.tool
```

## Recovery

Stop old Python or Waveshare owners without rebooting:

```bash
LEGACY_ROBOT_PATTERN='[p]ython.*(app.py|read_serial|capture|voice)|[u]vicorn.*api:app|[c]apture_images'
pgrep -af "$LEGACY_ROBOT_PATTERN"
pgrep -f "$LEGACY_ROBOT_PATTERN" | xargs -r kill
```

Keep this pattern scoped. Some Jetson images have system processes named
`capture` or `capture-control`; those are not old robot API owners.

Restart the Rust service:

```bash
systemctl --user restart robot-harness
journalctl --user -u robot-harness -n 80 --no-pager
```

If serial is busy:

```bash
fuser -v /dev/ttyTHS1
```

If camera is unavailable:

```bash
fuser -v /dev/video0
$EDITOR ~/.config/onchain-rover/robot-harness.env
systemctl --user restart robot-harness
```

If lidar is absent for a run:

```bash
./robot-harness/deploy/jetson-install.sh --disable-lidar --force-env --start
```
