"""
Phase 5 — DEMO DOCTOR: one-command stage preflight. Run this right before you go
on, get a green/red checklist of every moving part, and know exactly what's down
BEFORE the audience does. Never raises — a dead service is a red line, not a crash.

    python demo_doctor.py            # check everything, exit 0 if all critical OK
    python demo_doctor.py --watch    # re-run every 3s until you Ctrl-C

Endpoints come from the same env as checkpoint.py / agent.py, so a working demo
config Just Works here too. Optional pieces (brain, second rover) are warnings,
not failures.
"""
import os
import sys
import time

import requests

SIDECAR = os.environ.get("SIDECAR_URL", "http://localhost:4021")
GUARD = os.environ.get("GUARD_URL", "http://172.16.1.29:8000")
COURIER = os.environ.get("COURIER_URL", "http://172.16.0.105:8000")
NAV_SERVER = os.environ.get("NAV_SERVER", "http://localhost:4041")
BRAIN_SERVER = os.environ.get("BRAIN_SERVER", "")          # optional
OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
BATT_MIN = float(os.environ.get("BATT_MIN", "10.0"))        # volts, warn below

GREEN, RED, YELLOW, DIM, RST = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


def _get(url, timeout=4):
    """HTTP GET that never raises -> (ok, json_or_None, err)."""
    try:
        r = requests.get(url, timeout=timeout)
        try:
            return r.ok, r.json(), None
        except ValueError:
            return r.ok, None, f"status {r.status_code}"
    except Exception as e:
        return False, None, str(e)[:80]


# --- individual checks: each returns (ok, detail, critical) ----------------
def check_health(name, base, critical=True):
    ok, data, err = _get(f"{base}/health")
    if ok:
        extra = ""
        if isinstance(data, dict) and data.get("backend"):
            extra = f" · backend={data['backend']}"
        return True, f"{base}{extra}", critical
    return False, f"{base} · {err or 'unhealthy'}", critical


def check_rover(name, base):
    ok, data, err = _get(f"{base}/telemetry")
    if not ok or not isinstance(data, dict):
        return False, f"{base} · {err or 'no telemetry'}", True
    if not data.get("ok", True):
        return False, f"{base} · {data.get('error','telemetry error')}", True
    v = data.get("battery_v")
    odom = data.get("odom")
    serial_ok = odom is not None and any(x is not None for x in (odom or []))
    if v is None:
        return False, f"{base} · serial/IMU silent", True
    flag = "" if v >= BATT_MIN else f"  {YELLOW}LOW BATTERY{RST}"
    sdet = "serial+IMU live" if serial_ok else "serial up, odom null"
    return v >= BATT_MIN, f"{base} · {v:.2f}V · {sdet}{flag}", True


def check_ollama():
    ok, data, err = _get(f"{OLLAMA}/api/tags")
    if not ok:
        return False, f"{OLLAMA} · {err or 'down'}", True
    models = [m.get("name", "") for m in (data.get("models", []) if isinstance(data, dict) else [])]
    want = os.environ.get("MODEL", "gemma3:1b")
    has = any(want.split(":")[0] in m for m in models)
    return has, f"{OLLAMA} · {len(models)} models" + ("" if has else f" · {YELLOW}missing {want}{RST}"), True


def check_registry():
    ok, reg, err = _get(f"{SIDECAR}/robot/registry")
    if not ok or not isinstance(reg, dict):
        return False, f"{err or 'no registry'}", False
    seen = [r for r in ("guard", "courier") if reg.get(r, {}).get("url")]
    return len(seen) == 2, f"registered: {', '.join(seen) or 'none'}", False


def build_checks():
    checks = [
        ("sidecar (x402/Arc)", lambda: check_health("sidecar", SIDECAR)),
        ("guard rover", lambda: check_rover("guard", GUARD)),
        ("courier rover", lambda: check_rover("courier", COURIER)),
        ("robot registry", check_registry),
        ("Ollama LLM", check_ollama),
        ("NoMaD policy server", lambda: check_health("nav", NAV_SERVER)),
    ]
    if BRAIN_SERVER:
        checks.append(("RoboBrain server", lambda: check_health("brain", BRAIN_SERVER, critical=False)))
    else:
        checks.append(("RoboBrain server", lambda: (False, "BRAIN_SERVER unset (pure-NoMaD mode)", False)))
    return checks


def run_once():
    print(f"\n{DIM}── DEMO DOCTOR ─ {SIDECAR} ──{RST}")
    crit_down = 0
    warn = 0
    for name, fn in build_checks():
        try:
            ok, detail, critical = fn()
        except Exception as e:                  # a check must never crash the board
            ok, detail, critical = False, f"check errored: {str(e)[:60]}", False
        if ok:
            mark = f"{GREEN}✓{RST}"
        elif critical:
            mark = f"{RED}✗{RST}"; crit_down += 1
        else:
            mark = f"{YELLOW}!{RST}"; warn += 1
        print(f"  {mark} {name:22s} {DIM}{detail}{RST}")
    if crit_down:
        print(f"\n  {RED}NOT READY{RST} — {crit_down} critical down, {warn} warnings\n")
    elif warn:
        print(f"\n  {GREEN}READY{RST} {YELLOW}(with {warn} warning(s)){RST}\n")
    else:
        print(f"\n  {GREEN}ALL GREEN — ready to demo{RST}\n")
    return crit_down == 0


if __name__ == "__main__":
    if "--watch" in sys.argv:
        try:
            while True:
                run_once()
                time.sleep(3)
        except KeyboardInterrupt:
            sys.exit(0)
    else:
        sys.exit(0 if run_once() else 1)
