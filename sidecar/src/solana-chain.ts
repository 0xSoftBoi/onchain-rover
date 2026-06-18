/**
 * Solana settlement backend (CHAIN_BACKEND=solana) — the native-Solana
 * counterpart of chain.ts. Drives the `clanker5000` Anchor program
 * (solana/programs/clanker5000) instead of the EVM RaceEscrow.
 *
 * It mirrors chain.ts's function surface so chain-backend.ts can dispatch to
 * either backend. Lifecycle transitions (open/lock/start/finish/settle/cancel)
 * are signed by the facilitator keypair. `join_race` is signed by the driver:
 * in production the driver's phone wallet signs the instruction built by
 * buildRaceEntryRequest; for local/dev runs a dev keypair is loaded from
 * SOLANA_DEV_KEYS_DIR. See docs/SOLANA_PORT.md.
 *
 * Requires the program IDL at src/generated/clanker5000.json (produced by
 * `anchor build`) and src/generated/contracts.solana.json (deployment).
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { BN, type Idl } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

import type { DriverSlot, Round } from "./rounds.js";
import { solanaChainConfig, publicSolanaChainConfig } from "./solana-config.js";

export { solanaChainConfig as localChainConfig, publicSolanaChainConfig as publicLocalChainConfig };

const enc = new TextEncoder();
const RACE_DECIMALS = 6;

// ---- low-level helpers -----------------------------------------------------

function parseSecretKey(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  // base58
  return Keypair.fromSecretKey(anchor.utils.bytes.bs58.decode(trimmed));
}

function facilitatorKeypair(): Keypair {
  const raw = process.env.FACILITATOR_SECRET_KEY;
  if (!raw) throw new Error("FACILITATOR_SECRET_KEY required for Solana settlement writes");
  return parseSecretKey(raw);
}

function connection(): Connection {
  return new Connection(solanaChainConfig().rpcUrl, "confirmed");
}

let cachedProgram: anchor.Program<Idl> | null = null;
function program(): anchor.Program<Idl> {
  if (cachedProgram) return cachedProgram;
  const idlUrl = new URL("./generated/clanker5000.json", import.meta.url);
  if (!fs.existsSync(idlUrl)) {
    throw new Error(
      "clanker5000 IDL missing; run `anchor build` and copy target/idl/clanker5000.json to sidecar/src/generated/clanker5000.json"
    );
  }
  const idl = JSON.parse(fs.readFileSync(idlUrl, "utf8"));
  const cfg = solanaChainConfig();
  idl.address = cfg.programId; // honor configured/deployed id
  const wallet = new anchor.Wallet(facilitatorKeypair());
  const provider = new anchor.AnchorProvider(connection(), wallet, { commitment: "confirmed" });
  // Untyped Program: avoids needing generated TS types in the sidecar build.
  cachedProgram = new (anchor.Program as any)(idl, provider) as anchor.Program<Idl>;
  return cachedProgram;
}

function pid(): PublicKey {
  return new PublicKey(solanaChainConfig().programId);
}
function usdcMint(): PublicKey {
  return new PublicKey(solanaChainConfig().usdcMint);
}
function leU64(n: number | bigint | string): Buffer {
  return new BN(n.toString()).toArrayLike(Buffer, "le", 8);
}
function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("config")], pid())[0];
}
function racePda(raceId: number | bigint | string): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("race"), leU64(raceId)], pid())[0];
}
function vaultPda(race: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("vault"), race.toBuffer()], pid())[0];
}
function vaultAuthPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("vault_auth")], pid())[0];
}
function ata(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(usdcMint(), owner);
}

function units(value: string): BN {
  const [whole, frac = ""] = String(value).split(".");
  const fracPadded = (frac + "0".repeat(RACE_DECIMALS)).slice(0, RACE_DECIMALS);
  return new BN(`${whole}${fracPadded}`.replace(/^0+(?=\d)/, ""));
}
function slotToIndex(slot: DriverSlot): number {
  return slot === "challenger" ? 0 : 1;
}
function proofBytes(round: Round): number[] {
  const explicit = String(round.proofHash ?? "").replace(/^0x/, "");
  const hex = /^[a-fA-F0-9]{64}$/.test(explicit)
    ? explicit
    : createHash("sha256").update(JSON.stringify(round.proof ?? {})).digest("hex");
  return Array.from(Buffer.from(hex, "hex"));
}
function driverKeypair(wallet: string): Keypair | null {
  const dir = process.env.SOLANA_DEV_KEYS_DIR;
  if (!dir) return null;
  const file = `${dir}/${wallet}.json`;
  if (!fs.existsSync(file)) return null;
  return parseSecretKey(fs.readFileSync(file, "utf8"));
}

// ---- lifecycle (facilitator-signed) ---------------------------------------

export async function openRoundOnChain(round: Round) {
  if (round.chainRaceId) return { raceId: round.chainRaceId, tx: round.txHashes?.open ?? "" };
  const p = program();
  const cfg = await (p.account as any).config.fetch(configPda());
  const raceId: BN = cfg.nextRaceId;
  const race = racePda(raceId.toString());
  const localRoundId = Array.from(createHash("sha256").update(round.id).digest());
  const tx = await (p.methods as any)
    .openRace(raceId, localRoundId, units(round.stakeUsdc), units(round.feeUsdc))
    .accounts({
      config: configPda(),
      facilitator: facilitatorKeypair().publicKey,
      race,
      vault: vaultPda(race),
      vaultAuthority: vaultAuthPda(),
      usdcMint: usdcMint(),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  return { raceId: raceId.toString(), tx };
}

/**
 * Build the join instruction for the driver's wallet to sign. On Solana the
 * driver is a transaction signer (no EIP-712 typed data / ERC-2612 permit), so
 * this returns a serialized instruction the phone wallet signs and submits.
 */
