#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: restore-jetson-image.sh --image IMAGE --device DEVICE --yes-erase-device

Restore a captured Jetson image to boot media with dd.

This erases the entire target device. Use diskutil list or lsblk first and pass
the whole disk device, not a partition.

Options:
  --image PATH                 Source .img or .img.gz.
  --device DEVICE              Target disk device, for example /dev/rdisk4 or /dev/sdb.
  --yes-erase-device           Required confirmation for destructive write.
  --no-unmount                 Skip automatic unmount before writing.
  -h, --help                   Show this help.
EOF
}

image=""
device=""
confirm=0
unmount=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)
      image="${2:?--image requires a path}"
      shift 2
      ;;
    --device)
      device="${2:?--device requires a disk device}"
      shift 2
      ;;
    --yes-erase-device)
      confirm=1
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

if [[ -z "$image" || -z "$device" || "$confirm" -ne 1 ]]; then
  usage >&2
  exit 2
fi

if [[ ! -f "$image" ]]; then
  echo "image does not exist: $image" >&2
  exit 1
fi

if [[ ! -e "$device" ]]; then
  echo "device does not exist: $device" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    bs="4m"
    if [[ "$device" == /dev/disk* && "$device" != /dev/rdisk* ]]; then
      echo "warning: /dev/rdiskN is much faster than /dev/diskN on macOS" >&2
    fi
    if command -v diskutil >/dev/null 2>&1; then
      echo "Selected target device:"
      diskutil info "$device" | sed -n '1,28p'
      if [[ "$unmount" -eq 1 ]]; then
        diskutil unmountDisk "$device"
      fi
    fi
    ;;
  *)
    bs="4M"
    if command -v lsblk >/dev/null 2>&1; then
      echo "Selected target device:"
      lsblk "$device"
      if [[ "$unmount" -eq 1 ]]; then
        umount "${device}"* 2>/dev/null || true
      fi
    fi
    ;;
esac

echo "Restoring $image -> $device"
case "$image" in
  *.gz)
    gzip -dc "$image" | sudo dd of="$device" bs="$bs" conv=sync status=progress
    ;;
  *)
    sudo dd if="$image" of="$device" bs="$bs" conv=sync status=progress
    ;;
esac

sync
if command -v diskutil >/dev/null 2>&1; then
  diskutil eject "$device" || true
fi
echo "Restore complete."
