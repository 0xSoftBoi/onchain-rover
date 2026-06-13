import { randomUUID } from "node:crypto";

import { ROBOTS, type RobotName } from "./config.js";
import * as raceStore from "./race-store.js";

export type RoundStatus =
  | "challenge"
  | "accepted"
  | "ready"
  | "locked"
  | "countdown"
  | "racing"
  | "finished"
  | "settled"
  | "canceled";

export type DriverSlot = "challenger" | "opponent";

export type Driver = {
  wallet: string;
  displayName?: string;
  feePaid: boolean;
  stakeAuthorized: boolean;
  chainJoined?: boolean;
  entrySignature?: string;
  permitSignature?: string;
  joinedTx?: string;
  robot?: RobotName;
  lane?: "left" | "right";
  token?: string;
};

export type ChainRoundStatus =
  | "not-opened"
  | "opened"
  | "joined"
  | "locked"
  | "started"
  | "finished"
  | "settled"
  | "canceled";

export type Round = {
  id: string;
  status: RoundStatus;
  stakeUsdc: string;
  feeUsdc: string;
  durationSecs: number;
  countdownSecs: number;
  challengeExpiresAt: number;
  createdAt: number;
  acceptedAt?: number;
  lockedAt?: number;
  countdownStartedAt?: number;
  roundStartsAt?: number;
  startedAt?: number;
  finishedAt?: number;
  settledAt?: number;
  canceledAt?: number;
  cancelReason?: string;
  winner?: DriverSlot;
  finishMs?: number;
  proof?: Record<string, unknown>;
  proofHash?: string;
  evidenceHash?: string;
  chainRaceId?: string;
  chainStatus?: ChainRoundStatus;
  txHashes?: Partial<Record<
    | "open"
    | "challengerJoin"
    | "opponentJoin"
    | "lock"
    | "start"
    | "finish"
    | "settle"
    | "cancel",
    string
  >>;
  drivers: Partial<Record<DriverSlot, Driver>>;
};

type CreateRoundInput = {
  wallet?: string;
  displayName?: string;
  stakeUsdc?: string;
  feeUsdc?: string;
  durationSecs?: number;
  countdownSecs?: number;
  challengeTtlSecs?: number;
};

type AcceptRoundInput = {
  wallet: string;
  displayName?: string;
};

type ClaimSlotInput = {
  wallet: string;
  displayName?: string;
};

const rounds = new Map<string, Round>();
for (const round of raceStore.loadRounds()) rounds.set(round.id, round);

const DEFAULT_STAKE_USDC = "1.00";
const DEFAULT_FEE_USDC = process.env.RACE_NETWORK_FEE_USDC ?? "0.25";
const DEFAULT_DURATION_SECS = 30;
const DEFAULT_COUNTDOWN_SECS = 3;
const DEFAULT_CHALLENGE_TTL_SECS = 60;

const ROBOT_ASSIGNMENT: Record<DriverSlot, RobotName> = {
  challenger: "guard",
  opponent: "courier",
};
const LANE_ASSIGNMENT: Record<DriverSlot, "left" | "right"> = {
  challenger: "left",
  opponent: "right",
};

export function createRound(input: CreateRoundInput): Round {
  const now = Date.now();
  const wallet = input.wallet ? normalizeWallet(input.wallet) : "";
  const round: Round = {
    id: randomUUID().slice(0, 8),
    status: wallet ? "challenge" : "accepted",
    chainStatus: "not-opened",
    stakeUsdc: input.stakeUsdc ?? DEFAULT_STAKE_USDC,
    feeUsdc: input.feeUsdc ?? DEFAULT_FEE_USDC,
    durationSecs: clampInt(input.durationSecs, 5, 300, DEFAULT_DURATION_SECS),
    countdownSecs: clampInt(input.countdownSecs, 1, 10, DEFAULT_COUNTDOWN_SECS),
    challengeExpiresAt:
      now + clampInt(input.challengeTtlSecs, 5, 600, DEFAULT_CHALLENGE_TTL_SECS) * 1000,
    createdAt: now,
    drivers: {
      challenger: {
        wallet,
        displayName: input.displayName,
        feePaid: false,
        stakeAuthorized: false,
        robot: ROBOT_ASSIGNMENT.challenger,
        lane: LANE_ASSIGNMENT.challenger,
      },
      opponent: wallet
        ? undefined
        : {
            wallet: "",
            feePaid: false,
            stakeAuthorized: false,
            robot: ROBOT_ASSIGNMENT.opponent,
            lane: LANE_ASSIGNMENT.opponent,
          },
    },
  };
  rounds.set(round.id, round);
  return persistSnapshot(round, "round.created");
}

