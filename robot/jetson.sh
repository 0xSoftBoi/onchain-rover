#!/bin/bash
# Jetson profiler + optimizer. Run ON the robot.
#   bash jetson.sh            # PROFILE (read-only): identify module + measure RAM
#   bash jetson.sh optimize   # FREE RAM: MAXN, kill zombie services, headless, swap
#
# The mystery: free shows ~3.6GB. That = a 4GB module (Orin Nano 4GB p3767-0004)
# OR an 8GB NX with the wrong DTB flashed. The `compatible` string is definitive.
set +e

profile() {
  echo "==================== MODULE IDENTITY ===================="
  echo -n "model: "; cat /proc/device-tree/model 2>/dev/null; echo
  echo "compatible:"; cat /proc/device-tree/compatible 2>/dev/null | tr '\0' '\n' | sed 's/^/  /'
  echo "  (p3767-0001=NX 8GB · 0003=Nano 8GB · 0004/0005=Nano 4GB · 0000=NX 16GB)"
  echo -n "L4T: "; head -1 /etc/nv_tegra_release 2>/dev/null
  command -v jetson_release >/dev/null && jetson_release -v 2>/dev/null | grep -iE "module|jetpack|memory"
  echo "==================== MEMORY CEILING ====================="
  free -h
  echo "--- carveout / reserved (dmesg) ---"
  sudo dmesg 2>/dev/null | grep -iE "Memory:.*available|reserved" | tail -3
  echo "==================== TOP RAM CONSUMERS =================="
  ps -eo rss,comm --sort=-rss 2>/dev/null | head -16 | awk 'NR==1{print;next}{printf "%6.0f MB  %s\n",$1/1024,$2}'
  echo "==================== POWER / SWAP ======================="
  echo -n "nvpmodel: "; sudo nvpmodel -q 2>/dev/null | grep -i "mode" | head -1
  swapon --show
  echo "==================== RECLAIMABLE NOW ===================="
  systemctl is-active --quiet gdm3 graphical.target 2>/dev/null && echo "  • desktop GUI is ON  -> ~800MB reclaimable (headless)"
  for s in snapd docker jupyter ugv_jupyter nvargus-daemon; do
    systemctl is-active --quiet "$s" 2>/dev/null && echo "  • $s running -> reclaimable"
  done
  docker ps -q 2>/dev/null | grep -q . && echo "  • docker containers running -> $(docker ps --format '{{.Names}}' | tr '\n' ' ')"
  pgrep -f gradio >/dev/null && echo "  • gradio running -> reclaimable"
}

optimize() {
  echo "MAXN + clocks…"; sudo nvpmodel -m 0 2>/dev/null; sudo jetson_clocks 2>/dev/null
  echo "Killing zombie services (safe to disable on a headless robot)…"
  for s in snapd ugv_jupyter jupyter nvargus-daemon cups ModemManager; do
    sudo systemctl disable --now "$s" 2>/dev/null && echo "  disabled $s"
  done
  # docker only if no container we need; we stopped the ROS container earlier
  sudo systemctl disable --now docker docker.socket 2>/dev/null && echo "  disabled docker"
  echo "Headless on next boot (frees ~800MB)…"
  sudo systemctl set-default multi-user.target 2>/dev/null
  echo "  -> reboot to apply GUI-off, or run: sudo systemctl isolate multi-user.target"
  # NVMe swap for overflow (root is on the 233GB NVMe)
  if ! swapon --show | grep -q rover.swap; then
    echo "Adding 8G NVMe swap…"
    sudo fallocate -l 8G /var/rover.swap && sudo chmod 600 /var/rover.swap \
      && sudo mkswap /var/rover.swap >/dev/null && sudo swapon /var/rover.swap \
      && echo '/var/rover.swap none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null \
      && echo "  swap added"
    sudo sysctl -w vm.swappiness=10 >/dev/null
  fi
  echo "=== after ==="; free -h
}

case "${1:-profile}" in
  optimize) optimize ;;
  *) profile ;;
esac
