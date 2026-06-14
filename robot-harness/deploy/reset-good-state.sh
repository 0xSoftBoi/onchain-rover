#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: reset-good-state.sh [options]

Reset this Jetson to the known-good Rust robot-harness service state.

Run this on the Jetson from any checkout path. It stops legacy Python/Waveshare
owners, builds and installs the Rust harness, rewrites the service env, enables
the user systemd service, starts it, and verifies the Rust API surface.

Options:
  --role guard|courier          Robot role. Default: ROBOT_ROLE or guard.
  --sidecar-url URL             Sidecar URL. Default: SIDECAR_URL or http://192.168.0.100:4021.
  --profile wifi|usbnet         Profile label. Default: ROVER_PROFILE or wifi.
  --listen ADDR:PORT            Listen address. Default: 0.0.0.0:8000.
  --serial-port PATH            ESP32 serial device. Default: /dev/ttyTHS1.
  --drive-invert                Flip motor polarity so positive commands drive forward.
  --drive-swap                  Swap left/right wheel commands before serial write.
  --camera-device PATH          V4L2 camera device. Default: /dev/video0.
  --camera-size WxH             V4L2 capture size. Default: 320x240.
  --camera-fps N                V4L2 capture fps request. Default: 30.
  --camera-output-fps N         Optional output fps after ffmpeg re-encode.
  --camera-jpeg-quality N       Optional MJPEG quality for re-encode, 2 best to 31 worst.
  --no-camera-device            Do not configure direct V4L2 camera capture.
  --camera-stream-url URL       Optional upstream MJPEG stream to proxy.
  --camera-snapshot-url URL     Optional upstream snapshot URL to proxy.
  --lidar-port PATH             USB lidar device. Default: /dev/ttyACM0.
  --disable-lidar               Configure without lidar for this reset.
  --keep-env                    Do not rewrite an existing harness env file.
  --no-linger                   Do not try to enable user-service lingering.
  -h, --help                    Show this help.
EOF
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

role="${ROBOT_ROLE:-guard}"
sidecar_url="${SIDECAR_URL:-http://192.168.0.100:4021}"
profile="${ROVER_PROFILE:-wifi}"
listen="${ROVER_LISTEN:-0.0.0.0:8000}"
serial_port="${ROVER_SERIAL_PORT:-/dev/ttyTHS1}"
drive_invert="${ROVER_DRIVE_INVERT:-false}"
drive_swap="${ROVER_DRIVE_SWAP:-false}"
camera_device="${ROVER_CAMERA_DEVICE:-/dev/video0}"
camera_size="${ROVER_CAMERA_SIZE:-320x240}"
camera_fps="${ROVER_CAMERA_FPS:-30}"
camera_output_fps="${ROVER_CAMERA_OUTPUT_FPS:-}"
camera_jpeg_quality="${ROVER_CAMERA_JPEG_QUALITY:-}"
camera_stream_url="${ROVER_CAMERA_STREAM_URL:-}"
camera_snapshot_url="${ROVER_CAMERA_SNAPSHOT_URL:-}"
lidar_port="${ROVER_LIDAR_PORT:-/dev/ttyACM0}"
force_env=1
enable_linger=1
disable_lidar=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)
      role="${2:?--role requires guard or courier}"
      shift 2
      ;;
    --sidecar-url)
      sidecar_url="${2:?--sidecar-url requires a URL}"
      shift 2
      ;;
    --profile)
      profile="${2:?--profile requires wifi or usbnet}"
      shift 2
      ;;
    --listen)
      listen="${2:?--listen requires ADDR:PORT}"
      shift 2
      ;;
    --serial-port)
      serial_port="${2:?--serial-port requires a path}"
      shift 2
      ;;
    --drive-invert)
      drive_invert=true
      shift
      ;;
    --drive-swap)
      drive_swap=true
      shift
      ;;
    --camera-device)
      camera_device="${2:?--camera-device requires a path}"
      shift 2
      ;;
    --camera-size)
      camera_size="${2:?--camera-size requires WxH}"
      shift 2
      ;;
    --camera-fps)
      camera_fps="${2:?--camera-fps requires a number}"
      shift 2
      ;;
    --camera-output-fps)
      camera_output_fps="${2:?--camera-output-fps requires a number}"
      shift 2
      ;;
    --camera-jpeg-quality)
      camera_jpeg_quality="${2:?--camera-jpeg-quality requires a number}"
      shift 2
      ;;
    --no-camera-device)
      camera_device=""
      shift
      ;;
    --camera-stream-url)
      camera_stream_url="${2:?--camera-stream-url requires a URL}"
      shift 2
      ;;
    --camera-snapshot-url)
      camera_snapshot_url="${2:?--camera-snapshot-url requires a URL}"
      shift 2
      ;;
    --lidar-port)
      lidar_port="${2:?--lidar-port requires a path}"
      shift 2
      ;;
    --disable-lidar)
      disable_lidar=1
      shift
      ;;
    --keep-env)
      force_env=0
      shift
      ;;
    --no-linger)
      enable_linger=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$role" in
  guard|courier) ;;
  *) echo "--role must be guard or courier" >&2; exit 2 ;;
