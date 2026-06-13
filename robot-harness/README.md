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
  ROVER_LIDAR_PORT=/dev/ttyACM0 ROVER_LIDAR_BAUD=230400 \
  cargo run --release -- --listen 0.0.0.0:8000
```

The USB lidar is read directly by the Rust harness. The current hardware uses
an LD06/LD19-compatible binary stream on `/dev/ttyACM0` at `230400` baud. Set
`ROVER_LIDAR_ENABLED=0` to run without it, or adjust
`ROVER_LIDAR_BLOCK_THRESHOLD_M` when the finish/obstacle threshold needs to
move from the default `0.30m`.

Camera endpoints are controlled by environment. In sim mode, the Rust server
returns a deterministic synthetic camera stream for local tests. In serial mode,
the server does not fake a physical camera feed: without a live source it reports
camera status as `unavailable`, or `configured` when a device path is present but
direct capture is not enabled.

```bash
ROVER_CAMERA_DEVICE=/dev/video0
ROVER_CAMERA_STREAM_URL=http://127.0.0.1:8000/stream
ROVER_CAMERA_SNAPSHOT_URL=http://127.0.0.1:8000/camera/snapshot
```

When `ROVER_CAMERA_STREAM_URL` or `ROVER_CAMERA_SNAPSHOT_URL` is set, camera
status reports `proxy` and the Rust server relays the configured upstream body
from `/stream` and `/camera/snapshot`. If only one proxy URL is set, both
camera endpoints relay that source. Direct `/dev/video0` capture is intentionally
deferred until the Jetson camera stack is stable.

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

`GET /sensors`, `GET /telemetry`, and `WS /ws/telemetry` expose the same
grouped sensor contract under `sensors`:

- `battery`: voltage and availability
- `odometry`: left/right wheel odometry and availability
- `imu`: accel/gyro/mag/yaw values when present
- `lidar`: LD06/LD19 range status with `front_m`, `min_m`, `blocked`, frame age,
  and stale/error states
- `camera`: simulated/proxy/configured/unavailable camera status
- `raw_frame`: source, latest raw telemetry timestamp, and frame age

The telemetry frame also keeps the older flat fields (`battery_v`,
`odometry_left`, `odometry_right`, `last_raw_frame_ms`) for current sidecar and
pilot UI compatibility.

Drive commands are clamped server-side by the session speed mode:

- `low`: `0.15`
- `medium`: `0.25`
- `high`: `0.35`

The deadman stops motors when drive commands go stale.

`POST /stop` and `POST /estop` are latching hard stops. Use
`POST /estop/reset` to allow future drive commands again. Use
`POST /motors/stop` for a non-latching zero-speed command.

## Physical Drive Smoke

The smoke script refuses to move hardware unless the operator explicitly gates
motion. Use it only when the robot is lifted, blocked, or otherwise safe.

```bash
ALLOW_PHYSICAL_MOTION=1 ROVER_URL=http://192.168.55.1:8000 \
  ./scripts/drive_smoke.py --speed-mode low --left 0.05 --right 0.05 --duration-ms 250
```

The script authorizes a short-lived token, sends one tiny command, always posts
`/motors/stop`, and fails unless wheel odometry changes.
