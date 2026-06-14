#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: configure-stage-wifi.sh [options]

Configure a Jetson to prefer the stage WiFi profile at boot.

This script does not store WiFi passwords in the repo. If the NetworkManager
connection does not already exist, pass the password in ROVER_WIFI_PASSWORD.

Options:
  --ssid NAME                  Stage WiFi SSID / connection name. Default: TP-Link_A768.
  --ifname NAME                WiFi interface. Default: auto-detect first wifi device.
  --priority N                 NetworkManager autoconnect priority. Default: 500.
  --disable NAME               Disable autoconnect for another saved connection. Repeatable.
  --activate                   Bring the stage connection up now.
  --install-retry-service      Install a boot retry service that reactivates the saved profile.
  -h, --help                   Show this help.

Examples:
  ./robot-harness/deploy/configure-stage-wifi.sh \
    --ssid TP-Link_A768 --disable AccessPopup --activate --install-retry-service

  ROVER_WIFI_PASSWORD='...' ./robot-harness/deploy/configure-stage-wifi.sh \
    --ssid TP-Link_A768 --activate
EOF
}

ssid="${ROVER_WIFI_SSID:-TP-Link_A768}"
ifname="${ROVER_WIFI_IFNAME:-}"
priority="${ROVER_WIFI_PRIORITY:-500}"
activate=0
install_retry_service=0
disable_connections=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssid)
      ssid="${2:?--ssid requires a name}"
      shift 2
      ;;
    --ifname)
      ifname="${2:?--ifname requires a device name}"
      shift 2
      ;;
    --priority)
      priority="${2:?--priority requires a number}"
      shift 2
      ;;
    --disable)
      disable_connections+=("${2:?--disable requires a connection name}")
      shift 2
      ;;
    --activate)
      activate=1
      shift
      ;;
    --install-retry-service)
      install_retry_service=1
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

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required" >&2
    exit 1
  fi
}

run_sudo() {
  if sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
  else
    sudo "$@"
  fi
}

wifi_ifname() {
  if [[ -n "$ifname" ]]; then
    printf '%s\n' "$ifname"
    return
  fi
  nmcli -t -f DEVICE,TYPE dev status | awk -F: '$2 == "wifi" { print $1; exit }'
}

connection_exists() {
  nmcli -t -f NAME connection show | awk -F: -v name="$1" '$1 == name { found = 1 } END { exit found ? 0 : 1 }'
}

need nmcli

ifname="$(wifi_ifname)"
if [[ -z "$ifname" ]]; then
  echo "no WiFi interface found" >&2
  exit 1
fi

if ! connection_exists "$ssid"; then
  if [[ -z "${ROVER_WIFI_PASSWORD:-}" ]]; then
    echo "NetworkManager connection '$ssid' does not exist; set ROVER_WIFI_PASSWORD to create it." >&2
    exit 1
  fi
  run_sudo nmcli dev wifi connect "$ssid" password "$ROVER_WIFI_PASSWORD" ifname "$ifname" name "$ssid"
fi

run_sudo nmcli connection modify "$ssid" \
  connection.autoconnect yes \
  connection.autoconnect-priority "$priority"

for connection in "${disable_connections[@]}"; do
  if connection_exists "$connection"; then
    run_sudo nmcli connection modify "$connection" \
      connection.autoconnect no \
      connection.autoconnect-priority -999
  fi
done

if [[ "$install_retry_service" -eq 1 ]]; then
  run_sudo install -d -m 0755 /usr/local/sbin /etc/default /etc/systemd/system
  tmp_script="$(mktemp)"
  cat > "$tmp_script" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

config=/etc/default/onchain-rover-wifi
if [[ -f "$config" ]]; then
  # shellcheck disable=SC1090
  . "$config"
fi

ssid="${ROVER_WIFI_SSID:-TP-Link_A768}"
ifname="${ROVER_WIFI_IFNAME:-}"

if [[ -z "$ifname" ]]; then
  ifname="$(nmcli -t -f DEVICE,TYPE dev status | awk -F: '$2 == "wifi" { print $1; exit }')"
fi

if [[ -z "$ifname" ]]; then
  exit 0
fi

for _ in $(seq 1 30); do
  active="$(nmcli -t -f DEVICE,TYPE,STATE,CONNECTION dev status | awk -F: -v dev="$ifname" '$1 == dev && $2 == "wifi" { print $4 }')"
  if [[ "$active" == "$ssid" ]]; then
    exit 0
  fi
  nmcli dev wifi rescan ifname "$ifname" >/dev/null 2>&1 || true
  nmcli connection up "$ssid" ifname "$ifname" >/dev/null 2>&1 && exit 0
  sleep 2
done

exit 0
EOF
  run_sudo install -m 0755 "$tmp_script" /usr/local/sbin/onchain-rover-wifi-boot
  rm -f "$tmp_script"

  tmp_default="$(mktemp)"
  {
    printf 'ROVER_WIFI_SSID=%q\n' "$ssid"
    printf 'ROVER_WIFI_IFNAME=%q\n' "$ifname"
  } > "$tmp_default"
  run_sudo install -m 0644 "$tmp_default" /etc/default/onchain-rover-wifi
  rm -f "$tmp_default"

  tmp_unit="$(mktemp)"
  cat > "$tmp_unit" <<'EOF'
[Unit]
Description=Onchain Rover stage WiFi boot recovery
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/onchain-rover-wifi-boot

[Install]
WantedBy=multi-user.target
EOF
  run_sudo install -m 0644 "$tmp_unit" /etc/systemd/system/onchain-rover-wifi-boot.service
  rm -f "$tmp_unit"
  run_sudo systemctl daemon-reload
  run_sudo systemctl enable onchain-rover-wifi-boot.service >/dev/null
fi

if [[ "$activate" -eq 1 ]]; then
  run_sudo nmcli connection up "$ssid" ifname "$ifname"
fi

echo "WiFi boot profile configured:"
nmcli -t -f NAME,AUTOCONNECT,AUTOCONNECT-PRIORITY,DEVICE connection show | grep -E "^(${ssid}|$(IFS='|'; echo "${disable_connections[*]:-__never__}")):" || true
nmcli -t -f DEVICE,TYPE,STATE,CONNECTION dev status | grep -E "^${ifname}:wifi:" || true
