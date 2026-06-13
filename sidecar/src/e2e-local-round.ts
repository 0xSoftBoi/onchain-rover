import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import * as raceStore from "./race-store.js";

type DriverSlot = "challenger" | "opponent";
type RobotName = "guard" | "courier";
type SpeedMode = "low" | "medium" | "high";

type TypedDataEnvelope = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

const LOCAL_KEYS = {
  challenger: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  opponent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;

const accounts = {
  challenger: privateKeyToAccount(LOCAL_KEYS.challenger),
  opponent: privateKeyToAccount(LOCAL_KEYS.opponent),
} as const;

const sidecarHttp = normalizeHttpUrl(process.env.SIDECAR_URL ?? "http://127.0.0.1:4021");
const sidecarWs = sidecarHttp.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
const finishThreshold = numberEnv("E2E_FINISH_ODOMETRY", 0.65);

async function main() {
  const chain = await getJson("/chain/health");
  if (!chain.ok) throw new Error("local chain is not healthy");

  const robot = new InlineRobot("guard");
  await robot.connect();

  let round = await postJson("/race/round/challenge", {
    wallet: accounts.challenger.address,
    displayName: "challenger",
    stakeUsdc: "1.00",
    feeUsdc: "0.25",
    durationSecs: 20,
    countdownSecs: 1,
  });
  round = await postJson(`/race/round/${round.id}/accept`, {
    wallet: accounts.opponent.address,
    displayName: "opponent",
  });
  round = await postJson(`/race/round/${round.id}/chain/open`);

  await postJson("/chain/faucet", { wallet: accounts.challenger.address, amount: "20" });
  await postJson("/chain/faucet", { wallet: accounts.opponent.address, amount: "20" });

  round = await joinDriver(round.id, "challenger", accounts.challenger);
  round = await joinDriver(round.id, "opponent", accounts.opponent);
  round = await postJson(`/race/round/${round.id}/chain/lock`);
  round = await postJson(`/race/round/${round.id}/lock`, { skipRobotAuth: true });
  round = await postJson(`/race/round/${round.id}/countdown`);
  await sleep(Math.max(0, (round.roundStartsAt ?? Date.now()) - Date.now()) + 100);
  round = await postJson(`/race/round/${round.id}/start`);
  round = await postJson(`/race/round/${round.id}/chain/start`);

  const pilot = await postJson("/pilot/dev-authorize", { robot: "guard", speed_mode: "high" });
  const drive = await openDriveSocket(pilot.driveWs, pilot.token);
  const threshold = robot.waitForOdometry(finishThreshold);
  const driveTimer = setInterval(() => {
    drive.send(JSON.stringify({
      token: pilot.token,
      left: 1,
      right: 1,
      speed_mode: "high",
      t: Date.now(),
    }));
  }, 80);

  const odometry = await threshold;
  clearInterval(driveTimer);
  drive.send(JSON.stringify({ token: pilot.token, left: 0, right: 0, speed_mode: "high", t: Date.now() }));
  await sleep(120);
  drive.close();

  const detection = await postJson(`/race/round/${round.id}/finish-detection`, {
    robot: "guard",
    source: "local-round-runner",
    method: "odometry-threshold",
    confidence: 0.99,
    metrics: { odometry, threshold: finishThreshold },
  });
  round = detection.round;
  round = await postJson(`/race/round/${round.id}/chain/settle`);
  const evidence = await getJson(`/race/round/${round.id}/evidence/hash`);
  const treasury = await getJson("/treasury/local");
  assertPersistedLedger(round, evidence);

  robot.close();

  console.log("Full local race e2e passed");
  console.log(`  roundId:      ${round.id}`);
  console.log(`  chainRaceId:  ${round.chainRaceId}`);
  console.log(`  winner:       ${round.winner}`);
  console.log(`  status:       ${round.status}/${round.chainStatus}`);
  console.log(`  proofHash:    ${evidence.proofHash}`);
  console.log(`  evidenceHash: ${evidence.evidenceHash}`);
  console.log(`  persisted:    ${raceStore.persistedRoundPaths(round.id).dir}`);
  console.log(`  treasury:     ${treasury.totalFees} local units`);
}

async function joinDriver(roundId: string, slot: DriverSlot, account: PrivateKeyAccount) {
  const request = await postJson(`/race/round/${roundId}/chain/authorization-request`, {
    slot,
    wallet: account.address,
  }) as { entry: TypedDataEnvelope; permit: TypedDataEnvelope };
  const entrySignature = await signTypedData(account, request.entry);
  const permitSignature = await signTypedData(account, request.permit);
  return postJson(`/race/round/${roundId}/chain/join`, {
    slot,
    entrySignature,
    permitSignature,
    entryDeadline: request.entry.message.deadline,
    permitDeadline: request.permit.message.deadline,
  });
}

async function signTypedData(account: PrivateKeyAccount, data: TypedDataEnvelope) {
  return account.signTypedData({
    domain: data.domain,
    types: data.types,
    primaryType: data.primaryType,
    message: data.message,
  } as any);
}

class InlineRobot {
  private ws?: WebSocket;
  private telemetryTimer?: NodeJS.Timeout;
  private left = 0;
  private right = 0;
  private speedMode: SpeedMode = "medium";
  private maxSpeed = 0.35;
  private lastCommandAt = 0;
  private odometryLeft = 0;
  private odometryRight = 0;
  private yaw = 0;
  private thresholdWaiters: Array<{ threshold: number; resolve: (value: number) => void }> = [];

  constructor(private readonly robot: RobotName) {}

  async connect() {
    const url = new URL("/ws/robot", sidecarWs);
    url.searchParams.set("robot", this.robot);
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => this.handleControl(raw.toString()));
    await new Promise<void>((resolve, reject) => {
      this.ws?.once("open", () => {
        this.telemetryTimer = setInterval(() => this.sendTelemetry(), 100);
        resolve();
      });
      this.ws?.once("error", reject);
    });
  }

  waitForOdometry(threshold: number) {
    const current = this.odometry();
    if (current >= threshold) return Promise.resolve(current);
    return new Promise<number>((resolve) => this.thresholdWaiters.push({ threshold, resolve }));
  }

  close() {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.ws?.close();
  }

  private handleControl(raw: string) {
    try {
      const frame = JSON.parse(raw);
      if (frame.type && frame.type !== "control") return;
      this.left = clamp(Number(frame.left ?? this.left), -1, 1);
      this.right = clamp(Number(frame.right ?? this.right), -1, 1);
      this.speedMode = parseSpeedMode(frame.speed_mode) ?? this.speedMode;
      this.maxSpeed = Number.isFinite(Number(frame.max_speed)) ? Number(frame.max_speed) : this.maxSpeed;
      this.lastCommandAt = Date.now();
    } catch {
      // Ignore malformed bridge frames in the e2e simulator.
    }
  }

  private sendTelemetry() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const staleMs = this.lastCommandAt ? now - this.lastCommandAt : Number.POSITIVE_INFINITY;
    const deadmanOk = staleMs < 700;
    const effectiveLeft = deadmanOk ? this.left : 0;
    const effectiveRight = deadmanOk ? this.right : 0;
    this.odometryLeft += effectiveLeft * 0.1 * 24;
    this.odometryRight += effectiveRight * 0.1 * 24;
    this.yaw += (effectiveRight - effectiveLeft) * 0.1 * 32;
    const odometry = this.odometry();

    this.ws.send(JSON.stringify({
      type: "telemetry",
      source: "e2e",
      ts_ms: now,
      robot: this.robot,
      battery_v: 12.4,
      left_cmd: effectiveLeft,
      right_cmd: effectiveRight,
      odometry_left: this.odometryLeft,
      odometry_right: this.odometryRight,
      yaw: this.yaw,
      deadman_ok: deadmanOk,
      stopped_by_deadman: !deadmanOk && (Math.abs(this.left) > 0.001 || Math.abs(this.right) > 0.001),
      estop: false,
      speed_mode: this.speedMode,
      max_speed: this.maxSpeed,
      camera: { status: "e2e" },
      lidar: { front_m: 1.0, min_m: 0.9, blocked: false },
    }));

    const ready = this.thresholdWaiters.filter((waiter) => odometry >= waiter.threshold);
    this.thresholdWaiters = this.thresholdWaiters.filter((waiter) => odometry < waiter.threshold);
    for (const waiter of ready) waiter.resolve(odometry);
  }

  private odometry() {
    return (this.odometryLeft + this.odometryRight) / 2;
  }
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

