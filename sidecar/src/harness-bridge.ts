import { WebSocket } from "ws";

type RobotName = "guard" | "courier";

const robot = robotName(process.env.ROBOT ?? "guard");
const sidecarHttp = normalizeHttpUrl(process.env.SIDECAR_URL ?? "http://127.0.0.1:4021");
const sidecarWs = wsFromHttp(sidecarHttp);
const robotHttp = normalizeHttpUrl(process.env.ROBOT_URL ?? "http://127.0.0.1:8000");
const robotWs = wsFromHttp(robotHttp);

let sidecarSocket: WebSocket | null = null;
let robotDrive: WebSocket | null = null;
let robotTelemetry: WebSocket | null = null;
const authorizedTokens = new Set<string>();

connectSidecar();
connectRobotTelemetry();

function connectSidecar() {
  const url = new URL("/ws/robot", sidecarWs);
  url.searchParams.set("robot", robot);
  sidecarSocket = new WebSocket(url);
  sidecarSocket.on("open", () => console.log(`harness bridge attached ${robot} -> ${sidecarHttp}`));
  sidecarSocket.on("message", (raw) => handleSidecarControl(raw.toString()).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
  }));
  sidecarSocket.on("close", () => setTimeout(connectSidecar, 1000));
  sidecarSocket.on("error", (err) => console.error(`sidecar robot socket: ${err.message}`));
}

function connectRobotTelemetry() {
  robotTelemetry = new WebSocket(`${robotWs}/ws/telemetry`);
  robotTelemetry.on("open", () => console.log(`harness telemetry connected ${robotHttp}`));
  robotTelemetry.on("message", (raw) => {
    if (!sidecarSocket || sidecarSocket.readyState !== WebSocket.OPEN) return;
    try {
      const frame = JSON.parse(raw.toString());
      sidecarSocket.send(JSON.stringify({
        ...frame,
        robot,
        camera: frame.camera ?? { status: "harness" },
        lidar: frame.lidar ?? { blocked: false },
      }));
    } catch {
      // Drop malformed harness telemetry.
    }
  });
  robotTelemetry.on("close", () => setTimeout(connectRobotTelemetry, 1000));
  robotTelemetry.on("error", (err) => console.error(`harness telemetry: ${err.message}`));
}

async function handleSidecarControl(raw: string) {
  const frame = JSON.parse(raw);
  if (frame.type && frame.type !== "control") return;
  const token = String(frame.token ?? "");
  if (!token) return;
  await ensureHarnessToken(token, frame.speed_mode);
  await ensureRobotDrive();
  if (!robotDrive || robotDrive.readyState !== WebSocket.OPEN) return;
  robotDrive.send(JSON.stringify({
    token,
    left: finite(frame.left),
    right: finite(frame.right),
    t: Date.now(),
  }));
}

async function ensureHarnessToken(token: string, speedMode: unknown) {
  if (authorizedTokens.has(token)) return;
  const res = await fetch(`${robotHttp}/pilot/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      ttl_secs: Number(process.env.HARNESS_TOKEN_TTL_SECS ?? 300),
      speed_mode: speedMode === "low" || speedMode === "medium" || speedMode === "high"
        ? speedMode
        : "medium",
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `harness authorize failed ${res.status}`);
  authorizedTokens.add(token);
}

async function ensureRobotDrive() {
  if (robotDrive?.readyState === WebSocket.OPEN) return;
  robotDrive = new WebSocket(`${robotWs}/ws/drive`);
  await new Promise<void>((resolve, reject) => {
    robotDrive?.once("open", resolve);
    robotDrive?.once("error", reject);
  });
  robotDrive.on("close", () => {
    robotDrive = null;
  });
}

function normalizeHttpUrl(value: string) {
  return value.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/$/, "");
}

function wsFromHttp(value: string) {
  return value.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function robotName(value: string): RobotName {
  if (value === "guard" || value === "courier") return value;
  throw new Error("ROBOT must be guard or courier");
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
