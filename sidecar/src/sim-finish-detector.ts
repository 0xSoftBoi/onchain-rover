import { WebSocket } from "ws";

type RobotName = "guard" | "courier";

type TelemetryFrame = {
  ts_ms?: number;
  robot?: RobotName;
  odometry_left?: number;
  odometry_right?: number;
  yaw?: number;
  source?: string;
  lidar?: { front_m?: number; min_m?: number; blocked?: boolean };
};

type DetectorMode = "odometry" | "lidar";

const roundId = process.argv[2] ?? process.env.ROUND_ID;
if (!roundId) throw new Error("round id required: npm run sim:finish -- <roundId>");

const sidecarHttp = normalizeHttpUrl(process.env.SIDECAR_URL ?? "http://127.0.0.1:4021");
const sidecarWs = sidecarHttp.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
const robots = parseRobots(process.env.FINISH_ROBOTS ?? "guard,courier");
const mode = parseMode(process.env.FINISH_MODE ?? "odometry");
const odometryThreshold = numberEnv("FINISH_ODOMETRY", 6);
const lidarThreshold = numberEnv("FINISH_LIDAR_FRONT_M", 0.3);
const confidence = numberEnv("FINISH_CONFIDENCE", 0.9);
const once = process.env.DETECTOR_ONCE !== "0";

const sockets = new Map<RobotName, WebSocket>();
let fired = false;

for (const robot of robots) connect(robot);

process.on("SIGINT", () => closeAll(0));

function connect(robot: RobotName) {
  const url = new URL("/ws/telemetry", sidecarWs);
  url.searchParams.set("robot", robot);
  const ws = new WebSocket(url);
  sockets.set(robot, ws);

  ws.on("open", () => {
    console.log(`[sim-finish] watching ${robot} via ${url.toString()}`);
  });

  ws.on("message", async (raw) => {
    if (fired && once) return;
    try {
      const frame = JSON.parse(raw.toString()) as TelemetryFrame;
      const detection = detect(robot, frame);
      if (!detection) return;
      fired = true;
      const result = await postFinishDetection(robot, frame, detection);
      console.log(JSON.stringify({
        detected: true,
        roundId,
        robot,
        slot: result.detection?.slot,
        winner: result.round?.winner,
        proofHash: result.round?.proofHash,
        metrics: detection.metrics,
      }, null, 2));
      if (once) closeAll(0);
    } catch (err) {
      console.error(`[sim-finish] ${robot}: ${err instanceof Error ? err.message : String(err)}`);
      if (fired && once) closeAll(1);
    }
  });

  ws.on("close", () => {
    sockets.delete(robot);
    if (!fired) setTimeout(() => connect(robot), 1000);
  });

  ws.on("error", (err) => {
    console.error(`[sim-finish] ${robot} websocket error: ${err.message}`);
  });
}

function detect(robot: RobotName, frame: TelemetryFrame) {
  if (mode === "lidar") {
    const front = frame.lidar?.front_m ?? frame.lidar?.min_m;
    const blocked = frame.lidar?.blocked === true || (front !== undefined && front <= lidarThreshold);
    if (!blocked) return null;
    return {
      method: "lidar-finish-threshold",
      metrics: { front_m: front ?? null, threshold_m: lidarThreshold, blocked: frame.lidar?.blocked ?? false },
    };
  }

  const left = finite(frame.odometry_left);
  const right = finite(frame.odometry_right);
  if (left === undefined && right === undefined) return null;
  const odometry = left !== undefined && right !== undefined ? (left + right) / 2 : left ?? right ?? 0;
  if (odometry < odometryThreshold) return null;
  return {
    method: "odometry-finish-threshold",
    metrics: {
      odometry,
      threshold: odometryThreshold,
      odometry_left: left ?? null,
      odometry_right: right ?? null,
      yaw: frame.yaw ?? null,
      telemetry_source: frame.source ?? "unknown",
      robot,
    },
  };
}

async function postFinishDetection(robot: RobotName, frame: TelemetryFrame, detection: {
  method: string;
  metrics: Record<string, unknown>;
}) {
  const res = await fetch(`${sidecarHttp}/race/round/${encodeURIComponent(roundId!)}/finish-detection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      robot,
      source: "sim-finish-detector",
      method: detection.method,
      confidence,
      detectedAtMs: frame.ts_ms ?? Date.now(),
      metrics: detection.metrics,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || `finish detection failed ${res.status}`);
  return body;
}

function parseRobots(value: string): RobotName[] {
  const robots = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!robots.length) throw new Error("FINISH_ROBOTS must include guard, courier, or both");
  return robots.map((robot) => {
    if (robot === "guard" || robot === "courier") return robot;
    throw new Error(`unknown robot ${robot}`);
  });
}

function parseMode(value: string): DetectorMode {
  if (value === "odometry" || value === "lidar") return value;
  throw new Error("FINISH_MODE must be odometry or lidar");
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

function finite(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeHttpUrl(value: string) {
  return value.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/$/, "");
}

function closeAll(code: number) {
  for (const ws of sockets.values()) ws.close();
  process.exit(code);
}
