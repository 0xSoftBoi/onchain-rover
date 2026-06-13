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
export type LaneName = "left" | "right";
export type SpeedMode = "low" | "medium" | "high";

export type Driver = {
  wallet: string;
  displayName?: string;
  feePaid: boolean;
  feePayment?: FeePayment;
  stakeAuthorized: boolean;
  stakeAuthorization?: StakeAuthorization;
  chainJoined?: boolean;
  entrySignature?: string;
  permitSignature?: string;
  joinedTx?: string;
  robot?: RobotName;
  lane?: LaneName;
  token?: string;
};

export type FeePayment = {
  status: "paid" | "pending" | "failed";
  source: "x402" | "local-chain" | "manual";
  amountUsdc: string;
  amountUnits?: string;
  recipientTreasury?: string;
  paymentId?: string;
  txHash?: string;
  payer?: string;
  paidAt?: number;
  reconciliationStatus?: "pending" | "reconciled" | "needs-proof" | "failed";
};

export type StakeAuthorization = {
  adapter: "base-spend-permission" | "local-chain-escrow" | "manual";
  status: "verified" | "settled" | "failed";
  roundId: string;
  token?: string;
  spender?: string;
  amountUsdc: string;
  amountUnits?: string;
  permissionHash?: string;
  permission?: Record<string, unknown>;
  signature?: string;
  txHash?: string;
  verifiedAt?: number;
  expiresAt?: number;
  settlement?: Record<string, unknown>;
};

export type CancelCode =
  | "operator_cancel"
  | "missing_second_driver"
  | "unpaid_join"
  | "missing_stake_authorization"
  | "robot_health_failure"
  | "expired_lobby"
  | "chain_cancel"
  | "unknown";

export type Cancellation = {
  code: CancelCode;
  reason: string;
  canceledAt: number;
  feePolicy: string;
  stakePolicy: string;
  drivers: Record<DriverSlot, {
    wallet?: string;
    feePaid: boolean;
    feeSource?: FeePayment["source"];
    feeStatus: FeePayment["status"] | "unpaid";
    stakeAuthorized: boolean;
    stakeAdapter?: StakeAuthorization["adapter"];
    stakeStatus: "none" | "active" | "expired" | "escrowed";
    stakeExpiresAt?: number;
  }>;
};

