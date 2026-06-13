import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

type RobotName = "guard" | "courier";
type DriverSlot = "challenger" | "opponent";
type SpeedMode = "low" | "medium" | "high";

export type SensorReplayFrame = {
  atMs: number;
  robot: RobotName;
  frame: {
    battery_v?: number;
    left_cmd?: number;
    right_cmd?: number;
    odometry_left?: number;
    odometry_right?: number;
    yaw?: number;
    deadman_ok?: boolean;
    estop?: boolean;
    stopped_by_deadman?: boolean;
    soft_odometry_limited?: boolean;
    soft_odometry_limit_m?: number;
    speed_mode?: SpeedMode;
    max_speed?: number;
    camera?: Record<string, unknown>;
    lidar?: Record<string, unknown>;
    sensors?: Record<string, unknown>;
  };
};

export type SensorReplayFixture = {
  schema: "onchain-rover.sensor-replay-fixture.v1";
  name: string;
  description?: string;
  round: {
    stakeUsdc?: string;
    feeUsdc?: string;
    durationSecs?: number;
    countdownSecs?: number;
    stageCalibration?: Record<string, unknown>;
  };
  frames: SensorReplayFrame[];
  expected?: {
    events?: string[];
    drivers?: Partial<Record<DriverSlot, {
      robot?: RobotName;
      lane?: "left" | "right";
      minProgressFt?: number;
      cameraStaleCountAtLeast?: number;
      lidarStaleEvent?: boolean;
    }>>;
  };
};

export type SensorReplayResult = {
  fixture: SensorReplayFixture;
  round: Record<string, any>;
  trace: Record<string, any>;
  sidecarUrl: string;
};

export type SensorReplayOptions = {
  fixturePath?: string;
  sidecarUrl?: string;
  realtime?: boolean;
  minFrameDelayMs?: number;
};

const sidecarDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SENSOR_REPLAY_FIXTURE = resolve(
  sidecarDir,
  "fixtures/sensor-replay/two-lane-heat.json",
);

export function loadSensorReplayFixture(path = DEFAULT_SENSOR_REPLAY_FIXTURE): SensorReplayFixture {
  const fixture = JSON.parse(readFileSync(path, "utf8")) as SensorReplayFixture;
  if (fixture.schema !== "onchain-rover.sensor-replay-fixture.v1") {
    throw new Error(`unsupported sensor replay fixture schema: ${fixture.schema}`);
  }
  if (!fixture.frames.length) throw new Error("sensor replay fixture has no frames");
  for (const [index, frame] of fixture.frames.entries()) {
    if (frame.robot !== "guard" && frame.robot !== "courier") {
      throw new Error(`fixture frame ${index} has invalid robot: ${String(frame.robot)}`);
    }
    if (!Number.isFinite(Number(frame.atMs))) {
      throw new Error(`fixture frame ${index} has invalid atMs`);
    }
  }
  return fixture;
}

export async function replaySensorFixture(opts: SensorReplayOptions = {}): Promise<SensorReplayResult> {
  const fixture = loadSensorReplayFixture(opts.fixturePath);
  const sidecarUrl = normalizeHttpUrl(opts.sidecarUrl ?? process.env.SIDECAR_URL ?? "http://127.0.0.1:4021");
  const http = makeHttpClient(sidecarUrl);
  const sockets: Partial<Record<RobotName, WebSocket>> = {};

  try {
    const chain = await http.getJson("/chain/health");
    if (!chain.ok) throw new Error("local chain is not healthy");

    let round = await http.postJson("/race/round/challenge", fixture.round);
    const prepared = await http.postJson(`/race/round/${round.id}/dev/join-local-wallets`, {
      amount: "20",
      lockChain: true,
    });
    round = prepared.round;

    sockets.guard = await openRobotSocket(sidecarUrl, "guard");
    sockets.courier = await openRobotSocket(sidecarUrl, "courier");

    round = await http.postJson(`/race/round/${round.id}/lock`, { skipRobotAuth: true });
    round = await http.postJson(`/race/round/${round.id}/countdown`);
    await sleep(Math.max(0, Number(round.roundStartsAt ?? Date.now()) - Date.now()) + 50);
    round = await http.postJson(`/race/round/${round.id}/start`);

    await replayFrames(fixture, sockets, sidecarUrl, {
      realtime: opts.realtime ?? true,
      minFrameDelayMs: opts.minFrameDelayMs ?? 12,
    });
    await sleep(50);

    const trace = await http.getJson(`/race/round/${round.id}/telemetry-trace?frames=1`);
    return { fixture, round, trace, sidecarUrl };
  } finally {
    for (const socket of Object.values(sockets)) {
      if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, "sensor replay complete");
    }
  }
}

