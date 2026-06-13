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

The script builds `target/release/rover-harness`, installs it to
`~/.local/bin/rover-harness`, writes
`~/.config/onchain-rover/robot-harness.env`, installs
`~/.config/systemd/user/robot-harness.service`, enables the service, and
restarts it.

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
pgrep -af 'app.py|uvicorn|read_serial|capture|voice'
pgrep -f '[a]pp.py' | xargs -r kill
pgrep -f '[u]vicorn.*api:app' | xargs -r kill
pgrep -f '[r]ead_serial|[c]apture|[v]oice' | xargs -r kill
```

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
