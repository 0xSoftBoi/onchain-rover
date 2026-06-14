import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { Readable } from "node:stream";
import type { Express } from "express";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { ROBOTS, type RobotName } from "./config.js";
import * as evidence from "./evidence.js";
import * as raceStore from "./race-store.js";
import * as rounds from "./rounds.js";
import { traceIdForRound } from "./telemetry-trace.js";

export type SpeedMode = "low" | "medium" | "high";

type PilotSession = {
  token: string;
  robot: RobotName;
  expiresAt: number;
  notBeforeMs?: number;
  notAfterMs?: number;
  speedMode: SpeedMode;
  maxSpeedMode: SpeedMode;
  lastCmdAt: number;
  lastPilotSeenAt: number;
};

type DriveCommand = {
  type: "control";
  robot: RobotName;
  token: string;
  ts_ms: number;
  left: number;
  right: number;
  speed_mode: SpeedMode;
  max_speed: number;
  deadman_ms: number;
};

type CameraCommand = {
  type: "camera-control";
  robot: RobotName;
  token: string;
  ts_ms: number;
  pan: number;
  tilt: number;
};

type CameraTelemetry = {
  status: string;
  health?: string;
  fps?: number;
  last_frame_age_ms?: number;
  resolution?: string;
  brightness?: number;
  reconnect_state?: string;
  pan?: number;
  tilt?: number;
};

export type RobotTelemetry = {
  ts_ms: number;
  robot: RobotName;
  battery_v?: number;
  left_cmd: number;
  right_cmd: number;
  odometry_left?: number;
  odometry_right?: number;
  yaw?: number;
  session_id?: string;
  deadman_ok: boolean;
  estop: boolean;
  stopped_by_deadman: boolean;
  soft_odometry_limited?: boolean;
  soft_odometry_limit_m?: number;
  speed_mode: SpeedMode;
  max_speed: number;
  last_raw_frame_ms?: number;
  raw_frame_age_ms?: number;
  source: "bridge" | "robot" | "sim";
  camera?: CameraTelemetry;
  lidar?: { status?: string; front_m?: number; min_m?: number; blocked?: boolean };
  sensors?: {
    battery?: { status?: string; voltage_v?: number };
    odometry?: { status?: string; left?: number; right?: number };
    imu?: { status?: string };
    lidar?: { status?: string; front_m?: number; min_m?: number; blocked?: boolean };
    camera?: Partial<CameraTelemetry>;
    raw_frame?: { status?: string; source?: string; last_ms?: number; age_ms?: number };
  };
};

type WebrtcPilotClient = {
  token: string;
  peer: RTCPeerConnection;
};

type RobotRuntime = {
  robot: RobotName;
  resolvedBaseUrl?: string;
  resolvedBaseUrlAt?: number;
  robotSocket?: WebSocket;
  robotConnectedAt?: number;
  lastRobotSeenAt?: number;
  restDriveInFlight: boolean;
  restAuthorizedTokens: Map<string, string>;
  pendingRestDrive?: DriveCommand;
  lastRestDriveErrorAt: number;
  telemetryClients: Set<WebSocket>;
  pilotClients: Map<WebSocket, string>;
  webrtcPilotClients: Map<RTCDataChannel, WebrtcPilotClient>;
  webrtcPeers: Set<RTCPeerConnection>;
  cameraClients: Map<WebSocket, string>;
  sessions: Map<string, PilotSession>;
  telemetry: RobotTelemetry;
  telemetryHistory: RobotTelemetry[];
  traceEventState: Map<string, boolean>;
  lastCommand: DriveCommand;
  lastCameraCommand: CameraCommand;
  stoppedByDeadman: boolean;
};

const SPEED_CAPS: Record<SpeedMode, number> = {
  low: 0.22,
  medium: 0.35,
  high: 1.0,
};
const SESSION_SECS = 300;
const CMD_MIN_INTERVAL_MS = 20;
const DEADMAN_MS = 650;
const TELEMETRY_STALE_MS = 1600;
const TELEMETRY_HISTORY_MAX = 900;
const ROBOT_URL_CACHE_MS = 2500;
const ROBOT_PROBE_TIMEOUT_MS = 700;

const PREFERRED_ROBOT_URLS: Record<RobotName, string[]> = {
  guard: ["http://172.16.2.151:8000"],
  courier: ["http://192.168.0.192:8000", "http://192.168.55.1:8000"],
};

const runtimes = new Map<RobotName, RobotRuntime>();
let deadmanLoop: NodeJS.Timeout | undefined;

