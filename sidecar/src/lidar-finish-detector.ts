import { WebSocket } from "ws";

type RobotName = "guard" | "courier";

const roundId = process.argv[2] || process.env.ROUND_ID || "";
if (!roundId) {
  console.error("usage: npm run detector:lidar -- <roundId>");
  process.exit(1);
}

const sidecarHttp = normalizeHttpUrl(process.env.SIDECAR_URL ?? "http://127.0.0.1:4021");
const sidecarWs = sidecarHttp.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
const robots = robotList(process.env.LIDAR_ROBOTS ?? process.env.FINISH_ROBOTS ?? "guard,courier");
const threshold = numberEnv("LIDAR_FRONT_M", numberEnv("FINISH_LIDAR_FRONT_M", 0.3));
const once = process.env.DETECTOR_ONCE !== "0";
const seen = new Set<string>();

for (const robot of robots) watchRobot(robot);

function watchRobot(robot: RobotName) {
  const url = new URL("/ws/telemetry", sidecarWs);
  url.searchParams.set("robot", robot);
  const ws = new WebSocket(url);
  ws.on("open", () => console.log(`watching ${robot} lidar <= ${threshold}m`));
  ws.on("message", async (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      const front = numberOrNull(frame?.lidar?.front_m ?? frame?.lidar?.min_m);
      if (front === null || front > threshold || seen.has(robot)) return;
      seen.add(robot);
      const res = await postJson(`/race/round/${roundId}/finish-detection`, {
        robot,
        source: "lidar-telemetry-adapter",
        method: "front-distance-threshold",
        confidence: Math.max(0.5, Math.min(0.99, 1 - front / Math.max(threshold, 0.001))),
        metrics: {
          front_m: front,
          threshold_m: threshold,
          telemetry_ts_ms: frame.ts_ms,
        },
      });
      console.log(`posted ${robot} lidar finish: ${res.detection?.id ?? "ok"}`);
      if (once) process.exit(0);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
    }
  });
  ws.on("close", () => {
    if (!once || !seen.size) setTimeout(() => watchRobot(robot), 1000);
  });
  ws.on("error", (err) => console.error(`${robot} lidar socket: ${err.message}`));
}

async function postJson(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${sidecarHttp}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `${path} failed ${res.status}`);
  return json;
}

function normalizeHttpUrl(value: string) {
  return value.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/$/, "");
}

function robotList(value: string): RobotName[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is RobotName => item === "guard" || item === "courier");
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

function numberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