async function replayFrames(
  fixture: SensorReplayFixture,
  sockets: Partial<Record<RobotName, WebSocket>>,
  sidecarUrl: string,
  opts: { realtime: boolean; minFrameDelayMs: number },
) {
  const frames = [...fixture.frames].sort((a, b) => a.atMs - b.atMs);
  const replayStartedAt = Date.now();
  let previousAtMs = frames[0]?.atMs ?? 0;

  for (const frame of frames) {
    const delayMs = opts.realtime
      ? Math.max(0, frame.atMs - previousAtMs)
      : opts.minFrameDelayMs;
    if (delayMs > 0) await sleep(delayMs);
    previousAtMs = frame.atMs;

    const socket = await ensureRobotSocket(sockets, sidecarUrl, frame.robot);
    socket.send(JSON.stringify({
      type: "telemetry",
      source: "sim",
      ts_ms: replayStartedAt + frame.atMs,
      robot: frame.robot,
      ...frame.frame,
    }));
  }
}

async function ensureRobotSocket(
  sockets: Partial<Record<RobotName, WebSocket>>,
  sidecarUrl: string,
  robot: RobotName,
) {
  const existing = sockets[robot];
  if (existing?.readyState === WebSocket.OPEN) return existing;
  if (existing?.readyState === WebSocket.CONNECTING) {
    await waitForSocketOpen(existing, 1000).catch(() => undefined);
    const current = sockets[robot];
    if (current?.readyState === WebSocket.OPEN) return current;
  }
  existing?.close();
  const socket = await openRobotSocket(sidecarUrl, robot);
  sockets[robot] = socket;
  return socket;
}

async function openRobotSocket(sidecarUrl: string, robot: RobotName) {
  const url = new URL("/ws/robot", sidecarUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:"));
  url.searchParams.set("robot", robot);
  const ws = new WebSocket(url);
  await waitForSocketOpen(ws, 5000);
  return ws;
}

async function waitForSocketOpen(ws: WebSocket, timeoutMs: number) {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectOpen(new Error("robot socket open timed out"));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolveOpen();
    };
    const onError = (err: Error) => {
      cleanup();
      rejectOpen(err);
    };
    const onClose = () => {
      cleanup();
      rejectOpen(new Error("robot socket closed before open"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

function makeHttpClient(sidecarUrl: string) {
  async function getJson(path: string) {
    const res = await fetch(`${sidecarUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error || `${path} failed ${res.status}`);
    return json;
  }

  async function postJson(path: string, body: Record<string, unknown> = {}) {
    const res = await fetch(`${sidecarUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error || `${path} failed ${res.status}`);
    return json;
  }

  return { getJson, postJson };
}

function normalizeHttpUrl(value: string) {
  return value.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/$/, "");
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isMainModule() {
  const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
  return invoked === import.meta.url;
}

if (isMainModule()) {
  const fixtureArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  replaySensorFixture({
    fixturePath: fixtureArg ?? process.env.SENSOR_REPLAY_FIXTURE,
    realtime: process.env.SENSOR_REPLAY_REALTIME !== "0" && !process.argv.includes("--fast"),
  }).then(({ fixture, round, trace, sidecarUrl }) => {
    console.log("Sensor replay completed");
    console.log(`  sidecar:  ${sidecarUrl}`);
    console.log(`  fixture:  ${fixture.name}`);
    console.log(`  roundId:  ${round.id}`);
    console.log(`  frames:   ${trace.frameCount}`);
    console.log(`  events:   ${(trace.eventSequence ?? []).map((event: { type?: string }) => event.type).filter(Boolean).join(", ")}`);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
