#!/usr/bin/env bash
# Phase 5 — one-command LAPTOP bringup for the off-board servers (NoMaD policy +
# RoboBrain brain). Creates a venv on first run, then launches both under a
# supervisor loop that RESTARTS them if they crash mid-demo. Stub-capable: with no
# extra installs it serves the stub backends so the whole pipeline runs dry.
#
#   POLICY_BACKEND=stub BRAIN_BACKEND=stub ./scripts/demo_up.sh      # dry run
#   POLICY_BACKEND=nomad BRAIN_BACKEND=robobrain ./scripts/demo_up.sh # real (GPU)
#   ./scripts/demo_down.sh                                            # stop all
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROBOT="$ROOT/robot"
VENV="$ROOT/.demo-venv"
RUN="$ROOT/.demo-run"; mkdir -p "$RUN"

POLICY_BACKEND="${POLICY_BACKEND:-stub}"
BRAIN_BACKEND="${BRAIN_BACKEND:-stub}"
NAV_PORT="${NAV_PORT:-4041}"
BRAIN_PORT="${BRAIN_PORT:-4051}"

if [ ! -d "$VENV" ]; then
  echo "› creating venv at $VENV"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" -q install --upgrade pip
  "$VENV/bin/pip" -q install -r "$ROBOT/requirements-servers.txt"
  echo "› venv ready (stub-capable). For real weights see requirements-servers.txt"
fi

# supervisor: keep $1 alive, log to $2, restart with backoff; pid of the loop -> $3
supervise() {
  local name="$1" log="$2" pidfile="$3"; shift 3
  ( while true; do
      echo "[$(date +%H:%M:%S)] starting $name" >>"$log"
      "$@" >>"$log" 2>&1 || true
      echo "[$(date +%H:%M:%S)] $name exited — restarting in 2s" >>"$log"
      sleep 2
    done ) &
  echo $! >"$pidfile"
}

cd "$ROBOT"
POLICY_BACKEND="$POLICY_BACKEND" supervise "nav_policy_server($POLICY_BACKEND)" \
  "$RUN/nav.log" "$RUN/nav.pid" \
  "$VENV/bin/python" -m uvicorn nav_policy_server:app --host 0.0.0.0 --port "$NAV_PORT"
BRAIN_BACKEND="$BRAIN_BACKEND" supervise "brain_service($BRAIN_BACKEND)" \
  "$RUN/brain.log" "$RUN/brain.pid" \
  "$VENV/bin/python" -m uvicorn brain_service:app --host 0.0.0.0 --port "$BRAIN_PORT"

echo "› nav   → http://0.0.0.0:$NAV_PORT   (backend=$POLICY_BACKEND, log $RUN/nav.log)"
echo "› brain → http://0.0.0.0:$BRAIN_PORT   (backend=$BRAIN_BACKEND, log $RUN/brain.log)"
echo "› supervised + auto-restarting. Stop with: ./scripts/demo_down.sh"
echo "› preflight: python robot/demo_doctor.py --watch"
