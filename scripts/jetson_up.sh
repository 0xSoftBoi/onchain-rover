#!/usr/bin/env bash
# Phase 5 — one-command ROVER (Jetson) bringup. Stops the stock Waveshare web app
# (which holds the serial port + camera), then launches api.py with the autonomy
# stack pointed at the off-board servers. Run on EACH rover.
#
#   ROLE=guard   LAPTOP=192.168.1.50 ./scripts/jetson_up.sh
#   ROLE=courier LAPTOP=192.168.1.50 ./scripts/jetson_up.sh
set -euo pipefail
ROLE="${ROLE:-courier}"
LAPTOP="${LAPTOP:?set LAPTOP=<laptop-ip>}"
VENV="${VENV:-$HOME/ugv_jetson/ugv-env}"
ROBOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../robot" && pwd)"

echo "› stopping stock Waveshare app (frees serial + camera)"
pgrep -f '[a]pp.py' | xargs -r kill || true
sleep 1

export ROBOT_ROLE="$ROLE" ROVER="$ROLE"
export SIDECAR_URL="http://$LAPTOP:4021"
export NAV_SERVER="http://$LAPTOP:4041"
export BRAIN_SERVER="${BRAIN_SERVER:-http://$LAPTOP:4051}"
export ROVER_NAV="${ROVER_NAV:-nomad}"          # nomad → nav2 → primitive fallback
export ROVER_AUTONOMOUS=1                        # Act 1 goal-based navigation

echo "› role=$ROLE  nav=$NAV_SERVER  brain=$BRAIN_SERVER  ROVER_NAV=$ROVER_NAV"
cd "$ROBOT"
exec "$VENV/bin/python" -m uvicorn api:app --host 0.0.0.0 --port 8000
