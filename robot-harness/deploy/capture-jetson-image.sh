#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: capture-jetson-image.sh --device DEVICE [options]

Capture a powered-down Jetson boot disk to a flashable image.

Use this from the laptop after removing the Jetson microSD/NVMe/USB boot media
and attaching it through a card reader or USB enclosure. Do not image a mounted
live Jetson root filesystem over SSH.

Options:
  --device DEVICE              Source disk device, for example /dev/rdisk4 or /dev/sdb.
  --output PATH                Output image path. Default: ./jetson-ROLE-TIMESTAMP.img.gz.
  --role guard|courier|stage   Label written to the manifest. Default: stage.
  --raw                        Write a raw .img instead of .img.gz.
  --no-unmount                 Skip automatic unmount before reading.
  -h, --help                   Show this help.
EOF
}

device=""
role="stage"
output=""
compress=1
unmount=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)
      device="${2:?--device requires a disk device}"
      shift 2
      ;;
    --output)
      output="${2:?--output requires a path}"
      shift 2
      ;;
    --role)
      role="${2:?--role requires a label}"
      shift 2
      ;;
    --raw)
      compress=0
      shift
      ;;
    --no-unmount)
      unmount=0
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

if [[ -z "$device" ]]; then
  usage >&2
  exit 2
fi

if [[ ! -e "$device" ]]; then
  echo "device does not exist: $device" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -z "$output" ]]; then
  if [[ "$compress" -eq 1 ]]; then
    output="jetson-${role}-${timestamp}.img.gz"
  else
    output="jetson-${role}-${timestamp}.img"
  fi
fi

case "$(uname -s)" in
  Darwin)
    bs="4m"
    if command -v diskutil >/dev/null 2>&1; then
      echo "Selected source device:"
      diskutil info "$device" | sed -n '1,28p'
      if [[ "$unmount" -eq 1 ]]; then
        diskutil unmountDisk "$device"
      fi
    fi
    ;;
  *)
    bs="4M"
    if command -v lsblk >/dev/null 2>&1; then
      echo "Selected source device:"
      lsblk "$device"
      if [[ "$unmount" -eq 1 ]]; then
        umount "${device}"* 2>/dev/null || true
      fi
    fi
    ;;
esac

mkdir -p "$(dirname "$output")"
tmp="${output}.partial"
rm -f "$tmp"

echo "Capturing $device -> $output"
if [[ "$compress" -eq 1 ]]; then
  sudo dd if="$device" bs="$bs" status=progress | gzip -1 > "$tmp"
else
  sudo dd if="$device" of="$tmp" bs="$bs" status=progress
fi
mv "$tmp" "$output"

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$output" > "${output}.sha256"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$output" > "${output}.sha256"
fi

manifest="${output}.manifest.txt"
{
  echo "created_at_utc=$timestamp"
  echo "role=$role"
  echo "source_device=$device"
  echo "output=$output"
  echo "compressed=$compress"
  echo "host=$(hostname)"
  echo "uname=$(uname -a)"
  if [[ -f "${output}.sha256" ]]; then
    echo "sha256=$(awk '{print $1}' "${output}.sha256")"
  fi
} > "$manifest"

echo "Wrote:"
echo "  $output"
[[ -f "${output}.sha256" ]] && echo "  ${output}.sha256"
echo "  $manifest"
