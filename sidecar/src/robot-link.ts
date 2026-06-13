import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { Express } from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { ROBOTS, type RobotName } from "./config.js";

export type SpeedMode = "low" | "medium" | "high";

type PilotSession = {
  token: string;
  robot: RobotName;
  expiresAt: number;
  notBeforeMs?: number;
  speedMode: SpeedMode;
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
  speed_mode: SpeedMode;
  max_speed: number;
  last_raw_frame_ms?: number;
  source: "bridge" | "robot" | "sim";
  camera?: { status: string };
  lidar?: { front_m?: number; min_m?: number; blocked?: boolean };
};

type RobotRuntime = {
  robot: RobotName;
  robotSocket?: WebSocket;
  robotConnectedAt?: number;
  lastRobotSeenAt?: number;
  telemetryClients: Set<WebSocket>;
  pilotClients: Map<WebSocket, string>;
  sessions: Map<string, PilotSession>;
  telemetry: RobotTelemetry;
  telemetryHistory: RobotTelemetry[];
  lastCommand: DriveCommand;
  stoppedByDeadman: boolean;
};

const SPEED_CAPS: Record<SpeedMode, number> = {
  low: 0.22,
  medium: 0.35,
  high: 0.55,
};
const SESSION_SECS = 300;
const CMD_MIN_INTERVAL_MS = 70;
const DEADMAN_MS = 650;
const TELEMETRY_STALE_MS = 1600;
const TELEMETRY_HISTORY_MAX = 900;

const runtimes = new Map<RobotName, RobotRuntime>();
let deadmanLoop: NodeJS.Timeout | undefined;