export function acceptRound(id: string, input: AcceptRoundInput): Round {
  const round = getMutableRound(id);
  requireStatus(round, "challenge");
  requireNotExpired(round);
  const wallet = normalizeWallet(input.wallet);
  if (wallet === round.drivers.challenger?.wallet) {
    throw new Error("opponent must be a different wallet");
  }
  round.drivers.opponent = {
    wallet,
    displayName: input.displayName,
    feePaid: false,
    stakeAuthorized: false,
    robot: ROBOT_ASSIGNMENT.opponent,
    lane: LANE_ASSIGNMENT.opponent,
  };
  round.status = "accepted";
  round.acceptedAt = Date.now();
  return persistSnapshot(round, "round.accepted");
}

export function claimSlot(id: string, slot: DriverSlot, input: ClaimSlotInput): Round {
  const round = getMutableRound(id);
  if (round.status !== "challenge" && round.status !== "accepted" && round.status !== "ready") {
    throw new Error(`cannot claim slot in ${round.status}`);
  }
  const wallet = normalizeWallet(input.wallet);
  let driver = round.drivers[slot];
  if (!driver) {
    driver = {
      wallet: "",
      feePaid: false,
      stakeAuthorized: false,
      robot: ROBOT_ASSIGNMENT[slot],
      lane: LANE_ASSIGNMENT[slot],
    };
    round.drivers[slot] = driver;
  }
  if (driver.chainJoined) throw new Error(`${slot} already joined on-chain`);
  if (driver.wallet && driver.wallet !== wallet) {
    throw new Error(`${slot} already claimed by a different wallet`);
  }
  const otherSlot: DriverSlot = slot === "challenger" ? "opponent" : "challenger";
  const other = round.drivers[otherSlot];
  if (other?.wallet === wallet) throw new Error("wallet already claimed the other slot");

  driver.wallet = wallet;
  driver.displayName = input.displayName ?? driver.displayName;
  if (round.drivers.challenger?.wallet && round.drivers.opponent?.wallet && round.status === "challenge") {
    round.status = "accepted";
    round.acceptedAt = Date.now();
  }
  return persistSnapshot(round, `round.${slot}_claimed`);
}

export function markFeePaid(id: string, slot: DriverSlot, payment?: Record<string, unknown>): Round {
  const round = getMutableRound(id);
  requireJoinable(round);
  const driver = requireDriver(round, slot);
  driver.feePaid = true;
  if (payment) {
    driver.displayName ??= String(payment.displayName ?? "");
  }
  updateReady(round);
  return persistSnapshot(round, `round.${slot}_fee_paid`);
}

export function authorizeStake(id: string, slot: DriverSlot, authorization?: Record<string, unknown>): Round {
  const round = getMutableRound(id);
  requireJoinable(round);
  const driver = requireDriver(round, slot);
  driver.stakeAuthorized = true;
  if (authorization?.entrySignature) driver.entrySignature = String(authorization.entrySignature);
  if (authorization?.permitSignature) driver.permitSignature = String(authorization.permitSignature);
  if (authorization?.displayName && !driver.displayName) {
    driver.displayName = String(authorization.displayName);
  }
  updateReady(round);
  return persistSnapshot(round, `round.${slot}_stake_authorized`);
}

export async function lockRound(id: string, robotUrl: (name: RobotName) => string): Promise<Round> {
  const round = getMutableRound(id);
  if (round.status !== "ready") throw new Error("round is not ready");
  if (round.chainRaceId && round.chainStatus !== "locked") {
    throw new Error("on-chain round must be locked before robot authorization");
  }
  round.status = "locked";
  round.lockedAt = Date.now();
  await authorizeRobots(round, robotUrl);
  return persistSnapshot(round, "round.locked");
}

