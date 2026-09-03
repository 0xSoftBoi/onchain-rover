import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { keccak256, parseEther, toBytes } from "viem";

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();

describe("Clanker500Escrow", async () => {
  async function deployFixture() {
    const [operator, challenger, opponent, facilitator, third] = await viem.getWalletClients();
    const escrow = await viem.deployContract(
      "Clanker500Escrow",
      [operator.account.address, facilitator.account.address],
      { client: { wallet: operator } },
    );
    const escrowAsFacilitator = await viem.getContractAt("Clanker500Escrow", escrow.address, {
      client: { wallet: facilitator },
    });
    const escrowAsChallenger = await viem.getContractAt("Clanker500Escrow", escrow.address, {
      client: { wallet: challenger },
    });
    const escrowAsOpponent = await viem.getContractAt("Clanker500Escrow", escrow.address, {
      client: { wallet: opponent },
    });
    const escrowAsThird = await viem.getContractAt("Clanker500Escrow", escrow.address, {
      client: { wallet: third },
    });
    return {
      escrow,
      escrowAsFacilitator,
      escrowAsChallenger,
      escrowAsOpponent,
      escrowAsThird,
      operator,
      challenger,
      opponent,
      facilitator,
      third,
    };
  }

  async function openRace(escrowAsFacilitator: any, roundLabel: string, stakeWei = parseEther("0.0003")) {
    const raceId = await escrowAsFacilitator.read.nextRaceId();
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.openRace([
        keccak256(toBytes(roundLabel)),
        stakeWei,
      ]),
    });
    return { raceId, stakeWei };
  }

  async function joinBoth(opts: {
    escrowAsChallenger: any;
    escrowAsOpponent: any;
    raceId: bigint;
    stakeWei: bigint;
  }) {
    await publicClient.waitForTransactionReceipt({
      hash: await opts.escrowAsChallenger.write.joinRace([opts.raceId, 0], { value: opts.stakeWei }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await opts.escrowAsOpponent.write.joinRace([opts.raceId, 1], { value: opts.stakeWei }),
    });
  }

  it("settles a two-driver native ETH race winner-takes-both", async () => {
    const { escrow, escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent, challenger } =
      await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-a");
    await joinBoth({ escrowAsChallenger, escrowAsOpponent, raceId, stakeWei });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.lockRace([raceId]),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.startRace([raceId]),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.finishRace([
        raceId,
        0,
        keccak256(toBytes("finish-proof")),
      ]),
    });

    const before = await publicClient.getBalance({ address: challenger.account.address });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.settleRace([raceId]),
    });
    const after = await publicClient.getBalance({ address: challenger.account.address });

    assert.equal(await publicClient.getBalance({ address: escrow.address }), 0n);
    assert.equal(after - before, stakeWei * 2n);
    const race = await escrow.read.getRace([raceId]);
    assert.equal(race.status, 6);
    assert.equal(race.winnerSlot, 0);
  });

  it("settles to the opponent when winner slot is one", async () => {
    const { escrow, escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent, opponent } =
      await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-opponent-wins");
    await joinBoth({ escrowAsChallenger, escrowAsOpponent, raceId, stakeWei });

    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.lockRace([raceId]),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.startRace([raceId]),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.finishRace([
        raceId,
        1,
        keccak256(toBytes("opponent-finish")),
      ]),
    });

    const before = await publicClient.getBalance({ address: opponent.account.address });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.settleRace([raceId]),
    });
    const after = await publicClient.getBalance({ address: opponent.account.address });

    assert.equal(after - before, stakeWei * 2n);
    assert.equal(await publicClient.getBalance({ address: escrow.address }), 0n);
  });

  it("rejects wrong stake amounts, duplicate slots, and same-wallet double joins", async () => {
    const { escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent } = await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-b");

    await assert.rejects(() =>
      escrowAsChallenger.write.joinRace([raceId, 0], { value: stakeWei - 1n })
    );

    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsChallenger.write.joinRace([raceId, 0], { value: stakeWei }),
    });

    await assert.rejects(() =>
      escrowAsOpponent.write.joinRace([raceId, 0], { value: stakeWei })
    );
    await assert.rejects(() =>
      escrowAsChallenger.write.joinRace([raceId, 1], { value: stakeWei })
    );
  });

  it("rejects additional joins after the race is locked", async () => {
    const { escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent, escrowAsThird } = await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-join-after-lock");
    await joinBoth({ escrowAsChallenger, escrowAsOpponent, raceId, stakeWei });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.lockRace([raceId]),
    });

    await assert.rejects(() =>
      escrowAsThird.write.joinRace([raceId, 0], { value: stakeWei })
    );
    await assert.rejects(() =>
      escrowAsThird.write.joinRace([raceId, 1], { value: stakeWei })
    );
  });

  it("rejects bad slots and joins against nonexistent races", async () => {
    const { escrowAsFacilitator, escrowAsChallenger } = await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-bad-slots");

    await assert.rejects(() =>
      escrowAsChallenger.write.joinRace([raceId, 2], { value: stakeWei })
    );
    await assert.rejects(() =>
      escrowAsChallenger.write.joinRace([raceId + 999n, 0], { value: stakeWei })
    );
  });

  it("rejects zero-stake races", async () => {
    const { escrowAsFacilitator } = await deployFixture();
    await assert.rejects(() =>
      escrowAsFacilitator.write.openRace([keccak256(toBytes("zero-stake")), 0n])
    );
  });

  it("requires both racers before lock and lock before start", async () => {
    const { escrowAsFacilitator, escrowAsChallenger } = await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-state-guards");

    await assert.rejects(() => escrowAsFacilitator.write.lockRace([raceId]));

    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsChallenger.write.joinRace([raceId, 0], { value: stakeWei }),
    });
    await assert.rejects(() => escrowAsFacilitator.write.lockRace([raceId]));
    await assert.rejects(() => escrowAsFacilitator.write.startRace([raceId]));
  });

  it("rejects finish before start, bad winner slots, and settle before finish", async () => {
    const { escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent } = await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-finish-guards");
    await joinBoth({ escrowAsChallenger, escrowAsOpponent, raceId, stakeWei });

    await assert.rejects(() => escrowAsFacilitator.write.settleRace([raceId]));
    await assert.rejects(() =>
      escrowAsFacilitator.write.finishRace([raceId, 0, keccak256(toBytes("too-early"))])
    );

    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.lockRace([raceId]),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.startRace([raceId]),
    });

    await assert.rejects(() =>
      escrowAsFacilitator.write.finishRace([raceId, 2, keccak256(toBytes("bad-winner"))])
    );
  });

  it("refunds joined drivers when canceled before finish", async () => {
    const { escrow, escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent, challenger, opponent } =
      await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-c");
    await joinBoth({ escrowAsChallenger, escrowAsOpponent, raceId, stakeWei });

    const challengerBefore = await publicClient.getBalance({ address: challenger.account.address });
    const opponentBefore = await publicClient.getBalance({ address: opponent.account.address });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.cancelRace([raceId, "operator canceled"]),
    });
    const challengerAfter = await publicClient.getBalance({ address: challenger.account.address });
    const opponentAfter = await publicClient.getBalance({ address: opponent.account.address });

    assert.equal(await publicClient.getBalance({ address: escrow.address }), 0n);
    assert.equal(challengerAfter - challengerBefore, stakeWei);
    assert.equal(opponentAfter - opponentBefore, stakeWei);
    const race = await escrow.read.getRace([raceId]);
    assert.equal(race.status, 7);
  });

  it("refunds only the joined racer when a partial heat is canceled", async () => {
    const { escrow, escrowAsFacilitator, escrowAsChallenger, challenger } = await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-partial-cancel");
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsChallenger.write.joinRace([raceId, 0], { value: stakeWei }),
    });

    const before = await publicClient.getBalance({ address: challenger.account.address });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.cancelRace([raceId, "one racer only"]),
    });
    const after = await publicClient.getBalance({ address: challenger.account.address });

    assert.equal(after - before, stakeWei);
    assert.equal(await publicClient.getBalance({ address: escrow.address }), 0n);
  });

  it("cancels an empty opened race without moving funds", async () => {
    const { escrow, escrowAsFacilitator } = await deployFixture();
    const { raceId } = await openRace(escrowAsFacilitator, "round-clanker-empty-cancel");

    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.cancelRace([raceId, "no racers"]),
    });

    assert.equal(await publicClient.getBalance({ address: escrow.address }), 0n);
    const race = await escrow.read.getRace([raceId]);
    assert.equal(race.status, 7);
  });

  it("rejects cancel after finish and after settlement", async () => {
    const { escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent } = await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-no-cancel-after-finish");
    await joinBoth({ escrowAsChallenger, escrowAsOpponent, raceId, stakeWei });
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.lockRace([raceId]) });
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.startRace([raceId]) });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.finishRace([raceId, 0, keccak256(toBytes("finished"))]),
    });

    await assert.rejects(() => escrowAsFacilitator.write.cancelRace([raceId, "too late"]));
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.settleRace([raceId]) });
    await assert.rejects(() => escrowAsFacilitator.write.cancelRace([raceId, "already settled"]));
  });

  it("rejects double settlement", async () => {
    const { escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent } = await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-double-settle");
    await joinBoth({ escrowAsChallenger, escrowAsOpponent, raceId, stakeWei });
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.lockRace([raceId]) });
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.startRace([raceId]) });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.finishRace([raceId, 0, keccak256(toBytes("settle-once"))]),
    });
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.settleRace([raceId]) });

    await assert.rejects(() => escrowAsFacilitator.write.settleRace([raceId]));
  });

  it("records race view details and increments race ids", async () => {
    const { escrow, escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent, challenger, opponent } =
      await deployFixture();
    const stakeWei = parseEther("0.0003");
    const first = await openRace(escrowAsFacilitator, "round-clanker-view-a", stakeWei);
    const second = await openRace(escrowAsFacilitator, "round-clanker-view-b", stakeWei);
    await joinBoth({ escrowAsChallenger, escrowAsOpponent, raceId: first.raceId, stakeWei });

    assert.equal(second.raceId, first.raceId + 1n);
    const race = await escrow.read.getRace([first.raceId]);
    assert.equal(race.status, 2);
    assert.equal(race.localRoundId, keccak256(toBytes("round-clanker-view-a")));
    assert.equal(race.challenger.toLowerCase(), challenger.account.address.toLowerCase());
    assert.equal(race.opponent.toLowerCase(), opponent.account.address.toLowerCase());
    assert.equal(race.challengerJoined, true);
    assert.equal(race.opponentJoined, true);
    assert.equal(race.stakeWei, stakeWei);
    assert.ok(race.createdAt > 0n);
  });

  it("returns an empty view for unknown race ids", async () => {
    const { escrow } = await deployFixture();
    const race = await escrow.read.getRace([999n]);

    assert.equal(race.status, 0);
    assert.equal(race.localRoundId, "0x0000000000000000000000000000000000000000000000000000000000000000");
    assert.equal(race.challenger, "0x0000000000000000000000000000000000000000");
    assert.equal(race.opponent, "0x0000000000000000000000000000000000000000");
    assert.equal(race.challengerJoined, false);
    assert.equal(race.opponentJoined, false);
    assert.equal(race.stakeWei, 0n);
    assert.equal(race.winnerSlot, 0);
    assert.equal(race.createdAt, 0n);
  });

  it("records lock, start, finish timestamps and proof hash", async () => {
    const { escrow, escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent } = await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-timestamps");
    const proofHash = keccak256(toBytes("timestamp-proof"));
    await joinBoth({ escrowAsChallenger, escrowAsOpponent, raceId, stakeWei });
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.lockRace([raceId]) });
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.startRace([raceId]) });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.finishRace([raceId, 1, proofHash]),
    });

    const race = await escrow.read.getRace([raceId]);
    assert.equal(race.status, 5);
    assert.equal(race.winnerSlot, 1);
    assert.equal(race.proofHash, proofHash);
    assert.ok(race.lockedAt > 0n);
    assert.ok(race.startedAt >= race.lockedAt);
    assert.ok(race.finishedAt >= race.startedAt);
  });

  it("rejects facilitator lifecycle calls from non-facilitators", async () => {
    const { escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent, escrowAsThird } = await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-non-facilitator");
    await joinBoth({ escrowAsChallenger, escrowAsOpponent, raceId, stakeWei });

    await assert.rejects(() => escrowAsThird.write.lockRace([raceId]));
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.lockRace([raceId]) });

    await assert.rejects(() => escrowAsThird.write.startRace([raceId]));
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.startRace([raceId]) });

    await assert.rejects(() =>
      escrowAsThird.write.finishRace([raceId, 0, keccak256(toBytes("bad-finish"))])
    );
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.finishRace([raceId, 0, keccak256(toBytes("good-finish"))]),
    });

    await assert.rejects(() => escrowAsThird.write.settleRace([raceId]));

    const opened = await openRace(escrowAsFacilitator, "round-clanker-non-facilitator-cancel");
    await assert.rejects(() => escrowAsThird.write.cancelRace([opened.raceId, "not facilitator"]));
  });

  it("rejects lifecycle calls against unknown races", async () => {
    const { escrowAsFacilitator } = await deployFixture();
    const missingRaceId = 12345n;

    await assert.rejects(() => escrowAsFacilitator.write.lockRace([missingRaceId]));
    await assert.rejects(() => escrowAsFacilitator.write.startRace([missingRaceId]));
    await assert.rejects(() =>
      escrowAsFacilitator.write.finishRace([missingRaceId, 0, keccak256(toBytes("missing"))])
    );
    await assert.rejects(() => escrowAsFacilitator.write.settleRace([missingRaceId]));
    await assert.rejects(() => escrowAsFacilitator.write.cancelRace([missingRaceId, "missing"]));
  });

  it("rejects repeated lock, start, and finish transitions", async () => {
    const { escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent } = await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-repeat-transitions");
    await joinBoth({ escrowAsChallenger, escrowAsOpponent, raceId, stakeWei });

    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.lockRace([raceId]) });
    await assert.rejects(() => escrowAsFacilitator.write.lockRace([raceId]));

    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.startRace([raceId]) });
    await assert.rejects(() => escrowAsFacilitator.write.startRace([raceId]));

    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.finishRace([raceId, 0, keccak256(toBytes("finish-once"))]),
    });
    await assert.rejects(() =>
      escrowAsFacilitator.write.finishRace([raceId, 0, keccak256(toBytes("finish-twice"))])
    );
  });

  it("refunds joined drivers when canceled after lock", async () => {
    const { escrow, escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent, challenger, opponent } =
      await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-cancel-locked");
    await joinBoth({ escrowAsChallenger, escrowAsOpponent, raceId, stakeWei });
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.lockRace([raceId]) });

    const challengerBefore = await publicClient.getBalance({ address: challenger.account.address });
    const opponentBefore = await publicClient.getBalance({ address: opponent.account.address });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.cancelRace([raceId, "locked cancel"]),
    });
    const challengerAfter = await publicClient.getBalance({ address: challenger.account.address });
    const opponentAfter = await publicClient.getBalance({ address: opponent.account.address });

    assert.equal(challengerAfter - challengerBefore, stakeWei);
    assert.equal(opponentAfter - opponentBefore, stakeWei);
    assert.equal(await publicClient.getBalance({ address: escrow.address }), 0n);
    assert.equal((await escrow.read.getRace([raceId])).status, 7);
  });

  it("refunds joined drivers when canceled after start but before finish", async () => {
    const { escrow, escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent, challenger, opponent } =
      await deployFixture();
    const { raceId, stakeWei } = await openRace(escrowAsFacilitator, "round-clanker-cancel-started");
    await joinBoth({ escrowAsChallenger, escrowAsOpponent, raceId, stakeWei });
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.lockRace([raceId]) });
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.startRace([raceId]) });

    const challengerBefore = await publicClient.getBalance({ address: challenger.account.address });
    const opponentBefore = await publicClient.getBalance({ address: opponent.account.address });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.cancelRace([raceId, "started cancel"]),
    });
    const challengerAfter = await publicClient.getBalance({ address: challenger.account.address });
    const opponentAfter = await publicClient.getBalance({ address: opponent.account.address });

    assert.equal(challengerAfter - challengerBefore, stakeWei);
    assert.equal(opponentAfter - opponentBefore, stakeWei);
    assert.equal(await publicClient.getBalance({ address: escrow.address }), 0n);
    assert.equal((await escrow.read.getRace([raceId])).status, 7);
  });

  it("keeps simultaneous race balances independent", async () => {
    const { escrow, escrowAsFacilitator, escrowAsChallenger, escrowAsOpponent } = await deployFixture();
    const first = await openRace(escrowAsFacilitator, "round-clanker-independent-a");
    const second = await openRace(escrowAsFacilitator, "round-clanker-independent-b");
    await joinBoth({
      escrowAsChallenger,
      escrowAsOpponent,
      raceId: first.raceId,
      stakeWei: first.stakeWei,
    });
    await joinBoth({
      escrowAsChallenger,
      escrowAsOpponent,
      raceId: second.raceId,
      stakeWei: second.stakeWei,
    });

    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.lockRace([first.raceId]) });
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.startRace([first.raceId]) });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.finishRace([
        first.raceId,
        0,
        keccak256(toBytes("independent-finish")),
      ]),
    });
    await publicClient.waitForTransactionReceipt({ hash: await escrowAsFacilitator.write.settleRace([first.raceId]) });

    assert.equal(await publicClient.getBalance({ address: escrow.address }), second.stakeWei * 2n);
    assert.equal((await escrow.read.getRace([first.raceId])).status, 6);
    assert.equal((await escrow.read.getRace([second.raceId])).status, 2);

    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.cancelRace([second.raceId, "cleanup second heat"]),
    });
    assert.equal(await publicClient.getBalance({ address: escrow.address }), 0n);
  });

  it("rejects unauthorized facilitator actions", async () => {
    const { escrowAsThird } = await deployFixture();
    await assert.rejects(() =>
      escrowAsThird.write.openRace([keccak256(toBytes("round-clanker-unauth")), parseEther("0.0003")])
    );
  });

  it("rejects zero-address constructor arguments", async () => {
    const [operator, _challenger, _opponent, facilitator] = await viem.getWalletClients();
    await assert.rejects(() =>
      viem.deployContract("Clanker500Escrow", [
        "0x0000000000000000000000000000000000000000",
        facilitator.account.address,
      ], { client: { wallet: operator } })
    );
    await assert.rejects(() =>
      viem.deployContract("Clanker500Escrow", [
        operator.account.address,
        "0x0000000000000000000000000000000000000000",
      ], { client: { wallet: operator } })
    );
  });

  it("allows the operator to rotate facilitator and operator addresses", async () => {
    const { escrow, escrowAsFacilitator, escrowAsThird, third } = await deployFixture();
    await publicClient.waitForTransactionReceipt({
      hash: await escrow.write.setFacilitator([third.account.address]),
    });

    await assert.rejects(() =>
      escrowAsFacilitator.write.openRace([keccak256(toBytes("old-facilitator")), parseEther("0.0003")])
    );
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsThird.write.openRace([keccak256(toBytes("new-facilitator")), parseEther("0.0003")]),
    });

    await publicClient.waitForTransactionReceipt({
      hash: await escrow.write.setOperator([third.account.address]),
    });
    await assert.rejects(() => escrow.write.setFacilitator([third.account.address]));
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsThird.write.setFacilitator([third.account.address]),
    });
  });

  it("rejects zero-address governance targets", async () => {
    const { escrow } = await deployFixture();
    await assert.rejects(() =>
      escrow.write.setFacilitator(["0x0000000000000000000000000000000000000000"])
    );
    await assert.rejects(() =>
      escrow.write.setOperator(["0x0000000000000000000000000000000000000000"])
    );
  });

  it("rejects non-operator governance changes", async () => {
    const { escrowAsThird, third } = await deployFixture();
    await assert.rejects(() => escrowAsThird.write.setFacilitator([third.account.address]));
    await assert.rejects(() => escrowAsThird.write.setOperator([third.account.address]));
  });
});
