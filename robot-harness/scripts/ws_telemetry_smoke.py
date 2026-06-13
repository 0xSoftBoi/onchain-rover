#!/usr/bin/env python3
"""Read one robot-harness telemetry WebSocket frame using only stdlib."""

from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import struct
import sys
import urllib.parse


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke-test /ws/telemetry.")
    parser.add_argument("--url", default=os.environ.get("ROVER_TELEMETRY_WS", "ws://127.0.0.1:8000/ws/telemetry"))
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("ROVER_SMOKE_TIMEOUT", "5")))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    parsed = urllib.parse.urlparse(args.url)
    if parsed.scheme != "ws":
        raise RuntimeError("only ws:// telemetry URLs are supported")
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 80
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"

    key = base64.b64encode(os.urandom(16)).decode("ascii")
    with socket.create_connection((host, port), timeout=args.timeout) as sock:
        sock.settimeout(args.timeout)
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        sock.sendall(request.encode("ascii"))
        headers = read_until(sock, b"\r\n\r\n")
        if b" 101 " not in headers.split(b"\r\n", 1)[0]:
            raise RuntimeError(headers.decode("utf-8", errors="replace").strip())
        opcode, payload = read_frame(sock)
        if opcode != 1:
            raise RuntimeError(f"expected text frame, got opcode {opcode}")
        text = payload.decode("utf-8")
        try:
            print(json.dumps(json.loads(text), indent=2, sort_keys=True))
        except json.JSONDecodeError:
            print(text)
        return 0


def read_until(sock: socket.socket, marker: bytes) -> bytes:
    chunks = bytearray()
    while marker not in chunks:
        chunk = sock.recv(1)
        if not chunk:
            raise RuntimeError("socket closed during handshake")
        chunks.extend(chunk)
    return bytes(chunks)


def read_exact(sock: socket.socket, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sock.recv(size - len(chunks))
        if not chunk:
            raise RuntimeError("socket closed during frame")
        chunks.extend(chunk)
    return bytes(chunks)


def read_frame(sock: socket.socket) -> tuple[int, bytes]:
    first, second = read_exact(sock, 2)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", read_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", read_exact(sock, 8))[0]
    mask = read_exact(sock, 4) if masked else b""
    payload = read_exact(sock, length)
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return opcode, payload


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(f"telemetry websocket smoke failed: {error}", file=sys.stderr)
        raise SystemExit(1)