export type SettlementState = {
  status: "blocked" | "ready" | "settled" | "canceled";
  reason: string;
  updatedAt: number;
  txHash?: string;
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

export type StageCalibration = {
  schema: "onchain-rover.stage-calibration.v1";
  units: "ft";
  laneLengthFt: number;
  laneWidthFt: number;
  startLineFt: number;
  finishLineFt: number;
  robotAssignments: Record<DriverSlot, { robot: RobotName; lane: LaneName }>;
  sensorOffsets: Record<RobotName, {
    cameraForwardFt: number;
    cameraRightFt: number;
    lidarForwardFt: number;
    lidarRightFt: number;
  }>;
  speedDefaults: {
    defaultSpeedMode: SpeedMode;
    maxSpeedMode: SpeedMode;
  };
  safetyDefaults: {
    obstacleStopDistanceFt: number;
    warningDistanceFt: number;
  };
  updatedAt: number;
};

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
  cancellation?: Cancellation;
  winner?: DriverSlot;
  finishMs?: number;
  proof?: Record<string, unknown>;
  telemetryTraceId?: string;
  settlementState?: SettlementState;
  proofHash?: string;
  evidenceHash?: string;
  chainRaceId?: string;
  chainStatus?: ChainRoundStatus;
  stageCalibration: StageCalibration;
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
  stageCalibration?: Record<string, unknown>;
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
const LANE_ASSIGNMENT: Record<DriverSlot, LaneName> = {
  challenger: "left",
  opponent: "right",
};

const SPEED_RANK: Record<SpeedMode, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function createRound(input: CreateRoundInput): Round {
  const now = Date.now();
  const wallet = input.wallet ? normalizeWallet(input.wallet) : "";
  const stageCalibration = normalizeStageCalibration(input.stageCalibration, undefined, now);
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
    settlementState: {
      status: "blocked",
      reason: "winner confirmation required",
      updatedAt: now,
    },
    stageCalibration,
    drivers: {
      challenger: {
        wallet,
        displayName: input.displayName,
        feePaid: false,
        stakeAuthorized: false,
        robot: stageCalibration.robotAssignments.challenger.robot,
        lane: stageCalibration.robotAssignments.challenger.lane,
      },
      opponent: wallet
        ? undefined
        : {
            wallet: "",
            feePaid: false,
            stakeAuthorized: false,
            robot: stageCalibration.robotAssignments.opponent.robot,
            lane: stageCalibration.robotAssignments.opponent.lane,
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
    robot: round.stageCalibration.robotAssignments.opponent.robot,
    lane: round.stageCalibration.robotAssignments.opponent.lane,
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
      robot: round.stageCalibration.robotAssignments[slot].robot,
      lane: round.stageCalibration.robotAssignments[slot].lane,
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
  driver.feePayment = normalizeFeePayment(round, payment);
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
  driver.stakeAuthorization = normalizeStakeAuthorization(round, authorization);
  if (authorization?.entrySignature) driver.entrySignature = String(authorization.entrySignature);
  if (authorization?.permitSignature) driver.permitSignature = String(authorization.permitSignature);
  if (authorization?.displayName && !driver.displayName) {
    driver.displayName = String(authorization.displayName);
  }
  updateReady(round);
  return persistSnapshot(round, `round.${slot}_stake_authorized`);
}

export function getStageCalibration(id: string): StageCalibration {
  const round = getMutableRound(id);
  round.stageCalibration ??= normalizeStageCalibration(undefined, undefined, Date.now());
  applyCalibrationAssignments(round);
  return structuredClone(round.stageCalibration);
}

export function updateStageCalibration(id: string, input?: Record<string, unknown>): Round {
  const round = getMutableRound(id);
  requireCalibrationEditable(round);
  round.stageCalibration = normalizeStageCalibration(input, round.stageCalibration, Date.now());
  applyCalibrationAssignments(round);
  return persistSnapshot(round, "round.stage_calibrated");
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
  const finishedAt = Date.now();
  const telemetryTraceId = finishTelemetryTraceId(round, proof, finishedAt);
  round.status = "finished";
  round.winner = winner;
  round.finishedAt = finishedAt;
  round.finishMs = round.finishedAt - (round.startedAt ?? round.finishedAt);
  round.telemetryTraceId = telemetryTraceId;
  round.proof = normalizeFinishProof(round, winner, proof, telemetryTraceId, finishedAt);
  round.settlementState = {
    status: "ready",
    reason: "winner confirmed",
    updatedAt: finishedAt,
  };
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
  const paidAt = Date.now();
  driver.chainJoined = true;
  driver.feePaid = true;
  driver.feePayment = {
    status: "paid",
    source: "local-chain",
    amountUsdc: round.feeUsdc,
    txHash,
    paidAt,
    reconciliationStatus: "reconciled",
  };
  driver.stakeAuthorized = true;
  driver.stakeAuthorization = {
    adapter: "local-chain-escrow",
    status: "verified",
    roundId: round.id,
    amountUsdc: round.stakeUsdc,
    txHash: txHash,
    verifiedAt: paidAt,
  };
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
  round.settlementState = {
    status: "settled",
    reason: "settlement submitted",
    updatedAt: round.settledAt,
    txHash,
  };
  round.txHashes ??= {};
  round.txHashes.settle = txHash;
  return persistSnapshot(round, "round.chain_settled");
}

export function markChainCanceled(id: string, txHash: string, reason = "canceled on-chain"): Round {
  const round = getMutableRound(id);
  round.chainStatus = "canceled";
  round.status = "canceled";
  applyCancellation(round, { code: "chain_cancel", reason });
  round.settlementState = {
    status: "canceled",
    reason,
    updatedAt: round.canceledAt ?? Date.now(),
    txHash,
  };
  round.txHashes ??= {};
  round.txHashes.cancel = txHash;
  return persistSnapshot(round, "round.chain_canceled");
}

export function cancelRound(id: string, input?: string | { reason?: string; code?: string }): Round {
  const round = getMutableRound(id);
  if (["finished", "settled", "canceled"].includes(round.status)) {
    throw new Error(`cannot cancel round in ${round.status}`);
  }
  const cancelInput = normalizeCancelInput(round, input);
  round.status = "canceled";
  applyCancellation(round, cancelInput);
  round.settlementState = {
    status: "canceled",
    reason: cancelInput.reason,
    updatedAt: round.canceledAt ?? Date.now(),
  };
  return persistSnapshot(round, "round.canceled");
}

export function getRound(id: string): Round {
  return snapshot(getMutableRound(id));
}

export function listRounds(): Round[] {
  return [...rounds.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((round) => {
      round.stageCalibration ??= normalizeStageCalibration(undefined, undefined, Date.now());
      applyCalibrationAssignments(round);
      return snapshot(round);
    });
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

function normalizeCancelInput(
  round: Round,
  input?: string | { reason?: string; code?: string },
): { code: CancelCode; reason: string } {
  if (typeof input === "string") {
    return { code: inferCancelCode(round, input), reason: input || "canceled" };
  }
  const reason = firstString(input?.reason) ?? "canceled";
  const code = parseCancelCode(input?.code) ?? inferCancelCode(round, reason);
  return { code, reason };
}

function applyCancellation(round: Round, input: { code: CancelCode; reason: string }) {
  const canceledAt = Date.now();
  round.canceledAt = canceledAt;
  round.cancelReason = input.reason;
  round.cancellation = buildCancellation(round, input.code, input.reason, canceledAt);
}

function buildCancellation(
  round: Round,
  code: CancelCode,
  reason: string,
  canceledAt: number,
): Cancellation {
  return {
    code,
    reason,
    canceledAt,
    feePolicy: feePolicy(round),
    stakePolicy: "canceled rounds do not settle delegated stake permissions",
    drivers: {
      challenger: cancelDriverSummary(round.drivers.challenger, canceledAt),
      opponent: cancelDriverSummary(round.drivers.opponent, canceledAt),
    },
  };
}

function cancelDriverSummary(driver: Driver | undefined, canceledAt: number): Cancellation["drivers"][DriverSlot] {
  const auth = driver?.stakeAuthorization;
  return {
    wallet: driver?.wallet || undefined,
    feePaid: Boolean(driver?.feePaid),
    feeSource: driver?.feePayment?.source,
    feeStatus: driver?.feePayment?.status ?? (driver?.feePaid ? "paid" : "unpaid"),
    stakeAuthorized: Boolean(driver?.stakeAuthorized),
    stakeAdapter: auth?.adapter,
    stakeStatus: stakeCancelStatus(auth, canceledAt),
    stakeExpiresAt: auth?.expiresAt,
  };
}

function stakeCancelStatus(
  authorization: StakeAuthorization | undefined,
  canceledAt: number,
): Cancellation["drivers"][DriverSlot]["stakeStatus"] {
  if (!authorization) return "none";
  if (authorization.adapter === "local-chain-escrow") return "escrowed";
  if (authorization.expiresAt && authorization.expiresAt <= canceledAt) return "expired";
  return "active";
}

function feePolicy(round: Round): string {
  const drivers = [round.drivers.challenger, round.drivers.opponent].filter((driver): driver is Driver => Boolean(driver));
  if (drivers.some((driver) => driver.feePayment?.source === "x402")) {
    return "x402 race fees stay paid to the fleet treasury; matched stake is not settled";
  }
  if (drivers.some((driver) => driver.feePaid)) {
    return "recorded local or manual fees remain audit entries; matched stake is not settled";
  }
  return "no driver fee was paid";
}

function inferCancelCode(round: Round, reason: string): CancelCode {
  const lowerReason = reason.toLowerCase();
  if (lowerReason.includes("robot") || lowerReason.includes("health")) return "robot_health_failure";
  if (round.status === "challenge") {
    return round.challengeExpiresAt < Date.now() ? "expired_lobby" : "missing_second_driver";
  }
  const drivers = [round.drivers.challenger, round.drivers.opponent];
  if (drivers.some((driver) => !driver?.feePaid)) return "unpaid_join";
  if (drivers.some((driver) => !driver?.stakeAuthorized)) return "missing_stake_authorization";
  return "operator_cancel";
}

function parseCancelCode(value: unknown): CancelCode | undefined {
  if (
    value === "operator_cancel" ||
    value === "missing_second_driver" ||
    value === "unpaid_join" ||
    value === "missing_stake_authorization" ||
    value === "robot_health_failure" ||
    value === "expired_lobby" ||
    value === "chain_cancel" ||
    value === "unknown"
  ) return value;
  return undefined;
}

async function authorizeRobots(round: Round, robotUrl: (name: RobotName) => string) {
  const roundStartsAt = Date.now() + round.countdownSecs * 1000;
  const roundEndsAt = roundStartsAt + round.durationSecs * 1000;
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
        speed_mode: round.stageCalibration.speedDefaults.defaultSpeedMode,
        not_before_epoch_ms: roundStartsAt,
        not_after_epoch_ms: roundEndsAt,
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

function requireCalibrationEditable(round: Round) {
  if (["locked", "countdown", "racing", "finished", "settled", "canceled"].includes(round.status)) {
    throw new Error(`cannot calibrate stage in ${round.status}`);
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
  round.stageCalibration ??= normalizeStageCalibration(undefined, undefined, Date.now());
  applyCalibrationAssignments(round);
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

function normalizeStageCalibration(
  input?: Record<string, unknown>,
  base?: StageCalibration,
  updatedAt = Date.now(),
): StageCalibration {
  const merged = { ...(base ?? defaultStageCalibration(updatedAt)), ...(input ?? {}) };
  const laneLengthFt = finiteNumber(merged.laneLengthFt, 60, 5, 500);
  const laneWidthFt = finiteNumber(merged.laneWidthFt, 4, 1, 40);
  const startLineFt = finiteNumber(merged.startLineFt, 0, 0, laneLengthFt - 1);
  const finishLineFt = finiteNumber(merged.finishLineFt, laneLengthFt, startLineFt + 1, laneLengthFt);
  const robotAssignments = normalizeRobotAssignments(merged.robotAssignments);
  const sensorOffsets = normalizeSensorOffsets(merged.sensorOffsets);
  const speedDefaults = normalizeSpeedDefaults(merged.speedDefaults);
  const safetyDefaults = normalizeSafetyDefaults(merged.safetyDefaults);
  return {
    schema: "onchain-rover.stage-calibration.v1",
    units: "ft",
    laneLengthFt,
    laneWidthFt,
    startLineFt,
    finishLineFt,
    robotAssignments,
    sensorOffsets,
    speedDefaults,
    safetyDefaults,
    updatedAt,
  };
}

function defaultStageCalibration(updatedAt = Date.now()): StageCalibration {
  return {
    schema: "onchain-rover.stage-calibration.v1",
    units: "ft",
    laneLengthFt: 60,
    laneWidthFt: 4,
    startLineFt: 0,
    finishLineFt: 60,
    robotAssignments: {
      challenger: { robot: ROBOT_ASSIGNMENT.challenger, lane: LANE_ASSIGNMENT.challenger },
      opponent: { robot: ROBOT_ASSIGNMENT.opponent, lane: LANE_ASSIGNMENT.opponent },
    },
    sensorOffsets: {
      guard: { cameraForwardFt: 0, cameraRightFt: 0, lidarForwardFt: 0, lidarRightFt: 0 },
      courier: { cameraForwardFt: 0, cameraRightFt: 0, lidarForwardFt: 0, lidarRightFt: 0 },
    },
    speedDefaults: { defaultSpeedMode: "medium", maxSpeedMode: "medium" },
    safetyDefaults: { obstacleStopDistanceFt: 2, warningDistanceFt: 5 },
    updatedAt,
  };
}

function normalizeRobotAssignments(value: unknown): StageCalibration["robotAssignments"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const challenger = normalizeSlotAssignment(input.challenger, "challenger");
  const opponent = normalizeSlotAssignment(input.opponent, "opponent");
  if (challenger.robot === opponent.robot) throw new Error("challenger and opponent must use different robots");
  if (challenger.lane === opponent.lane) throw new Error("challenger and opponent must use different lanes");
  return { challenger, opponent };
}

function normalizeSlotAssignment(value: unknown, slot: DriverSlot): { robot: RobotName; lane: LaneName } {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    robot: parseRobotName(input.robot) ?? ROBOT_ASSIGNMENT[slot],
    lane: parseLane(input.lane) ?? LANE_ASSIGNMENT[slot],
  };
}

function normalizeSensorOffsets(value: unknown): StageCalibration["sensorOffsets"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    guard: normalizeRobotOffsets(input.guard),
    courier: normalizeRobotOffsets(input.courier),
  };
}

function normalizeRobotOffsets(value: unknown): StageCalibration["sensorOffsets"][RobotName] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    cameraForwardFt: finiteNumber(input.cameraForwardFt, 0, -20, 20),
    cameraRightFt: finiteNumber(input.cameraRightFt, 0, -20, 20),
    lidarForwardFt: finiteNumber(input.lidarForwardFt, 0, -20, 20),
    lidarRightFt: finiteNumber(input.lidarRightFt, 0, -20, 20),
  };
}

function normalizeSpeedDefaults(value: unknown): StageCalibration["speedDefaults"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const maxSpeedMode = parseSpeedMode(input.maxSpeedMode) ?? "medium";
  const requestedDefault = parseSpeedMode(input.defaultSpeedMode) ?? maxSpeedMode;
  const defaultSpeedMode = SPEED_RANK[requestedDefault] > SPEED_RANK[maxSpeedMode]
    ? maxSpeedMode
    : requestedDefault;
  return { defaultSpeedMode, maxSpeedMode };
}

function normalizeSafetyDefaults(value: unknown): StageCalibration["safetyDefaults"] {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const obstacleStopDistanceFt = finiteNumber(input.obstacleStopDistanceFt, 2, 0.5, 30);
  const warningDistanceFt = finiteNumber(input.warningDistanceFt, 5, obstacleStopDistanceFt, 60);
  return { obstacleStopDistanceFt, warningDistanceFt };
}

function applyCalibrationAssignments(round: Round) {
  for (const slot of ["challenger", "opponent"] as const) {
    const driver = round.drivers[slot];
    if (!driver) continue;
    driver.robot = round.stageCalibration.robotAssignments[slot].robot;
    driver.lane = round.stageCalibration.robotAssignments[slot].lane;
  }
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Number(number.toFixed(3))));
}

function finishTelemetryTraceId(round: Round, proof: Record<string, unknown> | undefined, finishedAt: number): string {
  return firstString(proof?.telemetryTraceId, proof?.traceId)
    ?? `trace-${round.id}-${finishedAt}`;
}

function normalizeFinishProof(
  round: Round,
  winner: DriverSlot,
  proof: Record<string, unknown> | undefined,
  telemetryTraceId: string,
  finishedAt: number,
): Record<string, unknown> {
  const input = plainObject(proof) ?? {};
  const frameHash = firstString(input.frameHash, input.proofFrameHash);
  const finishDetectionId = firstString(input.finishDetectionId, input.detectionId);
  return {
    schema: "onchain-rover.operator-finish-proof.v1",
    source: firstString(input.source) ?? "operator",
    method: firstString(input.method) ?? "winner-confirmation",
    winner,
    roundId: round.id,
    submittedAtMs: timestampMs(input.submittedAtMs, finishedAt),
    operatorActionId: firstString(input.operatorActionId) ?? `${round.id}-${winner}-${finishedAt}`,
    telemetryTraceId,
    finishDetectionId,
    proofFrame: {
      status: frameHash ? "captured" : "not-provided",
      frameHash,
      source: firstString(input.frameSource) ?? firstString(input.source) ?? "operator",
      capturedAtMs: timestampMs(input.frameCapturedAtMs, finishedAt),
    },
    note: firstString(input.note),
    metrics: plainObject(input.metrics),
  };
}

function timestampMs(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function parseRobotName(value: unknown): RobotName | null {
  if (value === "guard" || value === "courier") return value;
  if (value === undefined || value === null || value === "") return null;
  throw new Error("robot must be guard or courier");
}

function parseLane(value: unknown): LaneName | null {
  if (value === "left" || value === "right") return value;
  if (value === undefined || value === null || value === "") return null;
  throw new Error("lane must be left or right");
}

function parseSpeedMode(value: unknown): SpeedMode | null {
  if (value === "low" || value === "medium" || value === "high") return value;
  if (value === undefined || value === null || value === "") return null;
  throw new Error("speed mode must be low, medium, or high");
}

function normalizeFeePayment(round: Round, payment?: Record<string, unknown>): FeePayment {
  const txHash = firstString(payment?.txHash, payment?.transactionHash, payment?.hash, payment?.tx);
  const paymentId = firstString(payment?.paymentId, payment?.id, payment?.reference);
  const status = parsePaymentStatus(payment?.status);
  const source = parsePaymentSource(payment?.source, txHash, paymentId);
  const reconciliationStatus =
    status === "failed" ? "failed" :
    status === "paid" && (txHash || paymentId) ? "reconciled" :
    status === "paid" ? "needs-proof" : "pending";

  return {
    status,
    source,
    amountUsdc: firstString(payment?.amountUsdc, payment?.amount, payment?.value) ?? round.feeUsdc,
    amountUnits: firstString(payment?.amountUnits, payment?.units),
    recipientTreasury: firstString(payment?.recipientTreasury, payment?.treasury, payment?.recipient),
    paymentId,
    txHash,
    payer: firstString(payment?.payer, payment?.wallet, payment?.driver),
    paidAt: Number.isFinite(Number(payment?.paidAt)) ? Number(payment?.paidAt) : Date.now(),
    reconciliationStatus,
  };
}

function normalizeStakeAuthorization(round: Round, authorization?: Record<string, unknown>): StakeAuthorization {
  return {
    adapter: parseStakeAdapter(authorization?.adapter),
    status: parseStakeStatus(authorization?.status),
    roundId: firstString(authorization?.roundId, authorization?.round) ?? round.id,
    token: firstString(authorization?.token),
    spender: firstString(authorization?.spender),
    amountUsdc: firstString(authorization?.amountUsdc, authorization?.amount) ?? round.stakeUsdc,
    amountUnits: firstString(authorization?.amountUnits, authorization?.units),
    permissionHash: firstString(authorization?.permissionHash, authorization?.hash),
    permission: plainObject(authorization?.permission),
    signature: firstString(authorization?.signature),
    txHash: firstString(authorization?.txHash, authorization?.transactionHash, authorization?.tx),
    verifiedAt: Number.isFinite(Number(authorization?.verifiedAt)) ? Number(authorization?.verifiedAt) : Date.now(),
    expiresAt: Number.isFinite(Number(authorization?.expiresAt)) ? Number(authorization?.expiresAt) : undefined,
    settlement: plainObject(authorization?.settlement),
  };
}

function parsePaymentStatus(value: unknown): FeePayment["status"] {
  if (value === "pending" || value === "failed") return value;
  return "paid";
}

function parseStakeAdapter(value: unknown): StakeAuthorization["adapter"] {
  if (value === "base-spend-permission" || value === "local-chain-escrow" || value === "manual") return value;
  return "manual";
}

function parseStakeStatus(value: unknown): StakeAuthorization["status"] {
  if (value === "settled" || value === "failed") return value;
  return "verified";
}

function parsePaymentSource(
  value: unknown,
  txHash?: string,
  paymentId?: string,
): FeePayment["source"] {
  if (value === "x402" || value === "local-chain" || value === "manual") return value;
  if (txHash) return "local-chain";
  if (paymentId) return "x402";
  return "manual";
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return structuredClone(value as Record<string, unknown>);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function snapshot(round: Round): Round {
  return structuredClone(round);
}

function persistSnapshot(round: Round, kind: string): Round {
  raceStore.saveRound(round, kind);
  return snapshot(round);
}
