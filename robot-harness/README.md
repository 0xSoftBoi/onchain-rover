# Rover Harness

Rust race-mode service for one Jetson rover. It is the hardware boundary for
serial control, pilot tokens, deadman safety, speed caps, and telemetry.

## Local simulation

```bash
cd robot-harness
cargo run -- --mode sim --role courier --listen 127.0.0.1:8000
```

Authorize a pilot token:

```bash
curl -s http://127.0.0.1:8000/pilot/authorize \
  -H 'content-type: application/json' \
  -d '{"token":"dev","ttl_secs":120,"speed_mode":"medium"}'
```

Health:

```bash
curl -s http://127.0.0.1:8000/health
```

## Jetson serial mode

Stop the stock Waveshare app first so only this service owns `/dev/ttyTHS1`.

```bash
pgrep -f '[a]pp.py' | xargs -r kill
cd robot-harness
ROBOT_ROLE=courier ROVER_MODE=serial ROVER_SERIAL_PORT=/dev/ttyTHS1 \
  cargo run --release -- --listen 0.0.0.0:8000
```

Camera endpoints are controlled by environment. Without camera configuration,
the Rust server returns a deterministic placeholder stream and reports camera
status as `placeholder`.

```bash
ROVER_CAMERA_DEVICE=/dev/video0
ROVER_CAMERA_STREAM_URL=http://127.0.0.1:8000/stream
ROVER_CAMERA_SNAPSHOT_URL=http://127.0.0.1:8000/camera/snapshot
```

## API

- `GET /capabilities`
- `GET /health`
- `GET /telemetry`
- `GET /sensors`
- `GET /camera/status`
- `GET /camera/snapshot`
- `GET /stream`
- `POST /pilot/authorize`
- `POST /pilot/speed-mode`
- `POST /drive`
- `POST /motors/drive`
- `POST /motors/stop`
- `POST /stop`
- `POST /estop`
- `POST /estop/reset`
- `WS /ws/drive`
- `WS /ws/telemetry`

Drive commands are clamped server-side by the session speed mode:

- `low`: `0.15`
- `medium`: `0.25`
- `high`: `0.35`

The deadman stops motors when drive commands go stale.

`POST /stop` and `POST /estop` are latching hard stops. Use
`POST /estop/reset` to allow future drive commands again. Use
`POST /motors/stop` for a non-latching zero-speed command.
