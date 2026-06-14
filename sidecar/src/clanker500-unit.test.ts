import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { decodeFunctionData, parseAbi } from "viem";

process.env.RACE_DATA_DIR = mkdtempSync(join(tmpdir(), "clanker500-unit-"));
process.env.CLANKER500_STAKE_WEI = "123000000000000";
process.env.CLANKER500_ESCROW_ADDRESS = "0x00000000000000000000000000000000000c5000";

const rounds = await import("./rounds.js");
const evidence = await import("./evidence.js");
const clanker500 = await import("./clanker500-chain.js");

const WALLETS = {
  a: "0x1111111111111111111111111111111111111111",
  b: "0x2222222222222222222222222222222222222222",
  c: "0x3333333333333333333333333333333333333333",
} as const;

const JOIN_RACE_ABI = parseAbi(["function joinRace(uint256 raceId, uint8 slot) payable"]);

describe("Clanker500 sidecar primitives", () => {
  it("returns Base Sepolia config, native stake, escrow address, and tag map", () => {
    process.env.CLANKER500_GUARD_TAG_ID = "10";
    process.env.CLANKER500_COURIER_TAG_ID = "11";
    process.env.CLANKER500_FINISH_TAG_A = "30";
    process.env.CLANKER500_FINISH_TAG_B = "31";

    const config = clanker500.clanker500Config();

    assert.equal(config.chain.chainId, 84532);
    assert.equal(config.chain.chainIdHex, "0x14a34");
    assert.equal(config.chain.nativeCurrency.symbol, "ETH");
    assert.equal(config.escrowAddress, process.env.CLANKER500_ESCROW_ADDRESS);
    assert.equal(config.stakeWei, "123000000000000");
    assert.equal(config.stakeDisplay, "0.000123 ETH");
    assert.deepEqual(config.tagMap, { guard: 10, courier: 11, finishA: 30, finishB: 31 });
  });

  it("creates native ETH rounds with Clanker500 metadata and lane assignments", () => {
    const round = createNativeRound();

    assert.equal(round.status, "accepted");
    assert.equal(round.chainStatus, "not-opened");
    assert.equal(round.stakeAsset, "native-eth");
    assert.equal(round.stakeWei, "123000000000000");
    assert.equal(round.stakeDisplay, "0.000123 ETH");
    assert.equal(round.chainNetwork, "base-sepolia");
    assert.equal(round.feeUsdc, "0");
    assert.equal(round.drivers.challenger?.robot, "guard");
    assert.equal(round.drivers.challenger?.lane, "left");
    assert.equal(round.drivers.opponent?.robot, "courier");
    assert.equal(round.drivers.opponent?.lane, "right");
  });

  it("keeps slot claims deterministic and prevents wallet collisions", () => {
    const round = createNativeRound();
    let claimed = rounds.claimSlot(round.id, "challenger", {
      wallet: WALLETS.a,
      displayName: "alpha",
    });
    assert.equal(claimed.drivers.challenger?.wallet, WALLETS.a);

    claimed = rounds.claimSlot(round.id, "challenger", {
      wallet: WALLETS.a,
      displayName: "alpha refresh",
    });
    assert.equal(claimed.drivers.challenger?.wallet, WALLETS.a);
    assert.equal(claimed.drivers.challenger?.displayName, "alpha refresh");

    assert.throws(() =>
      rounds.claimSlot(round.id, "challenger", { wallet: WALLETS.b })
    , /already claimed/);
    assert.throws(() =>
      rounds.claimSlot(round.id, "opponent", { wallet: WALLETS.a })
    , /already claimed the other slot/);

    claimed = rounds.claimSlot(round.id, "opponent", {
      wallet: WALLETS.b,
      displayName: "beta",
    });
    assert.equal(claimed.drivers.opponent?.wallet, WALLETS.b);
  });

  it("marks native escrow joins, records txs, and only becomes ready after two deposits", () => {
    const round = createClaimedNativeRound();
    let joined = rounds.markNativeChainJoined(round.id, "challenger", txHash(1), {
      stakeWei: "123000000000000",
      chainNetwork: "base-sepolia",
    });

    assert.equal(joined.status, "accepted");
    assert.equal(joined.chainStatus, "opened");
    assert.equal(joined.drivers.challenger?.chainJoined, true);
    assert.equal(joined.drivers.challenger?.stakeAuthorization?.adapter, "native-eth-escrow");
    assert.equal(joined.drivers.challenger?.stakeAuthorization?.amountUnits, "123000000000000");
    assert.equal(joined.drivers.challenger?.feePayment?.amountUsdc, "0");
    assert.equal(joined.txHashes?.challengerJoin, txHash(1));

    joined = rounds.markNativeChainJoined(round.id, "opponent", txHash(2), {
      stakeWei: "123000000000000",
      chainNetwork: "base-sepolia",
    });

    assert.equal(joined.status, "ready");
    assert.equal(joined.chainStatus, "joined");
    assert.equal(joined.drivers.opponent?.chainJoined, true);
    assert.equal(joined.txHashes?.opponentJoin, txHash(2));
  });

  it("summarizes native cancellation as escrow refund policy", () => {
    const round = createReadyNativeRound();
    const canceled = rounds.cancelRound(round.id, {
      code: "operator_cancel",
      reason: "operator canceled before start",
    });

    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.cancellation?.code, "operator_cancel");
    assert.match(canceled.cancellation?.feePolicy ?? "", /no separate race fee/);
    assert.match(canceled.cancellation?.stakePolicy ?? "", /refunded on-chain/);
    assert.equal(canceled.cancellation?.drivers.challenger.stakeStatus, "escrowed");
    assert.equal(canceled.cancellation?.drivers.opponent.stakeStatus, "escrowed");
  });

  it("builds a Base Sepolia join transaction for the claimed wallet and slot", () => {
    let round = createClaimedNativeRound();
    round = rounds.attachChainRace(round.id, "42", txHash(3));

    const tx = clanker500.buildJoinTransaction(round, "challenger", WALLETS.a);
    const decoded = decodeFunctionData({ abi: JOIN_RACE_ABI, data: tx.data });

    assert.equal(tx.chain.chainId, 84532);
    assert.equal(tx.to.toLowerCase(), process.env.CLANKER500_ESCROW_ADDRESS?.toLowerCase());
    assert.equal(tx.from, WALLETS.a);
    assert.equal(tx.valueWei, "123000000000000");
    assert.equal(tx.value, "0x6fde2b4eb000");
    assert.equal(tx.raceId, "42");
    assert.equal(tx.slot, "challenger");
    assert.match(tx.data, /^0x[0-9a-f]+$/i);
    assert.equal(decoded.functionName, "joinRace");
    assert.deepEqual(decoded.args, [42n, 0]);
  });

  it("builds the opponent join transaction with slot one and the same stake", () => {
    let round = createClaimedNativeRound();
    round = rounds.attachChainRace(round.id, "44", txHash(5));

    const tx = clanker500.buildJoinTransaction(round, "opponent", WALLETS.b);
    const decoded = decodeFunctionData({ abi: JOIN_RACE_ABI, data: tx.data });

    assert.equal(tx.from, WALLETS.b);
    assert.equal(tx.valueWei, "123000000000000");
    assert.equal(tx.raceId, "44");
    assert.equal(tx.slot, "opponent");
    assert.match(tx.data, /^0x[0-9a-f]+$/i);
    assert.deepEqual(decoded.args, [44n, 1]);
  });

  it("rejects join transaction construction for missing race ids or wallet mismatches", () => {
    const round = createClaimedNativeRound();

    assert.throws(() =>
      clanker500.buildJoinTransaction(round, "challenger", WALLETS.a)
    , /open the Clanker500 escrow first/);

    const opened = rounds.attachChainRace(round.id, "43", txHash(4));
    assert.throws(() =>
      clanker500.buildJoinTransaction(opened, "challenger", WALLETS.c)
    , /wallet does not match/);
  });

  it("rejects join transaction construction for unclaimed slots", () => {
    let round = createNativeRound();
    round = rounds.claimSlot(round.id, "challenger", { wallet: WALLETS.a });
    round = rounds.attachChainRace(round.id, "45", txHash(12));

    assert.throws(() =>
      clanker500.buildJoinTransaction(round, "opponent", WALLETS.b)
    , /opponent has not claimed a wallet/);
  });

  it("uses round stake wei before environment stake defaults", () => {
    const round = createNativeRound({ stakeWei: "456000000000000", stakeDisplay: "0.000456 ETH" });

    assert.equal(clanker500.stakeWeiForRound(round), 456000000000000n);
  });

  it("uses CLANKER500_STAKE_ETH fallback and rejects malformed env wei", () => {
    const previousWei = process.env.CLANKER500_STAKE_WEI;
    const previousEth = process.env.CLANKER500_STAKE_ETH;
    try {
      delete process.env.CLANKER500_STAKE_WEI;
      process.env.CLANKER500_STAKE_ETH = "0.000777";
      assert.equal(clanker500.stakeWei().toString(), "777000000000000");

      process.env.CLANKER500_STAKE_WEI = "1.5";
      assert.throws(() => clanker500.stakeWei(), /CLANKER500_STAKE_WEI must be wei units/);
    } finally {
      if (previousWei === undefined) delete process.env.CLANKER500_STAKE_WEI;
      else process.env.CLANKER500_STAKE_WEI = previousWei;
      if (previousEth === undefined) delete process.env.CLANKER500_STAKE_ETH;
      else process.env.CLANKER500_STAKE_ETH = previousEth;
    }
  });

  it("rejects malformed native stake values", () => {
    const badRound = createNativeRound({ stakeWei: "0.1" });
    const zeroRound = createNativeRound({ stakeWei: "0" });

    assert.throws(() => clanker500.stakeWeiForRound(badRound), /wei units/);
    assert.throws(() => clanker500.stakeWeiForRound(zeroRound), /positive/);
  });

  it("requires native stake metadata before marking an escrow join", () => {
    const round = rounds.createRound({
      stakeUsdc: "0",
      stakeAsset: "native-eth",
      feeUsdc: "0",
    });
    rounds.claimSlot(round.id, "challenger", { wallet: WALLETS.a });

    assert.throws(() =>
      rounds.markNativeChainJoined(round.id, "challenger", txHash(6))
    , /native stake amount missing/);
  });

  it("rejects native join marking after a round is canceled", () => {
    const round = createClaimedNativeRound();
    rounds.cancelRound(round.id, { code: "operator_cancel", reason: "test canceled" });

    assert.throws(() =>
      rounds.markNativeChainJoined(round.id, "challenger", txHash(7), {
        stakeWei: "123000000000000",
      })
    , /not joinable/);
  });

  it("keeps chain race attachment idempotent but rejects conflicting chain ids", () => {
    const round = createNativeRound();
    const opened = rounds.attachChainRace(round.id, "100", txHash(13));
    const repeated = rounds.attachChainRace(round.id, "100", txHash(14));

    assert.equal(opened.chainRaceId, "100");
    assert.equal(repeated.chainRaceId, "100");
    assert.equal(repeated.txHashes?.open, txHash(14));
    assert.throws(() =>
      rounds.attachChainRace(round.id, "101", txHash(15))
    , /different chain race id/);
  });

  it("enforces native chain marker ordering", () => {
    const round = createReadyNativeRound();

    assert.throws(() => rounds.markChainStarted(round.id, txHash(16)), /not locked/);
    assert.throws(() => rounds.markChainFinished(round.id, txHash(17)), /not started/);
    assert.throws(() => rounds.markChainSettled(round.id, txHash(18)), /finished before settlement/);

    const locked = rounds.markChainLocked(round.id, txHash(19));
    assert.equal(locked.chainStatus, "locked");
    assert.throws(() => rounds.markChainLocked(round.id, txHash(20)), /not joined/);

    const started = rounds.markChainStarted(round.id, txHash(21));
    assert.equal(started.chainStatus, "started");
    assert.throws(() => rounds.markChainStarted(round.id, txHash(22)), /not locked/);
  });

  it("requires chain lock before local lock when a chain race exists", () => {
    let round = createOpenedReadyNativeRound("202", txHash(23));

    assert.throws(() => rounds.lockRoundLocal(round.id), /on-chain round must be locked/);

    round = rounds.markChainLocked(round.id, txHash(24));
    round = rounds.lockRoundLocal(round.id);
    assert.equal(round.status, "locked");
    assert.equal(round.chainStatus, "locked");
  });

  it("walks a native round through local and chain finish markers into settlement", async () => {
    let round = createReadyNativeRound({ countdownSecs: 1, durationSecs: 5 });
    round = rounds.markChainLocked(round.id, txHash(25));
    round = rounds.lockRoundLocal(round.id);
    round = rounds.startCountdown(round.id);
    await sleep(Math.max(0, (round.roundStartsAt ?? Date.now()) - Date.now()) + 10);
    round = rounds.markChainStarted(round.id, txHash(26));
    round = rounds.startRace(round.id);
    round = rounds.finishRound(round.id, "opponent", {
      source: "clanker500-unit-test",
      method: "finish-line",
    });
    round = rounds.markChainFinished(round.id, txHash(27));
    round = rounds.markChainSettled(round.id, txHash(28));

    assert.equal(round.status, "settled");
    assert.equal(round.chainStatus, "settled");
    assert.equal(round.winner, "opponent");
    assert.equal(round.settlementState?.status, "settled");
    assert.equal(round.txHashes?.lock, txHash(25));
    assert.equal(round.txHashes?.start, txHash(26));
    assert.equal(round.txHashes?.finish, txHash(27));
    assert.equal(round.txHashes?.settle, txHash(28));
  });

  it("marks chain cancellation with escrow refund policy and cancel tx", () => {
    const round = createReadyNativeRound();
    const canceled = rounds.markChainCanceled(round.id, txHash(29), "camera failed");

    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.chainStatus, "canceled");
    assert.equal(canceled.settlementState?.status, "canceled");
    assert.equal(canceled.settlementState?.txHash, txHash(29));
    assert.equal(canceled.txHashes?.cancel, txHash(29));
    assert.equal(canceled.cancellation?.code, "chain_cancel");
    assert.match(canceled.cancellation?.stakePolicy ?? "", /refunded on-chain/);
  });

  it("keeps native tag defaults numeric when env vars are absent", () => {
    const previousGuard = process.env.CLANKER500_GUARD_TAG_ID;
    const previousCourier = process.env.CLANKER500_COURIER_TAG_ID;
    const previousFinishA = process.env.CLANKER500_FINISH_TAG_A;
    const previousFinishB = process.env.CLANKER500_FINISH_TAG_B;
    try {
      delete process.env.CLANKER500_GUARD_TAG_ID;
      delete process.env.CLANKER500_COURIER_TAG_ID;
      delete process.env.CLANKER500_FINISH_TAG_A;
      delete process.env.CLANKER500_FINISH_TAG_B;

      assert.deepEqual(clanker500.clanker500Config().tagMap, {
        guard: 1,
        courier: 2,
        finishA: 20,
        finishB: 21,
      });
    } finally {
      restoreEnv("CLANKER500_GUARD_TAG_ID", previousGuard);
      restoreEnv("CLANKER500_COURIER_TAG_ID", previousCourier);
      restoreEnv("CLANKER500_FINISH_TAG_A", previousFinishA);
      restoreEnv("CLANKER500_FINISH_TAG_B", previousFinishB);
    }
  });

  it("preserves native stake fields inside finalized evidence packets", async () => {
    let round = createReadyNativeRound({ countdownSecs: 1, durationSecs: 5 });
    round = rounds.lockRoundLocal(round.id);
    evidence.recordRoundSnapshot(round, "locked");
    round = rounds.startCountdown(round.id);
    await sleep(Math.max(0, (round.roundStartsAt ?? Date.now()) - Date.now()) + 10);
    round = rounds.startRace(round.id);
    evidence.recordRoundSnapshot(round, "started");
    round = rounds.finishRound(round.id, "challenger", {
      source: "clanker500-unit-test",
      method: "marker-detection",
      telemetryTraceId: `trace-${round.id}`,
    });
    evidence.recordRoundSnapshot(round, "finished");
    const finalized = evidence.finalizeResultProof(round, round.proof);
    const packet = evidence.getEvidence(round);

    assert.match(finalized.proofHash, /^0x[0-9a-f]{64}$/);
    assert.match(packet.evidenceHash ?? "", /^0x[0-9a-f]{64}$/);
    assert.match(packet.canonical, /"stakeAsset":"native-eth"/);
    assert.match(packet.canonical, /"stakeWei":"123000000000000"/);
    const resultProof = packet.evidence.resultProof as { result?: { winner?: string } } | null;
    assert.equal(resultProof?.result?.winner, "challenger");
  });
});

