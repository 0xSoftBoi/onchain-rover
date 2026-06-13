"""
On-robot terminal dashboard — run this in each Jetson's terminal for a live,
awesome view of what THAT robot is doing. Zero deps (pure ANSI), works over SSH.

    python robot_tui.py                 # reads localhost:8000
    ROBOT_API=http://172.16.1.29:8000 python robot_tui.py   # remote

Shows: role banner, battery gauge, current action, IMU/odometry, and a live
activity feed (SEEK, GIBBERLINK, AUCTION, ADMIT/DENY, WALRUS, ...).
"""
import os
import time
from datetime import datetime

import requests

API = os.environ.get("ROBOT_API", "http://localhost:8000")
W = 60  # panel width

C = {"reset": "\033[0m", "dim": "\033[2m", "b": "\033[1m",
     "grn": "\033[92m", "red": "\033[91m", "yel": "\033[93m",
     "cyn": "\033[96m", "mag": "\033[95m", "blu": "\033[94m"}
ICON = {"SEEK": "🔍", "CAPTURE": "📸", "WALRUS": "🌊", "SAY": "🔊",
        "✓ ADMIT": "🟢", "✗ DENY": "🔴", "GIBBERLINK ▶": "📡",
        "AUCTION ◀": "🤠", "AUCTION ▶": "🤖", "idle": "·"}


def bar(frac, n=20, color="grn"):
    frac = max(0.0, min(1.0, frac))
    fill = int(frac * n)
    return f"{C[color]}{'█'*fill}{C['dim']}{'░'*(n-fill)}{C['reset']}"


def line(s=""):
    # pad/truncate to width inside the box
    raw = s
    # strip ANSI for length calc
    import re
    vis = re.sub(r"\033\[[0-9;]*m", "", raw)
    pad = max(0, W - len(vis))
    return f"│ {raw}{' '*pad} │"


def render():
    try:
        t = requests.get(f"{API}/telemetry", timeout=3).json()
        a = requests.get(f"{API}/activity", timeout=3).json()
    except Exception as e:
        return f"  connecting to {API} … ({str(e)[:40]})"
    role = (t.get("role") or "?").upper()
    up = t.get("ok")
    batt = t.get("battery_v") or 0
    bfrac = (batt - 9.0) / (12.6 - 9.0)   # ~9V empty, 12.6 full
    bcol = "grn" if batt >= 11.5 else "yel" if batt >= 10.5 else "red"
    odom = t.get("odom") or [None, None]
    gyro = t.get("gyro") or [None, None, None]
    action = t.get("action", "idle")
    icon = ICON.get(action, "▸")

    top = f"╭{'─'*(W+2)}╮"
    bot = f"╰{'─'*(W+2)}╯"
    out = [top]
    dot = f"{C['grn']}●{C['reset']}" if up else f"{C['red']}●{C['reset']}"
    out.append(line(f"{dot} {C['b']}{C['cyn']}{role}.rover.eth{C['reset']}  "
                    f"{C['dim']}onchain rover{C['reset']}"))
    out.append(line(f"  battery {bar(bfrac, 22, bcol)} {C[bcol]}{batt:.2f}V{C['reset']}"))
    out.append(line(f"  doing   {icon} {C['b']}{C['yel']}{action}{C['reset']}"))
    out.append(line(f"  odom    L {odom[0]}  R {odom[1]}   "
                    f"{C['dim']}gyro {gyro}{C['reset']}"))
    out.append(line(f"{C['dim']}{'─'*W}{C['reset']}"))
    out.append(line(f"{C['b']}ACTIVITY{C['reset']}"))
    for ev in (a.get("events") or [])[:14]:
        ts = datetime.fromtimestamp(ev["t"]).strftime("%H:%M:%S")
        ico = ICON.get(ev["kind"], "▸")
        out.append(line(f"{C['dim']}{ts}{C['reset']} {ico} "
                        f"{C['mag']}{ev['kind']:<13}{C['reset']} "
                        f"{C['dim']}{ev['detail']}{C['reset']}"))
    out.append(bot)
    return "\n".join(out)


def main():
    print("\033[?25l", end="")  # hide cursor
    try:
        while True:
            frame = render()
            print("\033[H\033[J" + frame)  # home + clear + draw
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        print("\033[?25h", end="")  # show cursor


if __name__ == "__main__":
    main()
