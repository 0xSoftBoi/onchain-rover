import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Round } from "./rounds.js";
import type { EvidenceRecord } from "./evidence.js";

type PersistedEvent = {
  schema: "onchain-rover.race-ledger-event.v1";
  atMs: number;
  kind: string;
  roundId: string;
  payload: unknown;
};

const DEFAULT_DATA_DIR = new URL("../data/races", import.meta.url).pathname;
const dataDir = process.env.RACE_DATA_DIR || DEFAULT_DATA_DIR;

export function raceDataDir() {
  return dataDir;
}

export function loadRounds(): Round[] {
  return readRaceDirectories()
    .map((roundId) => readJson<Round>(roundFile(roundId)))
    .filter((round): round is Round => Boolean(round?.id));
}

export function loadEvidenceRecords(): EvidenceRecord[] {
  return readRaceDirectories()
    .map((roundId) => readJson<EvidenceRecord>(evidenceFile(roundId)))
    .filter((record): record is EvidenceRecord => Boolean(record?.roundId));
}

export function saveRound(round: Round, kind: string) {
  const persisted = sanitizeRoundForDisk(round);
  writeJsonAtomic(roundFile(round.id), persisted);
  appendEvent(round.id, kind, persisted);
}

export function saveEvidence(record: EvidenceRecord, kind: string) {
  writeJsonAtomic(evidenceFile(record.roundId), record);
  appendEvent(record.roundId, kind, record);
}

export function persistedRoundPaths(roundId: string) {
  return {
    dir: roundDir(roundId),
    round: roundFile(roundId),
    evidence: evidenceFile(roundId),
    events: eventsFile(roundId),
  };
}

function appendEvent(roundId: string, kind: string, payload: unknown) {
  const event: PersistedEvent = {
    schema: "onchain-rover.race-ledger-event.v1",
    atMs: Date.now(),
    kind,
    roundId,
    payload,
  };
  ensureDir(eventsFile(roundId));
  appendFileSync(eventsFile(roundId), `${JSON.stringify(event)}\n`);
}

function writeJsonAtomic(file: string, value: unknown) {
  ensureDir(file);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function readRaceDirectories() {
  try {
    return readdirSync(dataDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafeRoundId(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function roundDir(roundId: string) {
  const safe = safeRoundId(roundId);
  return join(dataDir, safe);
}

function roundFile(roundId: string) {
  return join(roundDir(roundId), "round.json");
}

function evidenceFile(roundId: string) {
  return join(roundDir(roundId), "evidence.json");
}

function eventsFile(roundId: string) {
  return join(roundDir(roundId), "events.jsonl");
}

function ensureDir(file: string) {
  mkdirSync(dirname(file), { recursive: true });
}

function safeRoundId(roundId: string) {
  if (!isSafeRoundId(roundId)) throw new Error("unsafe round id");
  return roundId;
}

function isSafeRoundId(roundId: string) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(roundId);
}

function sanitizeRoundForDisk(round: Round): Round {
  const copy = structuredClone(round);
  for (const driver of Object.values(copy.drivers)) {
    if (!driver) continue;
    delete driver.token;
    delete driver.entrySignature;
    delete driver.permitSignature;
  }
  return copy;
}