export function installRobotLink(app: Express, server: Server) {
  const driveWss = new WebSocketServer({ noServer: true });
  const telemetryWss = new WebSocketServer({ noServer: true });
  const robotWss = new WebSocketServer({ noServer: true });

  app.get("/robot-link/state", (_req, res) => {
    res.json({ robots: robotLinkSnapshot() });
  });

  app.post("/robot/:robot/pilot/speed-mode", (req, res) => {
    try {
      const runtime = runtimeFor(requireRobotName(req.params.robot));
      const token = String(req.body?.token ?? "");
      const speedMode = requireSpeedMode(req.body?.speed_mode);
      const session = requireSession(runtime, token);
      session.speedMode = speedMode;
      runtime.lastCommand = makeCommand(runtime, session, runtime.lastCommand.left, runtime.lastCommand.right);
      sendToRobot(runtime, runtime.lastCommand);
      broadcastTelemetry(runtime, "bridge");
      res.json({ ok: true, robot: runtime.robot, speed_mode: speedMode, max_speed: SPEED_CAPS[speedMode] });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/robot/:robot/stop", (req, res) => {
    try {
      const runtime = runtimeFor(requireRobotName(req.params.robot));
      const token = String(req.body?.token ?? "");
      if (token) requireSession(runtime, token);
      safeStop(runtime, "operator stop");
      res.json({ ok: true, robot: runtime.robot, stopped: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/robot/:robot/stream", (req, res) => {
    try {
      const robot = requireRobotName(req.params.robot);
      const upstream = new URL("/stream", ROBOTS[robot].url).toString();
      if (req.query.proxy === "0") return res.redirect(upstream);
      res.type("image/svg+xml").send(cameraPlaceholder(robot));
    } catch (e: any) {
      res.status(404).json({ error: e.message });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://sidecar.local");
    if (url.pathname === "/ws/drive") {
      driveWss.handleUpgrade(req, socket, head, (ws) => handlePilotDrive(ws, url));
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
  opts: { ttlSecs?: number; speedMode?: SpeedMode; notBeforeMs?: number } = {},
) {
  const runtime = runtimeFor(robot);
  retireExpiredSessions(runtime);
  for (const ws of runtime.pilotClients.keys()) ws.close(1012, "new pilot session");
  runtime.pilotClients.clear();
  runtime.sessions.clear();

  const token = randomUUID();
  const ttlSecs = opts.ttlSecs ?? SESSION_SECS;
  const speedMode = opts.speedMode ?? "medium";
  runtime.sessions.set(token, {
    token,
    robot,
    expiresAt: Date.now() + ttlSecs * 1000,
    notBeforeMs: opts.notBeforeMs,
    speedMode,
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
    telemetryWs: `${wsFromHttp(base)}/ws/telemetry?robot=${encodeURIComponent(robot)}`,
    streamUrl: `${base}/robot/${encodeURIComponent(robot)}/stream`,
    speedModeUrl: `${base}/robot/${encodeURIComponent(robot)}/pilot/speed-mode`,
    stopUrl: `${base}/robot/${encodeURIComponent(robot)}/stop`,
    bridge: true,
  };
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
    requireSession(runtime, token);
  } catch (e: any) {
    ws.close(1008, e.message);
    return;
  }

  runtime.pilotClients.set(ws, token);
  ws.on("message", (raw) => {
    try {
      const body = parseJson(raw);
      const session = requireSession(runtime, token);
      if (body.token && body.token !== token) throw new Error("token mismatch");
      if (Date.now() - session.lastCmdAt < CMD_MIN_INTERVAL_MS) return;
      session.lastCmdAt = Date.now();
      session.lastPilotSeenAt = Date.now();
      const speedMode = parseSpeedMode(body.speed_mode);
      if (speedMode) session.speedMode = speedMode;
      const left = Number.isFinite(Number(body.left)) ? Number(body.left) : 0;
      const right = Number.isFinite(Number(body.right)) ? Number(body.right) : 0;
      runtime.stoppedByDeadman = false;
      runtime.lastCommand = makeCommand(runtime, session, left, right);
      sendToRobot(runtime, runtime.lastCommand);
      broadcastTelemetry(runtime, "bridge");
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
    telemetryClients: new Set(),
    pilotClients: new Map(),
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
    },
    telemetryHistory: [],
  };
  recordTelemetry(runtime, runtime.telemetry);
  runtimes.set(robot, runtime);
  return runtime;
}

function requireSession(runtime: RobotRuntime, token: string): PilotSession {
  retireExpiredSessions(runtime);
  const session = runtime.sessions.get(token);
  if (!session) throw new Error("pilot session unavailable");
  if (Date.now() > session.expiresAt) {
    runtime.sessions.delete(token);
    throw new Error("pilot session expired");
  }
  if (session.notBeforeMs && Date.now() < session.notBeforeMs) {
    throw new Error("round has not started");
  }
  return session;
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
    deadman_ok: Boolean(body.deadman_ok ?? runtime.pilotClients.size > 0),
    estop: Boolean(body.estop ?? false),
    stopped_by_deadman: Boolean(body.stopped_by_deadman ?? runtime.stoppedByDeadman),
    speed_mode: speedMode,
    max_speed: maxSpeed,
    last_raw_frame_ms: finiteNumber(body.last_raw_frame_ms) ?? current.last_raw_frame_ms,
    source: body.source === "sim" ? "sim" : "robot",
    camera: normalizeCamera(body.camera) ?? current.camera,
    lidar: normalizeLidar(body.lidar) ?? current.lidar,
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
    deadman_ok: runtime.pilotClients.size > 0 && !runtime.stoppedByDeadman,
    stopped_by_deadman: runtime.stoppedByDeadman,
    speed_mode: runtime.lastCommand.speed_mode,
    max_speed: runtime.lastCommand.max_speed,
    session_id: runtime.lastCommand.token || runtime.telemetry.session_id,
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

function recordTelemetry(runtime: RobotRuntime, frame: RobotTelemetry) {
  const last = runtime.telemetryHistory.at(-1);
  if (last && last.ts_ms === frame.ts_ms && last.source === frame.source) return;
  runtime.telemetryHistory.push(structuredClone(frame));
  if (runtime.telemetryHistory.length > TELEMETRY_HISTORY_MAX) {
    runtime.telemetryHistory.splice(0, runtime.telemetryHistory.length - TELEMETRY_HISTORY_MAX);
  }
}

function sendToRobot(runtime: RobotRuntime, command: DriveCommand) {
  if (runtime.robotSocket?.readyState === WebSocket.OPEN) {
    runtime.robotSocket.send(JSON.stringify(command));
  }
}

function safeStop(runtime: RobotRuntime, _reason: string, sendRobot = true) {
  runtime.stoppedByDeadman = true;
  runtime.lastCommand = {
    ...runtime.lastCommand,
    ts_ms: Date.now(),
    left: 0,
    right: 0,
  };
  if (sendRobot) sendToRobot(runtime, runtime.lastCommand);
  broadcastTelemetry(runtime, "bridge");
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
      telemetryClients: runtime.telemetryClients.size,
      sessions: runtime.sessions.size,
      lastCommand: {
        left: runtime.lastCommand.left,
        right: runtime.lastCommand.right,
        speed_mode: runtime.lastCommand.speed_mode,
      },
      telemetry: runtime.telemetry,
    };
  }
  return out;
}

function parseJson(raw: RawData): Record<string, any> {
  const data = Array.isArray(raw) ? Buffer.concat(raw) : raw;
  return JSON.parse(data.toString());
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeCamera(value: unknown): { status: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" ? { status } : undefined;
}

function normalizeLidar(value: unknown): RobotTelemetry["lidar"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const lidar = value as Record<string, unknown>;
  return {
    front_m: finiteNumber(lidar.front_m),
    min_m: finiteNumber(lidar.min_m),
    blocked: typeof lidar.blocked === "boolean" ? lidar.blocked : undefined,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function wsFromHttp(url: string) {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function cameraPlaceholder(robot: RobotName) {
  const runtime = runtimeFor(robot);
  const state = runtime.robotSocket?.readyState === WebSocket.OPEN ? "robot link online" : "waiting for robot camera";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
  <rect width="720" height="1280" fill="#05070a"/>
  <path d="M0 0h720v1280H0z" fill="#07111a"/>
  <g stroke="rgba(255,255,255,.08)" stroke-width="1">
    ${Array.from({ length: 17 }, (_, i) => `<path d="M${i * 45} 0v1280"/>`).join("")}
    ${Array.from({ length: 29 }, (_, i) => `<path d="M0 ${i * 45}h720"/>`).join("")}
  </g>
  <g fill="#f2f7fb" font-family="Menlo, Consolas, monospace" text-anchor="middle">
    <text x="360" y="598" font-size="28">${robot.toUpperCase()}</text>
    <text x="360" y="640" font-size="18" fill="#9baec2">${state}</text>
  </g>
</svg>`;
}
