import { createHash, randomUUID } from "node:crypto";

import type { RobotName } from "./config.js";
import * as robotLink from "./robot-link.js";
import * as raceStore from "./race-store.js";
import type { DriverSlot, Round } from "./rounds.js";

type Hex32 = `0x${string}`;
type EvidenceEventName = "locked" | "started" | "finished" | "settled";

type EvidenceEvent = {
  event: EvidenceEventName;
  atMs: number;
  round: ReturnType<typeof sanitizeRound>;
};

export type EvidenceRecord = {
  roundId: string;
  createdAtMs: number;
  updatedAtMs: number;
  events: EvidenceEvent[];
  finishDetections: FinishDetectionEvent[];
  operatorProof?: Record<string, unknown>;
  resultProof?: Record<string, unknown>;
  resultProofCanonical?: string;
  proofHash?: Hex32;
  packetHash?: Hex32;
};

export type FinishDetectionEvent = {
  id: string;
  roundId: string;
  slot: DriverSlot;
  robot: RobotName | null;
  lane: "left" | "right" | null;
  source: string;
  method: string;
  confidence: number;
  detectedAtMs: number;
  receivedAtMs: number;
  metrics?: Record<string, unknown>;
  frameHash?: string;
  note?: string;
  telemetry?: robotLink.RobotTelemetry | null;
};

type FinishDetectionInput = {
  slot?: unknown;
  robot?: unknown;
  source?: unknown;
  method?: unknown;
  confidence?: unknown;
  detectedAtMs?: unknown;
  metrics?: unknown;
  frameHash?: unknown;
  note?: unknown;
};

const records = new Map<string, EvidenceRecord>();
for (const record of raceStore.loadEvidenceRecords()) records.set(record.roundId, record);

export function recordRoundSnapshot(round: Round, event: EvidenceEventName): EvidenceRecord {
  const record = ensureRecord(round.id);
  record.updatedAtMs = Date.now();
  record.events.push({
    event,
    atMs: eventTime(round, event) ?? record.updatedAtMs,
    round: sanitizeRound(round),
  });
  record.packetHash = hashEvidencePacket(record);
  raceStore.saveEvidence(record, `evidence.${event}`);
  return structuredClone(record);
}

export function finalizeResultProof(round: Round, operatorProof?: Record<string, unknown>) {
  const record = ensureRecord(round.id);
  if (operatorProof) record.operatorProof = sortedClone(operatorProof) as Record<string, unknown>;
  if (!record.events.some((event) => event.event === "finished")) {
    recordRoundSnapshot(round, "finished");
  }
  if (!record.resultProof || !record.proofHash) {
    record.updatedAtMs = Date.now();
    record.resultProof = buildResultProof(record, round);
    record.resultProofCanonical = canonicalJson(record.resultProof);
    record.proofHash = sha256Hex(record.resultProofCanonical);
  }
  record.packetHash = hashEvidencePacket(record);
  raceStore.saveEvidence(record, "evidence.result_finalized");
  return {
    proofHash: record.proofHash,
    evidenceHash: record.packetHash,
    evidence: evidenceResponse(record),
  };
}

export function recordFinishDetection(round: Round, input: FinishDetectionInput): FinishDetectionEvent {
  const record = ensureRecord(round.id);
  const slot = inferDetectionSlot(round, input);
  const driver = round.drivers[slot];
  const robot = driver?.robot ?? null;
  const detection: FinishDetectionEvent = {
    id: randomUUID(),
    roundId: round.id,
    slot,
    robot,
    lane: driver?.lane ?? null,
    source: stringOr(input.source, "finish-detector"),
    method: stringOr(input.method, "finish-line"),
    confidence: confidence(input.confidence),
    detectedAtMs: millisOrNow(input.detectedAtMs),
    receivedAtMs: Date.now(),
    metrics: input.metrics && typeof input.metrics === "object"
      ? sortedClone(input.metrics) as Record<string, unknown>
      : undefined,
    frameHash: typeof input.frameHash === "string" ? input.frameHash : undefined,
    note: typeof input.note === "string" ? input.note : undefined,
    telemetry: robot ? robotLink.latestTelemetry(robot) : null,
  };
  record.updatedAtMs = detection.receivedAtMs;
  record.finishDetections.push(detection);
  record.packetHash = hashEvidencePacket(record);
  raceStore.saveEvidence(record, "evidence.finish_detection");
  return structuredClone(detection);
}

