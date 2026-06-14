#!/usr/bin/env python3
"""Test-time GibberLink relay — the two rovers are on split networks (guard on
ETHGlobal/172.16.x, courier on TP-Link/USB) and can't POST to each other's
/gibber/inbox directly. The laptop reaches both, so it cross-forwards.

  guard  PEER_ROBOT_URL = http://<laptop-on-ethglobal>:4099/to-courier
  courier PEER_ROBOT_URL = http://<laptop-on-usb>:4099/to-guard

send() posts to "{PEER_URL}/gibber/inbox", so the relay receives
"/to-courier/gibber/inbox" and forwards to courier's "/gibber/inbox".
NOT needed once both rovers share one Wi-Fi — then PEER_URL = peer IP directly.
"""
import http.server, urllib.request

GUARD = "http://172.16.2.151:8000"
COURIER = "http://192.168.55.1:8000"
ROUTES = {"/to-courier": COURIER, "/to-guard": GUARD}


class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        target = next((t + self.path[len(p):] for p, t in ROUTES.items()
                       if self.path.startswith(p)), None)
        if not target:
            self.send_response(404); self.end_headers(); return
        try:
            req = urllib.request.Request(
                target, data=body,
                headers={"Content-Type": "application/json"}, method="POST")
            r = urllib.request.urlopen(req, timeout=5)
            data = r.read()
            print(f"  relay {self.path} -> {target} [{r.status}]", flush=True)
            self.send_response(r.status); self.end_headers(); self.wfile.write(data)
        except Exception as e:
            print(f"  relay FAIL {self.path} -> {target}: {e}", flush=True)
            self.send_response(502); self.end_headers(); self.wfile.write(str(e).encode())

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print("gibber relay on :4099  (/to-courier -> courier, /to-guard -> guard)", flush=True)
    http.server.HTTPServer(("0.0.0.0", 4099), H).serve_forever()