esac

case "$profile" in
  wifi|usbnet) ;;
  *) echo "--profile must be wifi or usbnet" >&2; exit 2 ;;
esac

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required" >&2
    exit 1
  fi
}

request() {
  local method="$1"
  local path="$2"
  curl -fsS --max-time 5 -X "$method" "http://127.0.0.1:8000$path"
}

verify_json() {
  local path="$1"
  echo "verify $path"
  request GET "$path"
  echo
}

need cargo
need curl

echo "resetting Jetson to Rust harness good state"
echo "  repo:    $repo_root"
echo "  role:    $role"
echo "  sidecar: $sidecar_url"
echo "  listen:  $listen"
echo "  invert:  $drive_invert"
echo "  swap:    $drive_swap"

echo "best-effort stop before changing owners"
curl -fsS --max-time 3 -X POST http://127.0.0.1:8000/motors/stop >/dev/null 2>&1 || true
curl -fsS --max-time 3 -X POST http://127.0.0.1:8000/stop >/dev/null 2>&1 || true

legacy_pattern='[p]ython.*(app.py|api:app|read_serial|capture_images|voice)|[u]vicorn.*api:app'
if pgrep -af "$legacy_pattern" >/dev/null 2>&1; then
  echo "stopping legacy robot owners"
  pgrep -af "$legacy_pattern" || true
  pgrep -f "$legacy_pattern" | xargs -r kill
  sleep 0.5
  if pgrep -af "$legacy_pattern" >/dev/null 2>&1; then
    echo "legacy owners survived SIGTERM; sending SIGKILL"
    pgrep -af "$legacy_pattern" || true
    pgrep -f "$legacy_pattern" | xargs -r kill -9
    sleep 0.5
  fi
fi

if [[ "$enable_linger" -eq 1 ]] && command -v loginctl >/dev/null 2>&1; then
  if sudo -n true >/dev/null 2>&1; then
    sudo -n loginctl enable-linger "$USER" || true
  else
    echo "warning: sudo is unavailable without a password; run once manually if boot service does not persist:"
    echo "  sudo loginctl enable-linger \"$USER\""
  fi
fi

install_args=(
  --role "$role"
  --profile "$profile"
  --sidecar-url "$sidecar_url"
  --listen "$listen"
  --serial-port "$serial_port"
  --lidar-port "$lidar_port"
  --start
)

if [[ "$force_env" -eq 1 ]]; then
  install_args+=(--force-env)
fi
if [[ -n "$camera_device" ]]; then
  install_args+=(--camera-device "$camera_device")
fi
install_args+=(--camera-size "$camera_size" --camera-fps "$camera_fps")
if [[ -n "$camera_output_fps" ]]; then
  install_args+=(--camera-output-fps "$camera_output_fps")
fi
if [[ -n "$camera_jpeg_quality" ]]; then
  install_args+=(--camera-jpeg-quality "$camera_jpeg_quality")
fi
if [[ -n "$camera_stream_url" ]]; then
  install_args+=(--camera-stream-url "$camera_stream_url")
fi
if [[ -n "$camera_snapshot_url" ]]; then
  install_args+=(--camera-snapshot-url "$camera_snapshot_url")
fi
if [[ "$disable_lidar" -eq 1 ]]; then
  install_args+=(--disable-lidar)
fi
if [[ "$drive_invert" == "true" || "$drive_invert" == "1" ]]; then
  install_args+=(--drive-invert)
fi
if [[ "$drive_swap" == "true" || "$drive_swap" == "1" ]]; then
  install_args+=(--drive-swap)
fi

"$script_dir/jetson-install.sh" "${install_args[@]}"

echo "waiting for Rust API"
for _ in {1..30}; do
  if curl -fsS --max-time 2 http://127.0.0.1:8000/capabilities >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

verify_json /health
verify_json /capabilities
verify_json /camera/status
verify_json /sensors

if command -v python3 >/dev/null 2>&1; then
  python3 "$repo_root/robot-harness/scripts/ws_telemetry_smoke.py" \
    --url ws://127.0.0.1:8000/ws/telemetry
fi

echo "final stop"
curl -fsS --max-time 5 -X POST http://127.0.0.1:8000/motors/stop
echo

echo "Rust harness good state is active."
echo "Useful commands:"
echo "  systemctl --user status robot-harness --no-pager"
echo "  journalctl --user -u robot-harness -f"
echo "  curl -s http://127.0.0.1:8000/capabilities | python3 -m json.tool"