export function listFinishDetections(round: Round): FinishDetectionEvent[] {
  return ensureRecord(round.id).finishDetections.map((event) => structuredClone(event));
}

export function getEvidence(round: Round) {
  const record = ensureRecord(round.id);
  if (!record.packetHash) {
    record.packetHash = hashEvidencePacket(record);
    raceStore.saveEvidence(record, "evidence.hash_refreshed");
  }
  return evidenceResponse(record);
}

export function getEvidenceHash(round: Round) {
  const record = ensureRecord(round.id);
  if (!record.packetHash) {
    record.packetHash = hashEvidencePacket(record);
    raceStore.saveEvidence(record, "evidence.hash_refreshed");
  }
  return {
    roundId: round.id,
    proofHash: record.proofHash ?? round.proofHash ?? null,
    evidenceHash: record.packetHash ?? round.evidenceHash ?? null,
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedClone(value));
}

function ensureRecord(roundId: string): EvidenceRecord {
  let record = records.get(roundId);
  if (!record) {
    const now = Date.now();
    record = {
      roundId,
      createdAtMs: now,
      updatedAtMs: now,
      events: [],
      finishDetections: [],
    };
    records.set(roundId, record);
  }
  record.finishDetections ??= [];
  return record;
}

function buildResultProof(record: EvidenceRecord, round: Round) {
  const slots: DriverSlot[] = ["challenger", "opponent"];
  const telemetry = Object.fromEntries(slots.map((slot) => {
    const driver = round.drivers[slot];
    const robot = driver?.robot;
    return [slot, robot ? telemetryForRobot(robot, round) : { robot: null, start: [], finish: [], latest: null }];
  }));

  return {
    schema: "onchain-rover.race-result-proof.v1",
    roundId: round.id,
    createdAtMs: record.updatedAtMs,
    chainRaceId: round.chainRaceId ?? null,
    result: {
      winner: round.winner ?? null,
      finishMs: round.finishMs ?? null,
      startedAt: round.startedAt ?? null,
      finishedAt: round.finishedAt ?? null,
    },
    lifecycle: record.events
      .filter((event) => event.event !== "settled")
      .map((event) => sortedClone(event)),
    finishDetections: record.finishDetections.map((event) => sortedClone(event)),
    telemetry,
    operatorProof: record.operatorProof ?? null,
  };
}

function telemetryForRobot(robot: RobotName, round: Round) {
  const startAt = round.startedAt ?? round.roundStartsAt ?? Date.now();
  const finishAt = round.finishedAt ?? Date.now();
  return {
    robot,
    start: robotLink.telemetryWindow(robot, startAt - 3000, startAt + 3000),
    finish: robotLink.telemetryWindow(robot, finishAt - 5000, finishAt + 2000),
    latest: robotLink.latestTelemetry(robot),
  };
}

function evidenceResponse(record: EvidenceRecord) {
  const evidence = {
    schema: "onchain-rover.race-evidence-packet.v1",
    roundId: record.roundId,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    proofHash: record.proofHash ?? null,
    evidenceHash: record.packetHash ?? null,
    resultProof: record.resultProof ?? null,
    finishDetections: record.finishDetections,
    lifecycle: record.events,
  };
  return {
    proofHash: record.proofHash ?? null,
    evidenceHash: record.packetHash ?? null,
    canonical: canonicalJson(packetForHash(record)),
    evidence,
  };
}

function hashEvidencePacket(record: EvidenceRecord): Hex32 {
  return sha256Hex(canonicalJson(packetForHash(record)));
}

