/**
 * End-to-end Anchor test for the Clanker 5000 settlement core.
 *
 * Exercises both ported flows against a local validator:
 *   1. RaceEscrow: initialize -> open -> join(x2) -> lock -> start -> finish
 *      -> settle, asserting the winner receives 2x the stake.
 *   2. RaceMarket: open -> bet(x2) -> settle -> claim, asserting the parimutuel
 *      payout math and that a reused World ID nullifier is rejected.
 *
 * Run with `anchor test` from the `solana/` directory (requires the Solana +
 * Anchor toolchain and a local validator).
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Clanker5000 } from "../target/types/clanker5000";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

describe("clanker5000", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Clanker5000 as Program<Clanker5000>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const enc = new TextEncoder();
  let usdc: PublicKey;
  const facilitator = Keypair.generate();
  const challenger = Keypair.generate();
  const opponent = Keypair.generate();

  const u64 = (n: number | bigint) => new anchor.BN(n.toString());
  const STAKE = 1_000_000; // 1 USDC (6dp)
  const FEE = 250_000;

  const configPda = () =>
    PublicKey.findProgramAddressSync([enc.encode("config")], program.programId)[0];
  const racePda = (id: number) =>
    PublicKey.findProgramAddressSync(
      [enc.encode("race"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  const vaultPda = (race: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [enc.encode("vault"), race.toBuffer()],
      program.programId
    )[0];
  const vaultAuthPda = () =>
    PublicKey.findProgramAddressSync([enc.encode("vault_auth")], program.programId)[0];

  const marketPda = (id: number) =>
    PublicKey.findProgramAddressSync(
      [enc.encode("market"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  const marketVaultPda = (market: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [enc.encode("market_vault"), market.toBuffer()],
      program.programId
    )[0];
  const marketVaultAuthPda = (market: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [enc.encode("market_vault_auth"), market.toBuffer()],
      program.programId
    )[0];
  const betPda = (market: PublicKey, bettor: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [enc.encode("bet"), market.toBuffer(), bettor.toBuffer()],
      program.programId
    )[0];
  const nullifierPda = (market: PublicKey, nullifier: number[]) =>
    PublicKey.findProgramAddressSync(
      [enc.encode("nullifier"), market.toBuffer(), Buffer.from(nullifier)],
      program.programId
    )[0];

  let treasuryAta: PublicKey;

  before(async () => {
    for (const kp of [facilitator, challenger, opponent]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2e9);
      await provider.connection.confirmTransaction(sig);
    }
    usdc = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    treasuryAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, payer, usdc, payer.publicKey)
    ).address;
  });

  it("initializes config", async () => {
    await program.methods
      .initialize(facilitator.publicKey)
      .accounts({
        config: configPda(),
        authority: payer.publicKey,
        usdcMint: usdc,
        treasuryToken: treasuryAta,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const cfg = await program.account.config.fetch(configPda());
    assert.equal(cfg.facilitator.toBase58(), facilitator.publicKey.toBase58());
    assert.equal(cfg.nextRaceId.toNumber(), 0);
  });

  it("runs a full race and pays the winner 2x", async () => {
    const raceId = 0;
    const race = racePda(raceId);
    const vault = vaultPda(race);

    await program.methods
      .openRace(u64(raceId), Array(32).fill(7), u64(STAKE), u64(FEE))
      .accounts({
        config: configPda(),
        facilitator: facilitator.publicKey,
        race,
        vault,
        vaultAuthority: vaultAuthPda(),
        usdcMint: usdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([facilitator])
      .rpc();

    const drivers = [challenger, opponent];
    const atas: PublicKey[] = [];
    for (const d of drivers) {
      const ata = (
        await getOrCreateAssociatedTokenAccount(provider.connection, payer, usdc, d.publicKey)
      ).address;
      atas.push(ata);
      await mintTo(provider.connection, payer, usdc, ata, payer, STAKE + FEE);
    }

    for (let slot = 0; slot < 2; slot++) {
      await program.methods
        .joinRace(u64(raceId), slot, u64(STAKE), u64(FEE))
        .accounts({
          config: configPda(),
          race,
          driver: drivers[slot].publicKey,
          driverToken: atas[slot],
          vault,
          treasuryToken: treasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([drivers[slot]])
        .rpc();
    }

    await program.methods.lockRace(u64(raceId)).accounts({ config: configPda(), facilitator: facilitator.publicKey, race }).signers([facilitator]).rpc();
    await program.methods.startRace(u64(raceId)).accounts({ config: configPda(), facilitator: facilitator.publicKey, race }).signers([facilitator]).rpc();
    await program.methods
      .finishRace(u64(raceId), 0, Array(32).fill(9))
      .accounts({ config: configPda(), facilitator: facilitator.publicKey, race })
      .signers([facilitator])
      .rpc();

    const before = await getAccount(provider.connection, atas[0]);
    await program.methods
      .settleRace(u64(raceId))
      .accounts({
        config: configPda(),
        facilitator: facilitator.publicKey,
        race,
        vault,
        vaultAuthority: vaultAuthPda(),
        winnerToken: atas[0],
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([facilitator])
      .rpc();
    const after = await getAccount(provider.connection, atas[0]);

    assert.equal(Number(after.amount - before.amount), STAKE * 2);
    const treasury = await getAccount(provider.connection, treasuryAta);
    assert.equal(Number(treasury.amount), FEE * 2);
  });

  it("runs a parimutuel market: bet -> settle -> claim, and rejects nullifier reuse", async () => {
    const marketId = 0;
    const market = marketPda(marketId);
    const vault = marketVaultPda(market);
    const judge = facilitator; // any signer becomes the judge
    const NUM_RACERS = 2;

    // Two bettors back the winning lane (0) at 3:1, so the pool is lopsided and
    // the pro-rata split must reproduce the on-chain `floor(stake*total/win)`.
    const winnerBig = Keypair.generate(); // bets 3 USDC on lane 0
    const winnerSmall = Keypair.generate(); // bets 1 USDC on lane 0
    const loser = Keypair.generate(); // bets 2 USDC on lane 1
    for (const kp of [winnerBig, winnerSmall, loser]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2e9);
      await provider.connection.confirmTransaction(sig);
    }

    const BETS = [
      { kp: winnerBig, lane: 0, amount: 3_000_000, nul: Array(32).fill(11) },
      { kp: winnerSmall, lane: 0, amount: 1_000_000, nul: Array(32).fill(22) },
      { kp: loser, lane: 1, amount: 2_000_000, nul: Array(32).fill(33) },
    ];
    const ataOf = new Map<string, PublicKey>();
    for (const b of BETS) {
      const ata = (
        await getOrCreateAssociatedTokenAccount(provider.connection, payer, usdc, b.kp.publicKey)
      ).address;
      ataOf.set(b.kp.publicKey.toBase58(), ata);
      await mintTo(provider.connection, payer, usdc, ata, payer, b.amount);
    }

    await program.methods
      .openMarket(u64(marketId), NUM_RACERS, payer.publicKey)
      .accounts({
        market,
        judge: judge.publicKey,
        vault,
        marketVaultAuthority: marketVaultAuthPda(market),
        usdcMint: usdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([judge])
      .rpc();

    for (const b of BETS) {
      await program.methods
        .placeBet(u64(marketId), b.lane, u64(b.amount), b.nul)
        .accounts({
          market,
          bettor: b.kp.publicKey,
          bettorToken: ataOf.get(b.kp.publicKey.toBase58())!,
          vault,
          bet: betPda(market, b.kp.publicKey),
          nullifier: nullifierPda(market, b.nul),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([b.kp])
        .rpc();
    }

    // A reused World ID nullifier must collide on the already-initialized PDA.
    const dup = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(dup.publicKey, 2e9);
    await provider.connection.confirmTransaction(sig);
    const dupAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, payer, usdc, dup.publicKey)
    ).address;
    await mintTo(provider.connection, payer, usdc, dupAta, payer, 1_000_000);
    let rejected = false;
    try {
      await program.methods
        .placeBet(u64(marketId), 0, u64(1_000_000), BETS[0].nul) // reuses winnerBig's nullifier
        .accounts({
          market,
          bettor: dup.publicKey,
          bettorToken: dupAta,
          vault,
          bet: betPda(market, dup.publicKey),
          nullifier: nullifierPda(market, BETS[0].nul),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([dup])
        .rpc();
    } catch {
      rejected = true;
    }
    assert.isTrue(rejected, "reused World ID nullifier should be rejected");

    // Judge settles lane 0 with the Gemini verdict hash + Walrus blob id.
    const proof = Array(32).fill(5);
    const blobId = "walrus-blob-abc123";
    await program.methods
      .settleMarket(u64(marketId), 0, proof, blobId)
      .accounts({ market, judge: judge.publicKey })
      .signers([judge])
      .rpc();

    // The finish proof must be persisted on-chain, not just emitted.
    const m = await program.account.market.fetch(market);
    assert.isTrue(m.settled);
    assert.equal(m.winner, 0);
    assert.equal(m.walrusBlobId, blobId);
    assert.deepEqual(Array.from(m.winningProofHash as number[]), proof);
    assert.isTrue(m.settledAt.toNumber() > 0);

    // Pool = 6 USDC, winning lane = 4 USDC (3 + 1). Pro-rata: winnerBig gets
    // 3*6/4 = 4.5 USDC, winnerSmall 1*6/4 = 1.5 USDC; together they drain the
    // whole 6 USDC pool (the loser's 2 USDC funds the winners' profit).
    const claimFor = async (kp: Keypair) => {
      const ata = ataOf.get(kp.publicKey.toBase58())!;
      const pre = await getAccount(provider.connection, ata);
      await program.methods
        .claim(u64(marketId))
        .accounts({
          market,
          bettor: kp.publicKey,
          bet: betPda(market, kp.publicKey),
          vault,
          marketVaultAuthority: marketVaultAuthPda(market),
          bettorToken: ata,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([kp])
        .rpc();
      const post = await getAccount(provider.connection, ata);
      return Number(post.amount - pre.amount);
    };

    assert.equal(await claimFor(winnerBig), 4_500_000);
    assert.equal(await claimFor(winnerSmall), 1_500_000);

    // The loser picked lane 1 and cannot claim against the winning pool.
    let lostRejected = false;
    try {
      await claimFor(loser);
    } catch {
      lostRejected = true;
    }
    assert.isTrue(lostRejected, "a losing bet must not be claimable");
  });
});
