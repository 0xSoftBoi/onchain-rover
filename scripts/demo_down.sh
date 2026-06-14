#!/usr/bin/env bash
# Stop the supervised off-board servers started by demo_up.sh (kills the
# supervisor loops AND their child uvicorn processes).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/.demo-run"

for svc in nav brain; do
  pf="$RUN/$svc.pid"
  if [ -f "$pf" ]; then
    loop=$(cat "$pf")
    # kill the supervisor loop and any child it spawned (process group)
    pkill -P "$loop" 2>/dev/null || true
    kill "$loop" 2>/dev/null || true
    rm -f "$pf"
    echo "› stopped $svc (supervisor $loop)"
  fi
done
# belt-and-suspenders: any stray server uvicorns
pkill -f 'uvicorn (nav_policy_server|brain_service):app' 2>/dev/null || true
echo "› all off-board servers stopped"