export async function buildRaceEntryRequest(round: Round, slot: DriverSlot, wallet?: string) {
  if (!round.chainRaceId) throw new Error("open the round on-chain first");
  const driver = round.drivers[slot];
  if (!driver?.wallet) throw new Error(`missing ${slot}`);
  if (wallet && wallet !== driver.wallet) throw new Error("wallet does not match driver slot");
  const cfg = solanaChainConfig();
  const driverPk = new PublicKey(driver.wallet);
  const race = racePda(round.chainRaceId);
  const p = program();
  const ix = await (p.methods as any)
    .joinRace(new BN(round.chainRaceId), slotToIndex(slot), units(round.stakeUsdc), units(round.feeUsdc))
    .accounts({
      config: configPda(),
      race,
      driver: driverPk,
      driverToken: ata(driverPk),
      vault: vaultPda(race),
      treasuryToken: new PublicKey(cfg.treasury),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return {
    chain: { cluster: cfg.cluster, rpcUrl: cfg.publicRpcUrl, name: "Clanker500 Solana", programId: cfg.programId },
    slot,
    instruction: {
      programId: ix.programId.toBase58(),
      keys: ix.keys.map((k: any) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      data: Buffer.from(ix.data).toString("base64"),
    },
  };
}

/**
 * Submit the driver's join. Production: the phone signs the instruction from
 * buildRaceEntryRequest. For local/dev runs we load the driver keypair from
 * SOLANA_DEV_KEYS_DIR and sign here (mirrors the EVM ALLOW_LOCAL_DEV_WALLETS path).
 */
export async function joinRoundOnChain(opts: {
  round: Round;
  slot: DriverSlot;
  entrySignature?: string;
  permitSignature?: string;
  entryDeadline?: string | number | bigint;
  permitDeadline?: string | number | bigint;
}) {
  if (!opts.round.chainRaceId) throw new Error("open the round on-chain first");
  const driver = opts.round.drivers[opts.slot];
  if (!driver?.wallet) throw new Error(`missing ${opts.slot}`);
  const signer = driverKeypair(driver.wallet);
  if (!signer) {
    throw new Error(
      "Solana join_race must be signed by the driver wallet; submit the instruction from buildRaceEntryRequest, or set SOLANA_DEV_KEYS_DIR for local dev"
    );
  }
  const p = program();
  const driverPk = signer.publicKey;
  const race = racePda(opts.round.chainRaceId);
  const tx = await (p.methods as any)
    .joinRace(new BN(opts.round.chainRaceId), slotToIndex(opts.slot), units(opts.round.stakeUsdc), units(opts.round.feeUsdc))
    .accounts({
      config: configPda(),
      race,
      driver: driverPk,
      driverToken: ata(driverPk),
      vault: vaultPda(race),
      treasuryToken: new PublicKey(solanaChainConfig().treasury),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([signer])
    .rpc();
  return { tx };
}

async function facilitatorRace(round: Round, method: string, extraArgs: unknown[] = []) {
  const raceId = requireChainRaceId(round);
  const p = program();
  const tx = await (p.methods as any)[method](new BN(raceId), ...extraArgs)
    .accounts({
      config: configPda(),
      facilitator: facilitatorKeypair().publicKey,
      race: racePda(raceId),
    })
    .rpc();
  return { tx };
}

export async function lockRoundOnChain(round: Round) {
  return facilitatorRace(round, "lockRace");
}
export async function startRoundOnChain(round: Round) {
  return facilitatorRace(round, "startRace");
}
export async function finishRoundOnChain(round: Round) {
  if (!round.winner) throw new Error("round winner required");
  return facilitatorRace(round, "finishRace", [slotToIndex(round.winner), proofBytes(round)]);
}

export async function settleRoundOnChain(round: Round) {
  if (!round.winner) throw new Error("round winner required");
  const raceId = requireChainRaceId(round);
  const winnerWallet = round.drivers[round.winner]?.wallet;
  if (!winnerWallet) throw new Error("winner wallet missing");
  const race = racePda(raceId);
  const p = program();
  const tx = await (p.methods as any)
    .settleRace(new BN(raceId))
    .accounts({
      config: configPda(),
      facilitator: facilitatorKeypair().publicKey,
      race,
      vault: vaultPda(race),
      vaultAuthority: vaultAuthPda(),
      winnerToken: ata(new PublicKey(winnerWallet)),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  return { tx };
}

export async function cancelRoundOnChain(round: Round, reason = "canceled") {
  const raceId = requireChainRaceId(round);
  const race = racePda(raceId);
  const fac = facilitatorKeypair().publicKey;
  const challengerWallet = round.drivers.challenger?.wallet;
  const opponentWallet = round.drivers.opponent?.wallet;
  const p = program();
  const tx = await (p.methods as any)
    .cancelRace(new BN(raceId), reason)
    .accounts({
      config: configPda(),
      facilitator: fac,
      race,
      vault: vaultPda(race),
      vaultAuthority: vaultAuthPda(),
      // Not-joined slots are ignored on-chain; fall back to the facilitator ATA.
      challengerToken: ata(challengerWallet ? new PublicKey(challengerWallet) : fac),
      opponentToken: ata(opponentWallet ? new PublicKey(opponentWallet) : fac),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  return { tx };
}

// ---- reads / faucet --------------------------------------------------------

export async function localChainHealth() {
  const cfg = solanaChainConfig();
  const conn = connection();
  const [slot, programInfo] = await Promise.all([
    conn.getSlot(),
    conn.getAccountInfo(pid()),
  ]);
  return {
    ok: programInfo !== null,
    chainId: cfg.cluster,
    blockNumber: slot.toString(),
    raceEscrow: cfg.programId,
    raceToken: cfg.usdcMint,
    escrowDeployed: programInfo !== null,
    tokenDeployed: (await conn.getAccountInfo(usdcMint())) !== null,
  };
}

export async function localTreasuryInfo() {
  const cfg = solanaChainConfig();
  const conn = connection();
  let balanceUnits = "0";
  try {
    const acct = await getAccount(conn, new PublicKey(cfg.treasury));
    balanceUnits = acct.amount.toString();
  } catch {
    /* treasury token account not yet created */
  }
  const config = await (program().account as any).config.fetch(configPda()).catch(() => null);
  const totalFeesUnits = config ? config.totalFeesCollected.toString() : "0";
  return {
    treasury: cfg.treasury,
    raceToken: cfg.usdcMint,
    balanceUnits,
    balance: formatUnits(balanceUnits),
    totalFeesUnits,
    totalFees: formatUnits(totalFeesUnits),
  };
}

export async function fundLocalWallet(wallet: string, amount = "100") {
  const raw = process.env.SOLANA_MINT_AUTHORITY_SECRET_KEY;
  if (!raw) throw new Error("SOLANA_MINT_AUTHORITY_SECRET_KEY required for local faucet");
  const authority = parseSecretKey(raw);
  const conn = connection();
  const owner = new PublicKey(wallet);
  const dest = await getOrCreateAssociatedTokenAccount(conn, authority, usdcMint(), owner);
  const value = units(amount);
  const tx = await mintTo(conn, authority, usdcMint(), dest.address, authority, BigInt(value.toString()));
  const acct = await getAccount(conn, dest.address);
  return {
    wallet,
    tx,
    amount,
    amountUnits: value.toString(),
    balance: formatUnits(acct.amount.toString()),
    balanceUnits: acct.amount.toString(),
  };
}

function formatUnits(raw: string): string {
  const n = BigInt(raw);
  const base = 10n ** BigInt(RACE_DECIMALS);
  return `${n / base}.${(n % base).toString().padStart(RACE_DECIMALS, "0")}`;
}
function requireChainRaceId(round: Round): string {
  if (!round.chainRaceId) throw new Error("round is not open on-chain");
  return round.chainRaceId;
}

// ---- EventPass (port of EventPass.sol) -------------------------------------

function passConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("pass_config")], pid())[0];
}
function passPda(passId: number | bigint | string): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("pass"), leU64(passId)], pid())[0];
}

/** Guard (facilitator) mints an access pass at the auction-settled price. */
export async function mintEventPass(to: string, priceUsdc6: string) {
  const p = program();
  const cfg = await (p.account as any).passConfig.fetch(passConfigPda());
  const passId: BN = cfg.nextId;
  const tx = await (p.methods as any)
    .mintPass(passId, new PublicKey(to), units(priceUsdc6))
    .accounts({
      passConfig: passConfigPda(),
      minter: facilitatorKeypair().publicKey,
      pass: passPda(passId.toString()),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { id: passId.toString(), to, priceUsdc6, tx };
}

/** holds(who): off-chain getProgramAccounts query (Solana idiom for balanceOf). */
export async function eventPassHolds(owner: string) {
  // Pass layout: discriminator(8) + id(8) + owner(32) -> owner offset = 16.
  const passes = await (program().account as any).pass.all([
    { memcmp: { offset: 16, bytes: owner } },
  ]);
  return {
    owner,
    holds: passes.length > 0,
    count: passes.length,
    passes: passes.map((a: any) => ({
      id: a.account.id.toString(),
      priceUsdc6: a.account.priceUsdc6.toString(),
    })),
  };
}

// ---- Treasury (port of Treasury.sol) ---------------------------------------

function treasuryConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("treasury_config")], pid())[0];
}
function treasuryVaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("treasury_vault")], pid())[0];
}
function treasuryAuthPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("treasury_auth")], pid())[0];
}