function createNativeRound(input: Record<string, unknown> = {}) {
  return rounds.createRound({
    stakeUsdc: "0",
    stakeAsset: "native-eth",
    stakeWei: "123000000000000",
    stakeDisplay: "0.000123 ETH",
    chainNetwork: "base-sepolia",
    feeUsdc: "0",
    durationSecs: 30,
    countdownSecs: 1,
    stageCalibration: {
      laneLengthFt: 12,
      laneWidthFt: 3,
      startLineFt: 0,
      finishLineFt: 12,
      robotAssignments: {
        challenger: { robot: "guard", lane: "left" },
        opponent: { robot: "courier", lane: "right" },
      },
      speedDefaults: { defaultSpeedMode: "medium", maxSpeedMode: "medium" },
      safetyDefaults: { obstacleStopDistanceFt: 1.5, warningDistanceFt: 3 },
    },
    ...input,
  });
}

function createClaimedNativeRound() {
  const round = createNativeRound();
  rounds.claimSlot(round.id, "challenger", { wallet: WALLETS.a, displayName: "alpha" });
  return rounds.claimSlot(round.id, "opponent", { wallet: WALLETS.b, displayName: "beta" });
}

function createReadyNativeRound(input: Record<string, unknown> = {}) {
  const round = createNativeRound(input);
  rounds.claimSlot(round.id, "challenger", { wallet: WALLETS.a, displayName: "alpha" });
  rounds.claimSlot(round.id, "opponent", { wallet: WALLETS.b, displayName: "beta" });
  rounds.markNativeChainJoined(round.id, "challenger", txHash(10), {
    stakeWei: "123000000000000",
    chainNetwork: "base-sepolia",
  });
  return rounds.markNativeChainJoined(round.id, "opponent", txHash(11), {
    stakeWei: "123000000000000",
    chainNetwork: "base-sepolia",
  });
}

function createOpenedReadyNativeRound(chainRaceId: string, openTx: string) {
  let round = createNativeRound();
  rounds.claimSlot(round.id, "challenger", { wallet: WALLETS.a, displayName: "alpha" });
  round = rounds.claimSlot(round.id, "opponent", { wallet: WALLETS.b, displayName: "beta" });
  round = rounds.attachChainRace(round.id, chainRaceId, openTx);
  rounds.markNativeChainJoined(round.id, "challenger", txHash(30), {
    stakeWei: "123000000000000",
    chainNetwork: "base-sepolia",
  });
  return rounds.markNativeChainJoined(round.id, "opponent", txHash(31), {
    stakeWei: "123000000000000",
    chainNetwork: "base-sepolia",
  });
}

function txHash(index: number) {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