export function installRobotLink(app: Express, server: Server) {
  const driveWss = new WebSocketServer({ noServer: true });
  const cameraWss = new WebSocketServer({ noServer: true });
  const telemetryWss = new WebSocketServer({ noServer: true });
  const robotWss = new WebSocketServer({ noServer: true });

  app.get("/robot-link/state", (_req, res) => {
    res.json({ robots: robotLinkSnapshot() });
  });

  app.post("/pilot/webrtc/offer", async (req, res) => {
    let peer: RTCPeerConnection | undefined;
    let runtime: RobotRuntime | undefined;
    try {
      const robot = requireRobotName(req.body?.robot);
      runtime = runtimeFor(robot);
      const token = String(req.body?.token ?? "");
      const session = requireSession(runtime, token, { allowEarly: true });
      const requestedSpeedMode = parseSpeedMode(req.body?.speed_mode);
      if (requestedSpeedMode) {
        session.speedMode = capSpeedMode(requestedSpeedMode, session.maxSpeedMode);
      }

      const offer = req.body?.offer;
      if (offer?.type !== "offer" || typeof offer.sdp !== "string" || !offer.sdp.trim()) {
        throw new Error("offer must include type=offer and sdp");
      }

      peer = new RTCPeerConnection({ iceServers: [] });
      const activeRuntime = runtime;
      activeRuntime.webrtcPeers.add(peer);
      peer.ondatachannel = ({ channel }) => {
        if (channel.label !== "drive") {
          channel.close();
          return;
        }
        handleWebrtcDriveChannel(activeRuntime, token, peer!, channel);
      };
      peer.onconnectionstatechange = () => {
        if (peer && ["closed", "failed", "disconnected"].includes(peer.connectionState)) {
          cleanupWebrtcPeer(activeRuntime, peer, `webrtc ${peer.connectionState}`);
        }
      };

      await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await waitForIceGatheringComplete(peer, 1500);
      const localDescription = peer.localDescription ?? answer;
      res.json({
        answer: { type: localDescription.type, sdp: localDescription.sdp },
        iceServers: [],
      });
    } catch (e: any) {
      if (peer && runtime) {
        cleanupWebrtcPeer(runtime, peer, "webrtc offer failed");
      } else if (peer) {
        void peer.close().catch(() => undefined);
      }
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/robot/:robot/pilot/speed-mode", (req, res) => {
    try {
      const runtime = runtimeFor(requireRobotName(req.params.robot));
      const token = String(req.body?.token ?? "");
      const requestedSpeedMode = requireSpeedMode(req.body?.speed_mode);
      const session = requireSession(runtime, token);
      const speedMode = capSpeedMode(requestedSpeedMode, session.maxSpeedMode);
      session.speedMode = speedMode;
      runtime.lastCommand = makeCommand(runtime, session, runtime.lastCommand.left, runtime.lastCommand.right);
      sendToRobot(runtime, runtime.lastCommand);
      broadcastTelemetry(runtime, "bridge");
      res.json({
        ok: true,
        robot: runtime.robot,
        speed_mode: speedMode,
        max_speed_mode: session.maxSpeedMode,
        max_speed: SPEED_CAPS[speedMode],
      });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/robot/:robot/stop", (req, res) => {
    try {
      const runtime = runtimeFor(requireRobotName(req.params.robot));
      const token = String(req.body?.token ?? "");
      if (token) requireSession(runtime, token);
      revokePilotSessions(runtime.robot, "operator stop");
      res.json({ ok: true, robot: runtime.robot, stopped: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/robot/:robot/stream", async (req, res) => {
    const controller = new AbortController();
    let proxyStream: Readable | undefined;
    const abort = () => controller.abort();
    const closeProxy = () => proxyStream?.destroy();
    const cleanup = () => {
      req.off("close", abort);
      res.off("close", abort);
      res.off("close", closeProxy);
      res.off("close", cleanup);
      proxyStream?.off("close", cleanup);
    };
    req.on("close", abort);
    res.on("close", abort);
    res.on("close", closeProxy);
    res.on("close", cleanup);
    try {
      const robot = requireRobotName(req.params.robot);
      const upstream = new URL("/stream", await resolveRobotBaseUrl(robot)).toString();
      if (req.query.proxy === "0") return res.redirect(upstream);
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      const upstreamRes = await fetch(upstream, { signal: controller.signal });
      res.status(upstreamRes.status);
      for (const header of ["content-type", "cache-control"] as const) {
        const value = upstreamRes.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      if (!upstreamRes.body) return res.end();
      proxyStream = Readable.fromWeb(upstreamRes.body as any);
      proxyStream.on("close", cleanup);
      proxyStream
        .on("error", () => {
          if (!res.headersSent) res.status(502);
          res.end();
        })
        .pipe(res);
    } catch (e: any) {
      cleanup();
      if (controller.signal.aborted) return;
      if (res.headersSent) return res.end();
      res.status(502).json({ error: e.message });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://sidecar.local");
    if (url.pathname === "/ws/drive") {
      driveWss.handleUpgrade(req, socket, head, (ws) => handlePilotDrive(ws, url));
      return;
    }
    if (url.pathname === "/ws/camera") {
      cameraWss.handleUpgrade(req, socket, head, (ws) => handleCameraControl(ws, url));
      return;
    }
    if (url.pathname === "/ws/telemetry") {
      telemetryWss.handleUpgrade(req, socket, head, (ws) => handleTelemetryClient(ws, url));
      return;
    }
    if (url.pathname === "/ws/robot") {
      robotWss.handleUpgrade(req, socket, head, (ws) => handleRobotSocket(ws, url));
      return;
    }
    socket.destroy();
  });

  startDeadmanLoop();
}

export function authorizePilotSession(
  robot: RobotName,
  publicBaseUrl: string,
  opts: {
    ttlSecs?: number;
    speedMode?: SpeedMode;
    maxSpeedMode?: SpeedMode;
    notBeforeMs?: number;
    notAfterMs?: number;
    streamUrl?: string;
  } = {},
) {
  const runtime = runtimeFor(robot);
  retireExpiredSessions(runtime);
  for (const ws of runtime.pilotClients.keys()) ws.close(1012, "new pilot session");
  for (const ws of runtime.cameraClients.keys()) ws.close(1012, "new pilot session");
  for (const peer of runtime.webrtcPeers) void peer.close().catch(() => undefined);
  runtime.pilotClients.clear();
  runtime.webrtcPilotClients.clear();
  runtime.webrtcPeers.clear();
  runtime.cameraClients.clear();
  runtime.sessions.clear();
  runtime.restAuthorizedTokens.clear();

  const token = randomUUID();
  const ttlSecs = opts.ttlSecs ?? SESSION_SECS;
  const maxSpeedMode = opts.maxSpeedMode ?? opts.speedMode ?? "medium";
  const speedMode = capSpeedMode(opts.speedMode ?? maxSpeedMode, maxSpeedMode);
  runtime.sessions.set(token, {
    token,
    robot,
    expiresAt: Date.now() + ttlSecs * 1000,
    notBeforeMs: opts.notBeforeMs,
    notAfterMs: opts.notAfterMs,
    speedMode,
    maxSpeedMode,
    lastCmdAt: 0,
    lastPilotSeenAt: 0,
  });
  runtime.stoppedByDeadman = false;
  runtime.lastCommand = makeCommand(runtime, runtime.sessions.get(token)!, 0, 0);
  broadcastTelemetry(runtime, "bridge");

  const base = publicBaseUrl.replace(/\/$/, "");
  const query = new URLSearchParams({ robot, token });
  return {
    token,
    robot,
    expiresInSecs: ttlSecs,
    driveWs: `${wsFromHttp(base)}/ws/drive?${query.toString()}`,
    webrtcOfferUrl: `${base}/pilot/webrtc/offer`,
    cameraWs: `${wsFromHttp(base)}/ws/camera?${query.toString()}`,
    telemetryWs: `${wsFromHttp(base)}/ws/telemetry?robot=${encodeURIComponent(robot)}`,
    streamUrl: opts.streamUrl ?? `${base}/robot/${encodeURIComponent(robot)}/stream`,
    speedModeUrl: `${base}/robot/${encodeURIComponent(robot)}/pilot/speed-mode`,
    stopUrl: `${base}/robot/${encodeURIComponent(robot)}/stop`,
    maxSpeedMode,
    bridge: true,
  };
}

export function revokePilotSessions(robot: RobotName, reason = "pilot session revoked") {
  const runtime = runtimeFor(robot);
  for (const ws of runtime.pilotClients.keys()) ws.close(1000, reason);
  for (const peer of runtime.webrtcPeers) void peer.close().catch(() => undefined);
  runtime.pilotClients.clear();
  runtime.webrtcPilotClients.clear();
  runtime.webrtcPeers.clear();
  runtime.sessions.clear();
  runtime.restAuthorizedTokens.clear();
  safeStop(runtime, reason);
}

export function requireRobotName(value: unknown): RobotName {
  if (value === "guard" || value === "courier") return value;
  throw new Error("robot must be guard or courier");
}

export function parseSpeedMode(value: unknown): SpeedMode | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function requireSpeedMode(value: unknown): SpeedMode {
  const mode = parseSpeedMode(value);
  if (!mode) throw new Error("speed_mode must be low, medium, or high");
  return mode;
}

function handlePilotDrive(ws: WebSocket, url: URL) {
  let runtime: RobotRuntime;
  let token: string;
  try {
    runtime = runtimeFor(requireRobotName(url.searchParams.get("robot")));
    token = String(url.searchParams.get("token") ?? "");
    requireSession(runtime, token, { allowEarly: true });
  } catch (e: any) {
    ws.close(1008, e.message);
    return;
  }

  runtime.pilotClients.set(ws, token);
  ws.on("message", (raw) => {
    try {
      const body = parseJson(raw);
      handleDriveCommand(runtime, token, body);
    } catch (e: any) {
      ws.send(JSON.stringify({ type: "error", error: e.message }));
    }
  });
  ws.on("close", () => {
    runtime.pilotClients.delete(ws);
    safeStop(runtime, "pilot disconnected");
  });
  ws.send(JSON.stringify({ type: "ready", robot: runtime.robot, deadman_ms: DEADMAN_MS }));
}

function handleWebrtcDriveChannel(
  runtime: RobotRuntime,
  token: string,
  peer: RTCPeerConnection,
  channel: RTCDataChannel,
) {
  let registered = false;
  let closed = false;

  const register = () => {
    if (registered || closed) return;
    requireSession(runtime, token, { allowEarly: true });
    registered = true;
    runtime.webrtcPilotClients.set(channel, { token, peer });
    runtime.stoppedByDeadman = false;
    broadcastTelemetry(runtime, "bridge");
    channel.send(JSON.stringify({ type: "ready", robot: runtime.robot, deadman_ms: DEADMAN_MS }));
  };

  const close = (reason = "webrtc pilot disconnected") => {
    if (closed) return;
    closed = true;
    const wasRegistered = runtime.webrtcPilotClients.delete(channel);
    cleanupWebrtcPeer(runtime, peer, reason);
    if (wasRegistered) safeStop(runtime, reason);
  };

  channel.onopen = () => {
    try {
      register();
    } catch {
      close("invalid webrtc pilot session");
    }
  };
  channel.onmessage = (event) => {
    try {
      if (!registered) register();
      handleDriveCommand(runtime, token, parseJsonLike(event.data));
    } catch (e: any) {
      if (channel.readyState === "open") {
        channel.send(JSON.stringify({ type: "error", error: e.message }));
      }
    }
  };
  channel.onclose = () => close();
  channel.onerror = () => close("webrtc pilot error");
  if (channel.readyState === "open") channel.onopen();
}

function handleCameraControl(ws: WebSocket, url: URL) {
  let runtime: RobotRuntime;
  let token: string;
  try {
    runtime = runtimeFor(requireRobotName(url.searchParams.get("robot")));
    token = String(url.searchParams.get("token") ?? "");
    requireSession(runtime, token, { allowEarly: true });
  } catch (e: any) {
    ws.close(1008, e.message);
    return;
  }

  runtime.cameraClients.set(ws, token);
  ws.on("message", (raw) => {
    try {
      const body = parseJson(raw);
      const session = requireSession(runtime, token, { allowEarly: true });
      if (body.token && body.token !== token) throw new Error("token mismatch");
      session.lastPilotSeenAt = Date.now();
      runtime.lastCameraCommand = makeCameraCommand(runtime, session, body.pan, body.tilt);
      sendToRobot(runtime, runtime.lastCameraCommand);
      broadcastTelemetry(runtime, "bridge");
    } catch (e: any) {
      ws.send(JSON.stringify({ type: "error", error: e.message }));
    }
  });
  ws.on("close", () => {
    runtime.cameraClients.delete(ws);
    const session = runtime.sessions.get(token);
    runtime.lastCameraCommand = makeCameraCommand(runtime, session, 0, 0);
    sendToRobot(runtime, runtime.lastCameraCommand);
    broadcastTelemetry(runtime, "bridge");
  });
  ws.send(JSON.stringify({ type: "ready", robot: runtime.robot }));
}

function handleTelemetryClient(ws: WebSocket, url: URL) {
  let runtime: RobotRuntime;
  try {
    runtime = runtimeFor(requireRobotName(url.searchParams.get("robot")));
  } catch (e: any) {
    ws.close(1008, e.message);
    return;
  }
  runtime.telemetryClients.add(ws);
  ws.send(JSON.stringify(runtime.telemetry));
  ws.on("close", () => runtime.telemetryClients.delete(ws));
}

function handleRobotSocket(ws: WebSocket, url: URL) {
  let runtime: RobotRuntime;
  try {
    runtime = runtimeFor(requireRobotName(url.searchParams.get("robot")));
  } catch (e: any) {
    ws.close(1008, e.message);
    return;
  }
  runtime.robotSocket?.close(1012, "replaced by newer robot link");
  runtime.robotSocket = ws;
  runtime.robotConnectedAt = Date.now();
  runtime.lastRobotSeenAt = Date.now();
  recordRobotTraceEvent(runtime, "robot-connected");
  broadcastTelemetry(runtime, "bridge");

  ws.on("message", (raw) => {
    try {
      const body = parseJson(raw);
      runtime.lastRobotSeenAt = Date.now();
      runtime.telemetry = normalizeTelemetry(runtime, body);
      broadcastTelemetry(runtime);
    } catch {
      // Ignore malformed robot frames. The deadman loop still owns safety.
    }
  });
  ws.on("close", () => {
    if (runtime.robotSocket === ws) runtime.robotSocket = undefined;
    recordRobotTraceEvent(runtime, "robot-disconnected");
    safeStop(runtime, "robot disconnected", false);
    broadcastTelemetry(runtime, "bridge");
  });
  ws.send(JSON.stringify({ type: "hello", robot: runtime.robot, deadman_ms: DEADMAN_MS }));
}

function runtimeFor(robot: RobotName): RobotRuntime {
  const existing = runtimes.get(robot);
  if (existing) return existing;
  const runtime: RobotRuntime = {
    robot,
    restDriveInFlight: false,
    restAuthorizedTokens: new Map(),
    lastRestDriveErrorAt: 0,
    telemetryClients: new Set(),
    pilotClients: new Map(),
    webrtcPilotClients: new Map(),
    webrtcPeers: new Set(),
    cameraClients: new Map(),
    sessions: new Map(),
    stoppedByDeadman: false,
    lastCommand: {
      type: "control",
      robot,
      token: "",
      ts_ms: Date.now(),
      left: 0,
      right: 0,
      speed_mode: "medium",
      max_speed: SPEED_CAPS.medium,
      deadman_ms: DEADMAN_MS,
    },
    lastCameraCommand: {
      type: "camera-control",
      robot,
      token: "",
      ts_ms: Date.now(),
      pan: 0,
      tilt: 0,
    },
    telemetry: {
      ts_ms: Date.now(),
      robot,
      left_cmd: 0,
      right_cmd: 0,
      deadman_ok: false,
      estop: false,
      stopped_by_deadman: false,
      speed_mode: "medium",
      max_speed: SPEED_CAPS.medium,
      source: "bridge",
      camera: { status: "unavailable" },
      lidar: { status: "unavailable" },
    },
    telemetryHistory: [],
    traceEventState: new Map(),
  };
  recordTelemetry(runtime, runtime.telemetry);
  runtimes.set(robot, runtime);
  return runtime;
}

function candidateRobotUrls(robot: RobotName): string[] {
  return uniqueStrings([
    ...(PREFERRED_ROBOT_URLS[robot] ?? []),
    ROBOTS[robot].url,
  ].filter(Boolean).map((url) => url.replace(/\/$/, "")));
}

async function resolveRobotBaseUrl(robot: RobotName): Promise<string> {
  const runtime = runtimeFor(robot);
  if (runtime.resolvedBaseUrl && runtime.resolvedBaseUrlAt && Date.now() - runtime.resolvedBaseUrlAt < ROBOT_URL_CACHE_MS) {
    return runtime.resolvedBaseUrl;
  }

  const candidates = runtime.resolvedBaseUrl
    ? uniqueStrings([runtime.resolvedBaseUrl, ...candidateRobotUrls(robot)])
    : candidateRobotUrls(robot);
  const failures: string[] = [];
  for (const baseUrl of candidates) {
    try {
      const res = await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(ROBOT_PROBE_TIMEOUT_MS) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false || body?.role !== robot) {
        failures.push(`${baseUrl} role=${body?.role ?? "unknown"} status=${res.status}`);
        continue;
      }
      runtime.resolvedBaseUrl = baseUrl;
      runtime.resolvedBaseUrlAt = Date.now();
      return baseUrl;
    } catch (e: any) {
      failures.push(`${baseUrl} ${e?.name === "TimeoutError" ? "timeout" : e?.message ?? e}`);
    }
  }
  runtime.resolvedBaseUrl = undefined;
  runtime.resolvedBaseUrlAt = undefined;
  throw new Error(`no reachable ${robot} robot URL (${failures.join("; ")})`);
}

function clearResolvedRobotBaseUrl(runtime: RobotRuntime) {
  runtime.resolvedBaseUrl = undefined;
  runtime.resolvedBaseUrlAt = undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function requireSession(
  runtime: RobotRuntime,
  token: string,
  opts: { allowEarly?: boolean } = {},
): PilotSession {
  retireExpiredSessions(runtime);
  const session = runtime.sessions.get(token);
  if (!session) throw new Error("pilot session unavailable");
  if (Date.now() > session.expiresAt) {
    runtime.sessions.delete(token);
    throw new Error("pilot session expired");
  }
  if (!opts.allowEarly && session.notBeforeMs && Date.now() < session.notBeforeMs) {
    throw new Error("round has not started");
  }
  if (session.notAfterMs && Date.now() > session.notAfterMs) {
    throw new Error("round has ended");
  }
  return session;
}

function handleDriveCommand(runtime: RobotRuntime, token: string, body: Record<string, any>) {
  const session = requireSession(runtime, token);
  if (body.token && body.token !== token) throw new Error("token mismatch");
  const now = Date.now();
  if (now - session.lastCmdAt < CMD_MIN_INTERVAL_MS) return;
  session.lastCmdAt = now;
  session.lastPilotSeenAt = now;
  const speedMode = parseSpeedMode(body.speed_mode);
  if (speedMode) session.speedMode = capSpeedMode(speedMode, session.maxSpeedMode);
  const left = Number.isFinite(Number(body.left)) ? Number(body.left) : 0;
  const right = Number.isFinite(Number(body.right)) ? Number(body.right) : 0;
  runtime.stoppedByDeadman = false;
  runtime.lastCommand = makeCommand(runtime, session, left, right);
  sendToRobot(runtime, runtime.lastCommand);
  broadcastTelemetry(runtime, "bridge");
}

function cleanupWebrtcPeer(runtime: RobotRuntime, peer: RTCPeerConnection, reason: string) {
  runtime.webrtcPeers.delete(peer);
  let removedPilot = false;
  for (const [channel, client] of runtime.webrtcPilotClients) {
    if (client.peer !== peer) continue;
    runtime.webrtcPilotClients.delete(channel);
    removedPilot = true;
  }
  void peer.close().catch(() => undefined);
  if (removedPilot) safeStop(runtime, reason);
}

async function waitForIceGatheringComplete(peer: RTCPeerConnection, timeoutMs: number) {
  if (peer.iceGatheringState === "complete") return;
  await peer.iceGatheringStateChange
    .watch((state) => state === "complete", timeoutMs)
    .catch(() => undefined);
}

function pilotClientCount(runtime: RobotRuntime): number {
  return runtime.pilotClients.size + runtime.webrtcPilotClients.size;
}

function retireExpiredSessions(runtime: RobotRuntime) {
  const now = Date.now();
  for (const [token, session] of runtime.sessions) {
    if (session.expiresAt <= now) runtime.sessions.delete(token);
  }
}

function makeCommand(runtime: RobotRuntime, session: PilotSession, left: number, right: number): DriveCommand {
  const max = SPEED_CAPS[session.speedMode];
  return {
    type: "control",
    robot: runtime.robot,
    token: session.token,
    ts_ms: Date.now(),
    left: clamp(left, -1, 1) * max,
    right: clamp(right, -1, 1) * max,
    speed_mode: session.speedMode,
    max_speed: max,
    deadman_ms: DEADMAN_MS,
  };
}

function makeCameraCommand(
  runtime: RobotRuntime,
  session: PilotSession | undefined,
  pan: unknown,
  tilt: unknown,
): CameraCommand {
  return {
    type: "camera-control",
    robot: runtime.robot,
    token: session?.token ?? "",
    ts_ms: Date.now(),
    pan: clamp(Number.isFinite(Number(pan)) ? Number(pan) : 0, -1, 1),
    tilt: clamp(Number.isFinite(Number(tilt)) ? Number(tilt) : 0, -1, 1),
  };
}

function capSpeedMode(mode: SpeedMode, maxMode: SpeedMode): SpeedMode {
  const rank: Record<SpeedMode, number> = { low: 0, medium: 1, high: 2 };
  return rank[mode] > rank[maxMode] ? maxMode : mode;
}

function normalizeTelemetry(runtime: RobotRuntime, body: Record<string, any>): RobotTelemetry {
  const current = runtime.telemetry;
  const command = runtime.lastCommand;
  const speedMode = parseSpeedMode(body.speed_mode) ?? command.speed_mode;
  const maxSpeed = Number.isFinite(Number(body.max_speed)) ? Number(body.max_speed) : SPEED_CAPS[speedMode];
  return {
    ts_ms: Number.isFinite(Number(body.ts_ms)) ? Number(body.ts_ms) : Date.now(),
    robot: runtime.robot,
    battery_v: finiteNumber(body.battery_v) ?? current.battery_v,
    left_cmd: finiteNumber(body.left_cmd) ?? command.left,
    right_cmd: finiteNumber(body.right_cmd) ?? command.right,
    odometry_left: finiteNumber(body.odometry_left) ?? current.odometry_left,
    odometry_right: finiteNumber(body.odometry_right) ?? current.odometry_right,
    yaw: finiteNumber(body.yaw) ?? current.yaw,
    session_id: typeof body.session_id === "string" ? body.session_id : command.token || current.session_id,
    deadman_ok: Boolean(body.deadman_ok ?? pilotClientCount(runtime) > 0),
    estop: Boolean(body.estop ?? false),
    stopped_by_deadman: Boolean(body.stopped_by_deadman ?? runtime.stoppedByDeadman),
    soft_odometry_limited: Boolean(body.soft_odometry_limited ?? current.soft_odometry_limited ?? false),
    soft_odometry_limit_m: finiteNumber(body.soft_odometry_limit_m) ?? current.soft_odometry_limit_m,
    speed_mode: speedMode,
    max_speed: maxSpeed,
    last_raw_frame_ms: finiteNumber(body.last_raw_frame_ms) ?? current.last_raw_frame_ms,
    raw_frame_age_ms: finiteNumber(body.raw_frame_age_ms) ?? current.raw_frame_age_ms,
    source: body.source === "sim" ? "sim" : "robot",
    camera: normalizeCamera(body.camera) ?? normalizeCamera(body.sensors?.camera) ?? current.camera,
    lidar: normalizeLidar(body.lidar) ?? current.lidar,
    sensors: normalizeSensors(body.sensors) ?? current.sensors,
  };
}

function broadcastTelemetry(runtime: RobotRuntime, source?: RobotTelemetry["source"]) {
  const now = Date.now();
  runtime.telemetry = {
    ...runtime.telemetry,
    ts_ms: now,
    robot: runtime.robot,
    left_cmd: runtime.lastCommand.left,
    right_cmd: runtime.lastCommand.right,
    deadman_ok: pilotClientCount(runtime) > 0 && !runtime.stoppedByDeadman,
    stopped_by_deadman: runtime.stoppedByDeadman,
    soft_odometry_limited: runtime.telemetry.soft_odometry_limited,
    soft_odometry_limit_m: runtime.telemetry.soft_odometry_limit_m,
    speed_mode: runtime.lastCommand.speed_mode,
    max_speed: runtime.lastCommand.max_speed,
    session_id: runtime.lastCommand.token || runtime.telemetry.session_id,
    camera: runtime.telemetry.camera
      ? {
          ...runtime.telemetry.camera,
          pan: runtime.lastCameraCommand.pan,
          tilt: runtime.lastCameraCommand.tilt,
        }
      : runtime.telemetry.camera,
    source: source ?? runtime.telemetry.source,
  };
  recordTelemetry(runtime, runtime.telemetry);
  const frame = JSON.stringify(runtime.telemetry);
  for (const client of runtime.telemetryClients) {
    if (client.readyState === WebSocket.OPEN) client.send(frame);
  }
}

export function telemetryWindow(robot: RobotName, fromMs: number, toMs: number): RobotTelemetry[] {
  return runtimeFor(robot).telemetryHistory
    .filter((frame) => frame.ts_ms >= fromMs && frame.ts_ms <= toMs)
    .map((frame) => structuredClone(frame));
}

export function latestTelemetry(robot: RobotName): RobotTelemetry | null {
  const latest = runtimeFor(robot).telemetryHistory.at(-1);
  return latest ? structuredClone(latest) : null;
}

export function robotLinkState() {
  return robotLinkSnapshot();
}

function recordTelemetry(runtime: RobotRuntime, frame: RobotTelemetry) {
  const last = runtime.telemetryHistory.at(-1);
  if (last && last.ts_ms === frame.ts_ms && last.source === frame.source) return;
  runtime.telemetryHistory.push(structuredClone(frame));
  if (runtime.telemetryHistory.length > TELEMETRY_HISTORY_MAX) {
    runtime.telemetryHistory.splice(0, runtime.telemetryHistory.length - TELEMETRY_HISTORY_MAX);
  }
  recordRoundTelemetry(runtime, frame);
}

function sendToRobot(runtime: RobotRuntime, command: DriveCommand | CameraCommand) {
  if (runtime.robotSocket?.readyState === WebSocket.OPEN) {
    runtime.robotSocket.send(JSON.stringify(command));
    return;
  }
  if (command.type === "control") {
    queueRestDrive(runtime, command);
  }
}

function queueRestDrive(runtime: RobotRuntime, command: DriveCommand) {
  runtime.pendingRestDrive = command;
  if (runtime.restDriveInFlight) return;
  runtime.restDriveInFlight = true;
  void flushRestDrive(runtime);
}

async function flushRestDrive(runtime: RobotRuntime) {
  while (runtime.pendingRestDrive) {
    const command = runtime.pendingRestDrive;
    runtime.pendingRestDrive = undefined;
    try {
      const baseUrl = await resolveRobotBaseUrl(runtime.robot);
      await ensureRestPilotToken(runtime, command, baseUrl);
      const res = await fetch(new URL("/drive", baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: command.token, left: command.left, right: command.right }),
        signal: AbortSignal.timeout(1500),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) throw new Error(body.error || `robot drive failed ${res.status}`);
    } catch (err) {
      clearResolvedRobotBaseUrl(runtime);
      const now = Date.now();
      if (now - runtime.lastRestDriveErrorAt > 1000) {
        runtime.lastRestDriveErrorAt = now;
        console.error(`robot ${runtime.robot} rest drive: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  runtime.restDriveInFlight = false;
  if (runtime.pendingRestDrive) {
    queueRestDrive(runtime, runtime.pendingRestDrive);
  }
}

async function ensureRestPilotToken(runtime: RobotRuntime, command: DriveCommand, baseUrl: string) {
  if (!command.token) return;
  const cacheKey = `${baseUrl} ${command.speed_mode}`;
  if (runtime.restAuthorizedTokens.get(command.token) === cacheKey) return;
  const res = await fetch(new URL("/pilot/authorize", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: command.token,
      ttl_secs: SESSION_SECS,
      speed_mode: command.speed_mode,
    }),
    signal: AbortSignal.timeout(1500),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || `robot pilot authorize failed ${res.status}`);
  runtime.restAuthorizedTokens.set(command.token, cacheKey);
}

function safeStop(runtime: RobotRuntime, _reason: string, sendRobot = true) {
  runtime.stoppedByDeadman = true;
  runtime.pendingRestDrive = undefined;
  recordRobotTraceEvent(runtime, "safe-stop", { reason: _reason });
  runtime.lastCommand = {
    ...runtime.lastCommand,
    ts_ms: Date.now(),
    left: 0,
    right: 0,
  };
  if (sendRobot) sendToRobot(runtime, runtime.lastCommand);
  broadcastTelemetry(runtime, "bridge");
}

function recordRoundTelemetry(runtime: RobotRuntime, frame: RobotTelemetry) {
  for (const target of activeTraceTargets(runtime.robot)) {
    raceStore.appendTelemetryTrace({
      schema: "onchain-rover.telemetry-trace-event.v1",
      traceId: traceIdForRound(target.round),
      roundId: target.round.id,
      atMs: frame.ts_ms,
      type: "frame",
      slot: target.slot,
      robot: runtime.robot,
      frame: compactTelemetryFrame(frame),
    });
    recordSensorTraceEvents(runtime, target, frame);
    maybeFinishRoundFromTelemetry(runtime, target, frame);
  }
}

function recordRobotTraceEvent(runtime: RobotRuntime, event: string, detail?: Record<string, unknown>) {
  const atMs = Date.now();
  for (const target of activeTraceTargets(runtime.robot)) {
    raceStore.appendTelemetryTrace({
      schema: "onchain-rover.telemetry-trace-event.v1",
      traceId: traceIdForRound(target.round),
      roundId: target.round.id,
      atMs,
      type: "event",
      slot: target.slot,
      robot: runtime.robot,
      event,
      detail,
    });
  }
}

function recordSensorTraceEvents(
  runtime: RobotRuntime,
  target: { round: rounds.Round; slot: rounds.DriverSlot },
  frame: RobotTelemetry,
) {
  const lidar = frame.lidar ?? frame.sensors?.lidar;
  const distance = lidar?.front_m ?? lidar?.min_m;
  const obstacleThresholdM = target.round.stageCalibration.safetyDefaults.obstacleStopDistanceFt / 3.28084;
  emitTraceTransition(runtime, target, "obstacle-detected", Boolean(
    lidar?.blocked || (distance !== undefined && distance <= obstacleThresholdM),
  ), {
    distanceM: distance ?? null,
    blocked: lidar?.blocked ?? false,
    thresholdM: Number(obstacleThresholdM.toFixed(3)),
  }, frame.ts_ms);

  emitTraceTransition(runtime, target, "boundary-warning", frame.soft_odometry_limited === true, {
    softOdometryLimitM: frame.soft_odometry_limit_m ?? null,
    odometryM: averageOdometry(frame),
  }, frame.ts_ms);

  const camera = frame.camera ?? frame.sensors?.camera;
  const cameraAgeMs = camera?.last_frame_age_ms ?? frame.raw_frame_age_ms ?? frame.sensors?.raw_frame?.age_ms;
  const cameraStatus = camera?.status;
  const cameraHealth = camera?.health;
  emitTraceTransition(runtime, target, "camera-stale", Boolean(
    cameraHealth === "stale"
      || cameraHealth === "missing"
      || cameraStatus === "unavailable"
      || cameraStatus === "missing"
      || cameraStatus === "error"
      || (cameraAgeMs !== undefined && cameraAgeMs > 1500)
  ), {
    status: cameraStatus ?? null,
    health: cameraHealth ?? null,
    ageMs: cameraAgeMs ?? null,
  }, frame.ts_ms);

  emitTraceTransition(runtime, target, "lidar-stale", Boolean(
    lidar?.status === "stale"
      || lidar?.status === "unavailable"
      || lidar?.status === "missing"
      || lidar?.status === "error"
  ), {
    status: lidar?.status ?? null,
    frontM: lidar?.front_m ?? null,
    minM: lidar?.min_m ?? null,
  }, frame.ts_ms);

  emitTraceTransition(runtime, target, "emergency-stop", frame.estop === true, {
    left: frame.left_cmd,
    right: frame.right_cmd,
    speedMode: frame.speed_mode,
  }, frame.ts_ms);

  emitTraceTransition(runtime, target, "deadman-stop", frame.stopped_by_deadman === true, {
    deadmanOk: frame.deadman_ok,
    left: frame.left_cmd,
    right: frame.right_cmd,
    speedMode: frame.speed_mode,
  }, frame.ts_ms);
}

function emitTraceTransition(
  runtime: RobotRuntime,
  target: { round: rounds.Round; slot: rounds.DriverSlot },
  event: string,
  active: boolean,
  detail: Record<string, unknown>,
  atMs: number,
) {
  const key = `${target.round.id}:${target.slot}:${event}`;
  const wasActive = runtime.traceEventState.get(key) === true;
  if (!active) {
    if (wasActive) runtime.traceEventState.delete(key);
    return;
  }
  if (wasActive) return;
  runtime.traceEventState.set(key, true);
  raceStore.appendTelemetryTrace({
    schema: "onchain-rover.telemetry-trace-event.v1",
    traceId: traceIdForRound(target.round),
    roundId: target.round.id,
    atMs,
    type: "event",
    slot: target.slot,
    robot: runtime.robot,
    event,
    detail,
  });
}

function averageOdometry(frame: RobotTelemetry): number | null {
  if (frame.odometry_left === undefined && frame.odometry_right === undefined) return null;
  if (frame.odometry_left === undefined) return frame.odometry_right ?? null;
  if (frame.odometry_right === undefined) return frame.odometry_left;
  return Number(((frame.odometry_left + frame.odometry_right) / 2).toFixed(4));
}

function maybeFinishRoundFromTelemetry(
  runtime: RobotRuntime,
  target: { round: rounds.Round; slot: rounds.DriverSlot },
  frame: RobotTelemetry,
) {
  if (target.round.status !== "racing" || !target.round.startedAt) return;
  const currentDistance = averageOdometry(frame);
  if (currentDistance === null) return;
  const baseline = raceStartOdometry(runtime, target.round.startedAt);
  if (baseline === null) return;
  const deltaM = Math.abs(currentDistance - baseline);
  const thresholdM = showFinishThresholdM(target.round);
  if (deltaM < thresholdM) return;

  try {
    const latest = rounds.getRound(target.round.id);
    if (latest.status !== "racing") return;
    let round = rounds.finishRound(target.round.id, target.slot, {
      source: "sidecar",
      method: "telemetry-odometry-finish",
      winner: target.slot,
      telemetryTraceId: traceIdForRound(latest),
      robot: runtime.robot,
      odometryM: Number(deltaM.toFixed(3)),
      thresholdM: Number(thresholdM.toFixed(3)),
      frame: compactTelemetryFrame(frame),
    });
    evidence.recordRoundSnapshot(round, "finished");
    const finalized = evidence.finalizeResultProof(round, round.proof);
    round = rounds.markEvidenceHashes(target.round.id, finalized.proofHash, finalized.evidenceHash);
    recordRobotTraceEvent(runtime, "race-finished-by-sidecar", {
      roundId: round.id,
      winner: target.slot,
      odometryM: Number(deltaM.toFixed(3)),
      thresholdM: Number(thresholdM.toFixed(3)),
      proofHash: round.proofHash ?? null,
    });
    for (const robot of ["guard", "courier"] as const) {
      revokePilotSessions(robot, "race finished");
    }
  } catch (e: any) {
    console.error(`[show-race] finish ${target.round.id}: ${e.message}`);
  }
}

function raceStartOdometry(runtime: RobotRuntime, startedAt: number): number | null {
  const baseline = runtime.telemetryHistory.find((item) => item.ts_ms >= startedAt - 500 && averageOdometry(item) !== null);
  return baseline ? averageOdometry(baseline) : null;
}

function showFinishThresholdM(round: rounds.Round): number {
  const override = finiteNumber(process.env.SHOW_FINISH_ODOMETRY_M);
  if (override !== undefined && override > 0) return override;
  const distanceFt = Math.max(1, round.stageCalibration.finishLineFt - round.stageCalibration.startLineFt);
  return distanceFt / 3.28084;
}

function activeTraceTargets(robot: RobotName): Array<{ round: rounds.Round; slot: rounds.DriverSlot }> {
  return rounds.listRounds()
    .filter((round) => ["locked", "countdown", "racing"].includes(round.status))
    .flatMap((round) => (["challenger", "opponent"] as const)
      .filter((slot) => round.drivers[slot]?.robot === robot)
      .map((slot) => ({ round, slot })));
}

function compactTelemetryFrame(frame: RobotTelemetry): Record<string, unknown> {
  return {
    ts_ms: frame.ts_ms,
    robot: frame.robot,
    battery_v: frame.battery_v,
    left_cmd: frame.left_cmd,
    right_cmd: frame.right_cmd,
    odometry_left: frame.odometry_left,
    odometry_right: frame.odometry_right,
    yaw: frame.yaw,
    session_id: frame.session_id,
    deadman_ok: frame.deadman_ok,
    estop: frame.estop,
    stopped_by_deadman: frame.stopped_by_deadman,
    speed_mode: frame.speed_mode,
    max_speed: frame.max_speed,
    source: frame.source,
    camera: frame.camera,
    lidar: frame.lidar,
  };
}

function startDeadmanLoop() {
  if (deadmanLoop) return;
  deadmanLoop = setInterval(() => {
    const now = Date.now();
    for (const runtime of runtimes.values()) {
      retireExpiredSessions(runtime);
      const hasMotion = Math.abs(runtime.lastCommand.left) > 0.001 || Math.abs(runtime.lastCommand.right) > 0.001;
      if (hasMotion && now - runtime.lastCommand.ts_ms > DEADMAN_MS) {
        safeStop(runtime, "deadman timeout");
      }
      if (now - runtime.telemetry.ts_ms > TELEMETRY_STALE_MS) {
        broadcastTelemetry(runtime, runtime.robotSocket ? "robot" : "bridge");
      }
    }
  }, 200);
}

function robotLinkSnapshot() {
  const out: Record<string, unknown> = {};
  for (const [robot, runtime] of runtimes) {
    out[robot] = {
      robotConnected: runtime.robotSocket?.readyState === WebSocket.OPEN,
      robotAgeMs: runtime.lastRobotSeenAt ? Date.now() - runtime.lastRobotSeenAt : null,
      pilotClients: runtime.pilotClients.size,
      webrtcPilotClients: runtime.webrtcPilotClients.size,
      cameraClients: runtime.cameraClients.size,
      telemetryClients: runtime.telemetryClients.size,
      sessions: runtime.sessions.size,
      lastCommand: {
        left: runtime.lastCommand.left,
        right: runtime.lastCommand.right,
        speed_mode: runtime.lastCommand.speed_mode,
      },
      lastCameraCommand: {
        pan: runtime.lastCameraCommand.pan,
        tilt: runtime.lastCameraCommand.tilt,
      },
      telemetry: runtime.telemetry,
      resolvedBaseUrl: runtime.resolvedBaseUrl ?? null,
      candidateUrls: candidateRobotUrls(robot),
    };
  }
  return out;
}

function parseJson(raw: RawData): Record<string, any> {
  const data = Array.isArray(raw) ? Buffer.concat(raw) : raw;
  return JSON.parse(data.toString());
}

function parseJsonLike(raw: string | Buffer): Record<string, any> {
  return JSON.parse(typeof raw === "string" ? raw : raw.toString());
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeCamera(value: unknown): CameraTelemetry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const camera = value as Record<string, unknown>;
  const status = stringField(camera.status);
  if (!status) return undefined;
  return {
    status,
    health: stringField(camera.health),
    fps: finiteNumber(camera.fps),
    last_frame_age_ms: finiteNumber(camera.last_frame_age_ms) ?? finiteNumber(camera.age_ms),
    resolution: stringField(camera.resolution),
    brightness: finiteNumber(camera.brightness),
    reconnect_state: stringField(camera.reconnect_state),
    pan: finiteNumber(camera.pan),
    tilt: finiteNumber(camera.tilt),
  };
}

function normalizeLidar(value: unknown): RobotTelemetry["lidar"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const lidar = value as Record<string, unknown>;
  return {
    status: typeof lidar.status === "string" ? lidar.status : undefined,
    front_m: finiteNumber(lidar.front_m),
    min_m: finiteNumber(lidar.min_m),
    blocked: typeof lidar.blocked === "boolean" ? lidar.blocked : undefined,
  };
}

function normalizeSensors(value: unknown): RobotTelemetry["sensors"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sensors = value as Record<string, unknown>;
  const battery = normalizeRecord(sensors.battery);
  const odometry = normalizeRecord(sensors.odometry);
  const rawFrame = normalizeRecord(sensors.raw_frame);
  return {
    battery: battery
      ? {
          status: stringField(battery.status),
          voltage_v: finiteNumber(battery.voltage_v),
        }
      : undefined,
    odometry: odometry
      ? {
          status: stringField(odometry.status),
          left: finiteNumber(odometry.left),
          right: finiteNumber(odometry.right),
        }
      : undefined,
    imu: normalizeStatusOnly(sensors.imu),
    lidar: normalizeLidar(sensors.lidar),
    camera: normalizeCamera(sensors.camera),
    raw_frame: rawFrame
      ? {
          status: stringField(rawFrame.status),
          source: stringField(rawFrame.source),
          last_ms: finiteNumber(rawFrame.last_ms),
          age_ms: finiteNumber(rawFrame.age_ms),
        }
      : undefined,
  };
}

function normalizeStatusOnly(value: unknown): { status?: string } | undefined {
  const record = normalizeRecord(value);
  return record ? { status: stringField(record.status) } : undefined;
}

function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function wsFromHttp(url: string) {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}