function assertPersistedLedger(round: any, evidence: any) {
  const paths = raceStore.persistedRoundPaths(round.id);
  const persistedRound = readJson(paths.round);
  const persistedEvidence = readJson(paths.evidence);
  const events = readFileSync(paths.events, "utf8");

  if (persistedRound.status !== "settled") throw new Error("persisted round is not settled");
  if (persistedRound.chainStatus !== "settled") throw new Error("persisted chain round is not settled");
  if (persistedRound.proofHash !== evidence.proofHash) throw new Error("persisted proof hash mismatch");
  if (persistedRound.evidenceHash !== evidence.evidenceHash) throw new Error("persisted evidence hash mismatch");
  if (persistedRound.drivers?.challenger?.token || persistedRound.drivers?.opponent?.token) {
    throw new Error("persisted round leaked a pilot token");
  }
  if (persistedEvidence.proofHash !== evidence.proofHash) throw new Error("persisted evidence proof hash mismatch");
  if (persistedEvidence.packetHash !== evidence.evidenceHash) {
    throw new Error("persisted evidence packet hash mismatch");
  }
  if (!events.includes("\"kind\":\"round.chain_settled\"")) {
    throw new Error("persisted event log is missing chain settlement");
  }
  if (!events.includes("\"kind\":\"evidence.result_finalized\"")) {
    throw new Error("persisted event log is missing finalized evidence");
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function rebaseWsUrl(value: string) {
  const target = new URL(value);
  const base = new URL(sidecarWs);
  target.protocol = base.protocol;
  target.host = base.host;
  return target.toString();
}

function normalizeHttpUrl(value: string) {
  return value.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/$/, "");
}

function parseSpeedMode(value: unknown): SpeedMode | null {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