export function lockRoundLocal(id: string): Round {
  const round = getMutableRound(id);
  if (round.status !== "ready") throw new Error("round is not ready");
  if (round.chainRaceId && round.chainStatus !== "locked") {
    throw new Error("on-chain round must be locked before local lock");
  }
  round.status = "locked";
  round.lockedAt = Date.now();
  return persistSnapshot(round, "round.locked");
}

export function startCountdown(id: string): Round {
  const round = getMutableRound(id);
  requireStatus(round, "locked");
  const now = Date.now();
  round.status = "countdown";
  round.countdownStartedAt = now;
  round.roundStartsAt = now + round.countdownSecs * 1000;
  return persistSnapshot(round, "round.countdown_started");
}

export function startRace(id: string): Round {
  const round = getMutableRound(id);
  requireStatus(round, "countdown");
  if ((round.roundStartsAt ?? 0) > Date.now()) throw new Error("countdown has not finished");
  round.status = "racing";
  round.startedAt = Date.now();
  return persistSnapshot(round, "round.started");
}

export function finishRound(id: string, winner: DriverSlot, proof?: Record<string, unknown>): Round {
  const round = getMutableRound(id);
  requireStatus(round, "racing");
  requireDriver(round, winner);
  round.status = "finished";
  round.winner = winner;
  round.finishedAt = Date.now();
  round.finishMs = round.finishedAt - (round.startedAt ?? round.finishedAt);
  round.proof = proof;
  return persistSnapshot(round, "round.finished");
}

export function markEvidenceHashes(id: string, proofHash?: string | null, evidenceHash?: string | null): Round {
  const round = getMutableRound(id);
  if (proofHash) round.proofHash = proofHash;
  if (evidenceHash) round.evidenceHash = evidenceHash;
  return persistSnapshot(round, "round.evidence_hashes");
}

export function attachChainRace(id: string, chainRaceId: string, txHash: string): Round {
  const round = getMutableRound(id);
  if (round.chainRaceId && round.chainRaceId !== chainRaceId) {
    throw new Error("round already has a different chain race id");
  }
  round.chainRaceId = chainRaceId;
  round.chainStatus = "opened";
  round.txHashes ??= {};
  round.txHashes.open = txHash;
  return persistSnapshot(round, "round.chain_opened");
}

export function markChainJoined(
  id: string,
  slot: DriverSlot,
  txHash: string,
  authorization?: { entrySignature?: string; permitSignature?: string }
): Round {
  const round = getMutableRound(id);
  const driver = requireDriver(round, slot);
  driver.chainJoined = true;
  driver.feePaid = true;
  driver.stakeAuthorized = true;
  if (authorization?.entrySignature) driver.entrySignature = authorization.entrySignature;
  if (authorization?.permitSignature) driver.permitSignature = authorization.permitSignature;
  driver.joinedTx = txHash;
  round.txHashes ??= {};
  round.txHashes[slot === "challenger" ? "challengerJoin" : "opponentJoin"] = txHash;
  const challenger = round.drivers.challenger;
  const opponent = round.drivers.opponent;
  round.chainStatus = challenger?.chainJoined && opponent?.chainJoined ? "joined" : "opened";
  updateReady(round);
  return persistSnapshot(round, `round.${slot}_chain_joined`);
}

export function markChainLocked(id: string, txHash: string): Round {
  const round = getMutableRound(id);
  if (round.chainStatus !== "joined") throw new Error("on-chain round is not joined");
  round.chainStatus = "locked";
  round.txHashes ??= {};
  round.txHashes.lock = txHash;
  return persistSnapshot(round, "round.chain_locked");
}

export function markChainStarted(id: string, txHash: string): Round {
  const round = getMutableRound(id);
  if (round.chainStatus !== "locked") throw new Error("on-chain round is not locked");
  round.chainStatus = "started";
  round.txHashes ??= {};
  round.txHashes.start = txHash;
  return persistSnapshot(round, "round.chain_started");
}

