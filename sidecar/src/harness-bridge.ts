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
  if (process.env.ROBOT_TELEMETRY_MODE === "poll") {
    pollRobotTelemetry().catch((err) => {
      console.error(`harness telemetry poll: ${err instanceof Error ? err.message : err}`);
      setTimeout(connectRobotTelemetry, 1000);
    });
    return;
  }
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
        lidar: frame.lidar ?? frame.sensors?.lidar ?? { status: "unavailable" },
      }));
    } catch {
      // Drop malformed harness telemetry.
    }
  });
  robotTelemetry.on("close", () => setTimeout(connectRobotTelemetry, 1000));
  robotTelemetry.on("error", (err) => console.error(`harness telemetry: ${err.message}`));
}

async function pollRobotTelemetry() {
  console.log(`harness telemetry polling ${robotHttp}/telemetry`);
  while (true) {
    await sleep(Number(process.env.ROBOT_TELEMETRY_POLL_MS ?? 100));
    if (!sidecarSocket || sidecarSocket.readyState !== WebSocket.OPEN) continue;
    const res = await fetch(`${robotHttp}/telemetry`, { signal: AbortSignal.timeout(1000) });
    const frame = await res.json();
    if (!res.ok || frame.error) throw new Error(frame.error || `robot telemetry failed ${res.status}`);
    sidecarSocket.send(JSON.stringify(toSidecarTelemetry(frame)));
  }
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

function toSidecarTelemetry(frame: Record<string, any>) {
  const odom = Array.isArray(frame.odom) ? frame.odom : [];
  const sensors = typeof frame.sensors === "object" && frame.sensors ? frame.sensors : undefined;
  const sensorOdometry = typeof sensors?.odometry === "object" ? sensors.odometry : undefined;
  const sensorBattery = typeof sensors?.battery === "object" ? sensors.battery : undefined;
  return {
    ...frame,
    type: "telemetry",
    source: frame.source === "sim" ? "sim" : "robot",
    ts_ms: finiteOr(frame.ts_ms, Date.now()),
    robot,
    battery_v: finiteOptional(frame.battery_v) ?? finiteOptional(sensorBattery?.voltage_v),
    left_cmd: finiteOr(frame.left_cmd, 0),
    right_cmd: finiteOr(frame.right_cmd, 0),
    odometry_left: finiteOptional(frame.odometry_left) ?? finiteOptional(sensorOdometry?.left) ?? finiteOptional(odom[0]),
    odometry_right: finiteOptional(frame.odometry_right) ?? finiteOptional(sensorOdometry?.right) ?? finiteOptional(odom[1]),
    deadman_ok: Boolean(frame.deadman_ok ?? true),
    stopped_by_deadman: Boolean(frame.stopped_by_deadman ?? false),
    estop: Boolean(frame.estop ?? false),
    speed_mode: frame.speed_mode === "low" || frame.speed_mode === "medium" || frame.speed_mode === "high"
      ? frame.speed_mode
      : "medium",
    max_speed: finiteOr(frame.max_speed, 0.35),
    raw_frame_age_ms: finiteOptional(frame.raw_frame_age_ms),
    camera: frame.camera ?? sensors?.camera ?? { status: "unavailable" },
    lidar: frame.lidar ?? sensors?.lidar ?? { status: "unavailable" },
    imu: frame.imu ?? {
      accel: Array.isArray(frame.accel) ? frame.accel : undefined,
      gyro: Array.isArray(frame.gyro) ? frame.gyro : undefined,
    },
    sensors,
    action: frame.action,
  };
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteOptional(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function finiteOr(value: unknown, fallback: number) {
  return finiteOptional(value) ?? fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
