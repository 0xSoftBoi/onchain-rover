import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { WebSocket } from "ws";

const sidecarHttp = normalizeHttpUrl(process.env.SIDECAR_URL ?? "http://127.0.0.1:4021");
const harnessPort = Number(process.env.HARNESS_PORT ?? 8121);
const harnessHttp = `http://127.0.0.1:${harnessPort}`;
const robot = process.env.ROBOT === "courier" ? "courier" : "guard";

const children: ChildProcessWithoutNullStreams[] = [];

async function main() {
  await getJson("/chain/health");
  spawnChild("cargo", [
    "run",
    "--quiet",
    "--",
    "--mode",
    "sim",
    "--role",
    robot,
    "--listen",
    `127.0.0.1:${harnessPort}`,
  ], "../../robot-harness");
  await waitForUrl(`${harnessHttp}/health`, 30_000);

  spawnChild("npx", ["tsx", "src/harness-bridge.ts"], "../", {
    SIDECAR_URL: sidecarHttp,
    ROBOT_URL: harnessHttp,
    ROBOT: robot,
  });
  await waitForRobotConnected();

  const pilot = await postJson("/pilot/dev-authorize", { robot, speed_mode: "high" });
  const drive = await openDriveSocket(pilot.driveWs, pilot.token);
  for (let i = 0; i < 14; i++) {
    drive.send(JSON.stringify({ token: pilot.token, left: 1, right: 1, speed_mode: "high", t: Date.now() }));
    await sleep(90);
  }
  drive.send(JSON.stringify({ token: pilot.token, left: 0, right: 0, speed_mode: "high", t: Date.now() }));
  await sleep(250);
  drive.close();

  const state = await getJson("/robot-link/state");
  const telemetry = state.robots?.[robot]?.telemetry;
  const odometry = ((Number(telemetry?.odometry_left ?? 0) + Number(telemetry?.odometry_right ?? 0)) / 2);
  if (telemetry?.source !== "sim") throw new Error(`expected sim telemetry, got ${telemetry?.source}`);
  if (!(odometry > 0.01)) throw new Error(`expected harness odometry, got ${odometry}`);

  console.log("Harness bridge e2e passed");
  console.log(`  robot:    ${robot}`);
  console.log(`  harness:  ${harnessHttp}`);
  console.log(`  source:   ${telemetry.source}`);
  console.log(`  odometry: ${odometry.toFixed(3)}`);
  cleanup();
}

function spawnChild(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
) {
  const child = spawn(command, args, {
    cwd: new URL(cwd, import.meta.url),
    env: { ...process.env, ...env },
  });
  children.push(child);
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    if (process.env.E2E_VERBOSE) process.stderr.write(text);
  });
  child.stdout.on("data", (chunk) => {
    if (process.env.E2E_VERBOSE) process.stdout.write(chunk);
  });
  return child;
}

async function waitForRobotConnected() {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const state = await getJson("/robot-link/state").catch(() => null);
    if (state?.robots?.[robot]?.robotConnected) return;
    await sleep(250);
  }
  throw new Error("sidecar robot bridge did not connect");
}

async function waitForUrl(url: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Keep waiting for the harness process.
    }
    await sleep(250);
  }
  throw new Error(`${url} did not become ready`);
}

async function openDriveSocket(url: string, token: string) {
  const driveUrl = rebaseWsUrl(url);
  const ws = new WebSocket(driveUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ token, left: 0, right: 0, speed_mode: "high", t: Date.now() }));
  return ws;
}

async function getJson(path: string) {
  const res = await fetch(`${sidecarHttp}${path}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `${path} failed ${res.status}`);
  return json;
}

async function postJson(path: string, body: Record<string, unknown> = {}) {
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

function rebaseWsUrl(value: string) {
  const target = new URL(value);
  const base = new URL(sidecarHttp.replace(/^http:/, "ws:").replace(/^https:/, "wss:"));
  target.protocol = base.protocol;
  target.host = base.host;
  return target.toString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("exit", () => {
  cleanup();
});

function cleanup() {
  for (const child of children) {
    if (!child.killed) child.kill("SIGINT");
  }
  children.splice(0, children.length);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