export function markChainFinished(id: string, txHash: string): Round {
  const round = getMutableRound(id);
  if (round.chainStatus !== "started") throw new Error("on-chain round is not started");
  round.chainStatus = "finished";
  round.txHashes ??= {};
  round.txHashes.finish = txHash;
  return persistSnapshot(round, "round.chain_finished");
}

export function markChainSettled(id: string, txHash: string): Round {
  const round = getMutableRound(id);
  if (round.status !== "finished" && round.status !== "settled") {
    throw new Error("local round must be finished before settlement");
  }
  round.chainStatus = "settled";
  round.status = "settled";
  round.settledAt = Date.now();
  round.txHashes ??= {};
  round.txHashes.settle = txHash;
  return persistSnapshot(round, "round.chain_settled");
}

export function markChainCanceled(id: string, txHash: string, reason = "canceled on-chain"): Round {
  const round = getMutableRound(id);
  round.chainStatus = "canceled";
  round.status = "canceled";
  round.canceledAt = Date.now();
  round.cancelReason = reason;
  round.txHashes ??= {};
  round.txHashes.cancel = txHash;
  return persistSnapshot(round, "round.chain_canceled");
}

export function cancelRound(id: string, reason = "canceled"): Round {
  const round = getMutableRound(id);
  if (["finished", "settled", "canceled"].includes(round.status)) {
    throw new Error(`cannot cancel round in ${round.status}`);
  }
  round.status = "canceled";
  round.canceledAt = Date.now();
  round.cancelReason = reason;
  return persistSnapshot(round, "round.canceled");
}

export function getRound(id: string): Round {
  return snapshot(getMutableRound(id));
}

export function listRounds(): Round[] {
  return [...rounds.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(snapshot);
}

function updateReady(round: Round) {
  if (round.status !== "accepted" && round.status !== "ready") return;
  const challenger = round.drivers.challenger;
  const opponent = round.drivers.opponent;
  if (
    challenger?.feePaid &&
    challenger.stakeAuthorized &&
    opponent?.feePaid &&
    opponent.stakeAuthorized
  ) {
    round.status = "ready";
  }
}

async function authorizeRobots(round: Round, robotUrl: (name: RobotName) => string) {
  const roundStartsAt = Date.now() + round.countdownSecs * 1000;
  round.roundStartsAt = roundStartsAt;
  for (const slot of ["challenger", "opponent"] as const) {
    const driver = requireDriver(round, slot);
    const robot = driver.robot;
    if (!robot) throw new Error(`missing robot for ${slot}`);
    driver.token = randomUUID();
    const res = await fetch(`${robotUrl(robot)}/pilot/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: driver.token,
        ttl_secs: round.durationSecs + round.countdownSecs + 15,
        speed_mode: "medium",
        not_before_epoch_ms: roundStartsAt,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      throw new Error(`robot ${robot} authorization failed: ${res.status}`);
    }
  }
}

function requireJoinable(round: Round) {
  if (round.status !== "accepted" && round.status !== "ready") {
    throw new Error(`round is not joinable in ${round.status}`);
  }
}

function requireStatus(round: Round, status: RoundStatus) {
  if (round.status !== status) throw new Error(`expected ${status}, got ${round.status}`);
}

function requireNotExpired(round: Round) {
  if (round.challengeExpiresAt < Date.now()) throw new Error("challenge expired");
}

function requireDriver(round: Round, slot: DriverSlot): Driver {
  const driver = round.drivers[slot];
  if (!driver) throw new Error(`missing ${slot}`);
  return driver;
}

function getMutableRound(id: string): Round {
  const round = rounds.get(id);
  if (!round) throw new Error("round not found");
  return round;
}

function normalizeWallet(wallet?: string): string {
  const trimmed = (wallet ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    throw new Error("valid EVM wallet required");
  }
  return trimmed.toLowerCase();
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(Number(value))));
}

function snapshot(round: Round): Round {
  return structuredClone(round);
}

function persistSnapshot(round: Round, kind: string): Round {
  raceStore.saveRound(round, kind);
  return snapshot(round);
}