export async function treasuryBalance() {
  const conn = connection();
  let balanceUnits = "0";
  try {
    const acct = await getAccount(conn, treasuryVaultPda());
    balanceUnits = acct.amount.toString();
  } catch {
    /* vault not yet created */
  }
  return { vault: treasuryVaultPda().toBase58(), balanceUnits, balance: formatUnits(balanceUnits) };
}

/**
 * Build the owner-gated withdrawal instruction for the Ledger to clear-sign.
 * The sidecar never holds the treasury owner key — withdrawal is gated on a
 * physical Ledger Solana signature, mirroring the EVM ERC-7730 flow.
 */
export async function buildTreasuryWithdraw(recipientTokenAccount: string, amount: string) {
  const p = program();
  const cfg = await (p.account as any).treasuryConfig.fetch(treasuryConfigPda());
  const ix = await (p.methods as any)
    .withdrawTreasury(units(amount))
    .accounts({
      treasuryConfig: treasuryConfigPda(),
      owner: new PublicKey(cfg.owner),
      vault: treasuryVaultPda(),
      treasuryAuthority: treasuryAuthPda(),
      recipient: new PublicKey(recipientTokenAccount),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return {
    owner: new PublicKey(cfg.owner).toBase58(),
    amount,
    instruction: {
      programId: ix.programId.toBase58(),
      keys: ix.keys.map((k: any) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      data: Buffer.from(ix.data).toString("base64"),
    },
  };
}

// ---- AttestationConsumer (port of AttestationConsumer.sol, Chainlink CRE) ---

function attestConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("attest_config")], pid())[0];
}
function attestationPda(jobHash: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("attest"), jobHash], pid())[0];
}
function jobHashOf(job: string): Buffer {
  return createHash("sha256").update(job).digest();
}