function packetForHash(record: EvidenceRecord) {
  return {
    schema: "onchain-rover.race-evidence-packet.v1",
    roundId: record.roundId,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    proofHash: record.proofHash ?? null,
    resultProof: record.resultProof ?? null,
    finishDetections: record.finishDetections,
    lifecycle: record.events,
  };
}

function sha256Hex(value: string): Hex32 {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function sanitizeRound(round: Round) {
  return {
    id: round.id,
    status: round.status,
    chainStatus: round.chainStatus ?? null,
    chainRaceId: round.chainRaceId ?? null,
    stakeUsdc: round.stakeUsdc,
    feeUsdc: round.feeUsdc,
    durationSecs: round.durationSecs,
    countdownSecs: round.countdownSecs,
    createdAt: round.createdAt,
    lockedAt: round.lockedAt ?? null,
    roundStartsAt: round.roundStartsAt ?? null,
    startedAt: round.startedAt ?? null,
    finishedAt: round.finishedAt ?? null,
    finishMs: round.finishMs ?? null,
    winner: round.winner ?? null,
    proofHash: round.proofHash ?? null,
    evidenceHash: round.evidenceHash ?? null,
    txHashes: round.txHashes ?? {},
    drivers: {
      challenger: sanitizeDriver(round, "challenger"),
      opponent: sanitizeDriver(round, "opponent"),
    },
  };
}

function sanitizeDriver(round: Round, slot: DriverSlot) {
  const driver = round.drivers[slot];
  if (!driver) return null;
  return {
    slot,
    wallet: driver.wallet,
    displayName: driver.displayName ?? null,
    robot: driver.robot ?? null,
    lane: driver.lane ?? null,
    feePaid: driver.feePaid,
    stakeAuthorized: driver.stakeAuthorized,
    chainJoined: Boolean(driver.chainJoined),
    joinedTx: driver.joinedTx ?? null,
  };
}

function eventTime(round: Round, event: EvidenceEventName): number | undefined {
  if (event === "locked") return round.lockedAt;
  if (event === "started") return round.startedAt;
  if (event === "finished") return round.finishedAt;
  if (event === "settled") return Date.now();
  return undefined;
}

function inferDetectionSlot(round: Round, input: FinishDetectionInput): DriverSlot {
  const slot = parseSlot(input.slot);
  const robot = parseRobot(input.robot);
  if (!slot && !robot) throw new Error("finish detection requires slot or robot");
  const inferredSlot = slot ?? slotForRobot(round, robot!);
  const driver = round.drivers[inferredSlot];
  if (!driver) throw new Error(`missing ${inferredSlot}`);
  if (robot && driver.robot !== robot) {
    throw new Error(`robot ${robot} is not assigned to ${inferredSlot}`);
  }
  return inferredSlot;
}

function slotForRobot(round: Round, robot: RobotName): DriverSlot {
  for (const slot of ["challenger", "opponent"] as const) {
    if (round.drivers[slot]?.robot === robot) return slot;
  }
  throw new Error(`robot ${robot} is not assigned to this round`);
}

function parseSlot(value: unknown): DriverSlot | null {
  if (value === "challenger" || value === "opponent") return value;
  if (value === undefined || value === null || value === "") return null;
  throw new Error("slot must be challenger or opponent");
}

function parseRobot(value: unknown): RobotName | null {
  if (value === "guard" || value === "courier") return value;
  if (value === undefined || value === null || value === "") return null;
  throw new Error("robot must be guard or courier");
}

function confidence(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("confidence must be numeric");
  return Math.max(0, Math.min(1, number));
}

function millisOrNow(value: unknown): number {
  if (value === undefined || value === null || value === "") return Date.now();
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("detectedAtMs must be a positive timestamp");
  return Math.floor(number);
}

function stringOr(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function sortedClone(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortedClone);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = sortedClone(item);
  }
  return out;
}