/**
 * Land a consensus verdict for a job. In production the Chainlink DON's
 * forwarder signs this; for sim/demo the facilitator reports (allowed when the
 * configured forwarder is the default/zero key).
 */
export async function writeAttestation(job: string, score: number, proofHashHex?: string) {
  const p = program();
  const jh = jobHashOf(job);
  const hex = (proofHashHex ?? "").replace(/^0x/, "");
  const proof = /^[a-fA-F0-9]{64}$/.test(hex)
    ? Array.from(Buffer.from(hex, "hex"))
    : new Array(32).fill(0);
  const tx = await (p.methods as any)
    .writeAttestation(Array.from(jh), job, new BN(score), proof)
    .accounts({
      attestConfig: attestConfigPda(),
      reporter: facilitatorKeypair().publicKey,
      attestation: attestationPda(jh),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { job, score, verified: score >= 70, tx };
}

export async function getAttestation(job: string) {
  const acct = await (program().account as any).attestation.fetchNullable(attestationPda(jobHashOf(job)));
  if (!acct) return { job, exists: false, verified: false };
  return {
    job,
    exists: true,
    verified: acct.verified,
    score: acct.score.toString(),
    proofHash: Buffer.from(acct.proofHash).toString("hex"),
    timestamp: acct.timestamp.toString(),
  };
}

/** The gate downstream settlement reads (mint/payment/reputation). */
export async function isVerified(job: string): Promise<boolean> {
  return (await getAttestation(job)).verified;
}

// ---- Leaderboard (re-point of leaderboard.ts to the on-chain reputation) ----

function agentPda(agentId: number | bigint | string): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("agent"), leU64(agentId)], pid())[0];
}

/** Rank agents by the clanker5000 reputation accounts (count, then avg). */
export async function agentRanking(limit = 20) {
  const agents = await (program().account as any).agent.all();
  return agents
    .map((a: any) => {
      const count = Number(a.account.count.toString());
      const sum = Number(a.account.sum.toString());
      return {
        agentId: a.account.agentId.toString(),
        owner: a.account.owner.toBase58(),
        jobs: count,
        avgScore: count ? sum / count : null,
      };
    })
    .sort((x: any, y: any) => y.jobs - x.jobs || (y.avgScore ?? 0) - (x.avgScore ?? 0))
    .slice(0, limit);
}

export async function fleetReputation(agentIds: Array<string | number | bigint>) {
  return Promise.all(
    agentIds.map(async (id) => {
      const acct = await (program().account as any).agent.fetchNullable(agentPda(id));
      const count = acct ? Number(acct.count.toString()) : 0;
      const sum = acct ? Number(acct.sum.toString()) : 0;
      return { agentId: id.toString(), jobs: count, avgScore: count ? sum / count : null };
    })
  );
}
