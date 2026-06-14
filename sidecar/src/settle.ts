/**
 * On-chain settlement on Arc testnet — the negotiated auction price, for real.
 *
 * - pay(): courier EOA transfers the agreed USDC to the guard EOA on Arc.
 *   Arc uses USDC as gas, so the courier wallet pays its own gas in USDC.
 * - mintPass(): the guard (EventPass minter) mints the pass to the courier,
 *   recording the negotiated price on-chain.
 * - holdsPass(): read whether an address holds a pass (the checkpoint gate).
 *
 * EOAs (not smart wallets) by design — keeps us Gateway/x402-compatible later.
 */
import {
  createPublicClient, createWalletClient, defineChain, http,
  parseAbi, parseUnits, getAddress, encodeFunctionData, serializeTransaction,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC, ROBOTS } from "./config.js";
import * as privy from "./privy.js";

export const arcTestnet = defineChain({
  id: ARC.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, // gas is 18dp
  rpcUrls: { default: { http: [process.env.ARC_RPC ?? ARC.rpc] } },
  blockExplorers: { default: { name: "Arcscan", url: ARC.explorer } },
});

const pub = createPublicClient({ chain: arcTestnet, transport: http() });

const erc20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const eventPassAbi = parseAbi([
  "function mint(address to, uint256 priceUsdc6) returns (uint256)",
  "function holds(address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const repAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function setAgentOwner(uint256 agentId, address owner)",
  "function getSummary(uint256 agentId) view returns (uint256 count, int256 avgValue)",
]);

function wallet(pk: string) {
  return createWalletClient({
    account: privateKeyToAccount(pk as `0x${string}`),
    chain: arcTestnet, transport: http(),
  });
}

// Custody router: when CUSTODY=privy and a Privy server wallet is provisioned
// for this role, sign in Privy's TEE (no local key on the host); otherwise use
// the local key. Non-breaking — defaults to local.
function walletFor(role: string) {
  if (process.env.CUSTODY === "privy") {
    const acct = privy.accountFor(role);
    if (acct) return createWalletClient({ account: acct, chain: arcTestnet, transport: http() });
  }
  const pk = KEYS()[role];
  if (!pk) throw new Error(`no key/Privy wallet for '${role}'`);
  return wallet(pk);
}

// Read lazily so dotenv (loaded via env.ts) has populated process.env first.
const KEYS = (): Record<string, string | undefined> => ({
  guard: process.env.GUARD_PRIVATE_KEY,
  courier: process.env.COURIER_PRIVATE_KEY,
});

/** USDC (6dp) balance of an address on Arc. */
export async function usdcBalance(addr: string): Promise<bigint> {
  return pub.readContract({
    address: ARC.usdc as `0x${string}`, abi: erc20,
    functionName: "balanceOf", args: [getAddress(addr)],
  });
}

/** courier -> guard: transfer the negotiated USDC amount on Arc. */
export async function pay(from: string, to: string, amountUsdc: string) {
  const toAddr = getAddress(ROBOTS[to as keyof typeof ROBOTS]?.wallet ?? to);
  const value = parseUnits(amountUsdc, 6); // USDC token is 6dp
  const hash = await walletFor(from).writeContract({
    address: ARC.usdc as `0x${string}`, abi: erc20,
    functionName: "transfer", args: [toAddr, value],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return {
    tx: hash, status: receipt.status, from, to, amountUsdc,
    explorer: `${ARC.explorer}/tx/${hash}`,
  };
}

/** guard mints the EventPass to the buyer, recording the negotiated price. */
export async function mintPass(to: string, priceUsdc: string) {
  const pk = KEYS().guard;
  const pass = process.env.EVENTPASS_ADDRESS;
  if (!pk) throw new Error("no guard private key");
  if (!pass) throw new Error("EVENTPASS_ADDRESS not set (deploy EventPass first)");
  const toAddr = getAddress(ROBOTS[to as keyof typeof ROBOTS]?.wallet ?? to);
  const price6 = parseUnits(priceUsdc, 6);
  const hash = await wallet(pk).writeContract({
    address: pass as `0x${string}`, abi: eventPassAbi,
    functionName: "mint", args: [toAddr, price6],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return {
    tx: hash, status: receipt.status, to, priceUsdc,
    explorer: `${ARC.explorer}/tx/${hash}`,
  };
}

/** Does this address hold an EventPass? (the checkpoint gate) */
export async function holdsPass(addr: string): Promise<boolean> {
  const pass = process.env.EVENTPASS_ADDRESS;
  if (!pass) return false;
  return pub.readContract({
    address: pass as `0x${string}`, abi: eventPassAbi,
    functionName: "holds", args: [getAddress(addr)],
  });
}

// --- ERC-8004 reputation flywheel (on Arc) ---------------------------------
// The REQUESTER (treasury wallet) rates the agent after a completed job, tagged
// by skill, with the Walrus proof URI + hash. Feeds the leaderboard.
function requesterWallet() {
  const pk = process.env.TREASURY_PRIVATE_KEY as `0x${string}`;
  return createWalletClient({
    account: privateKeyToAccount(pk), chain: arcTestnet, transport: http(),
  });
}

export async function giveFeedback(opts: {
  agentId: number; score: number; skill: string;
  blobId?: string; sha256?: string;
}) {
  const reg = process.env.REPUTATION_ADDRESS;
  if (!reg) throw new Error("REPUTATION_ADDRESS not set (deploy ReputationRegistry)");
  const hash = await requesterWallet().writeContract({
    address: reg as `0x${string}`, abi: repAbi, functionName: "giveFeedback",
    args: [
      BigInt(opts.agentId), BigInt(opts.score), 0,
      opts.skill, "starred", "",
      opts.blobId ? `walrus://${opts.blobId}` : "",
      (opts.sha256 ? `0x${opts.sha256}` : `0x${"0".repeat(64)}`) as `0x${string}`,
    ],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { tx: hash, status: receipt.status, explorer: `${ARC.explorer}/tx/${hash}` };
}

// --- RaceMarket: real parimutuel betting + settlement on Arc ----------------
const raceAbi = parseAbi([
  "function openRace(uint8 numRacers) returns (uint256)",
  "function bet(uint256 raceId, uint8 racer, uint256 amount, uint256 worldNullifier)",
  "function settle(uint256 raceId, uint8 winner, bytes32 proofHash, string walrusBlobId)",
  "function nextRaceId() view returns (uint256)",
]);
const usdcApproveAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

function guardWallet() {
  return createWalletClient({
    account: privateKeyToAccount(process.env.GUARD_PRIVATE_KEY as `0x${string}`),
    chain: arcTestnet, transport: http(),
  });
}

/** Guard (judge) opens a race on-chain. Returns the raceId. */
export async function openRaceOnChain(numRacers = 2) {
  const market = process.env.RACEMARKET_ADDRESS;
  if (!market) throw new Error("RACEMARKET_ADDRESS not set (deploy RaceMarket)");
  const id = await pub.readContract({
    address: market as `0x${string}`, abi: raceAbi, functionName: "nextRaceId" });
  const hash = await guardWallet().writeContract({
    address: market as `0x${string}`, abi: raceAbi, functionName: "openRace", args: [numRacers] });
  await pub.waitForTransactionReceipt({ hash });
  return { raceId: Number(id), tx: hash };
}

/** Place a REAL on-chain parimutuel bet, staked by the treasury relayer on
 * behalf of a World-ID-verified human (nullifier stored on-chain = sybil guard). */
export async function betOnChain(raceId: number, racerIdx: number, amountUsdc: string, nullifier: string) {
  const market = process.env.RACEMARKET_ADDRESS;
  if (!market) throw new Error("RACEMARKET_ADDRESS not set");
  const value = parseUnits(amountUsdc, 6);
  const relayer = createWalletClient({
    account: privateKeyToAccount(process.env.TREASURY_PRIVATE_KEY as `0x${string}`),
    chain: arcTestnet, transport: http() });
  // approve USDC to the market if needed
  const owner = relayer.account.address;
  const allowance = await pub.readContract({
    address: ARC.usdc as `0x${string}`, abi: usdcApproveAbi, functionName: "allowance",
    args: [owner, market as `0x${string}`] });
  if (allowance < value) {
    const ah = await relayer.writeContract({
      address: ARC.usdc as `0x${string}`, abi: usdcApproveAbi, functionName: "approve",
      args: [market as `0x${string}`, parseUnits("1000000", 6)] });
    await pub.waitForTransactionReceipt({ hash: ah });
  }
  // nullifier -> uint256 (World nullifier_hash is a 0x… field element)
  const nullU = BigInt(nullifier);
  const hash = await relayer.writeContract({
    address: market as `0x${string}`, abi: raceAbi, functionName: "bet",
    args: [BigInt(raceId), racerIdx, value, nullU] });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { tx: hash, status: receipt.status, explorer: `${ARC.explorer}/tx/${hash}` };
}

/** Guard settles the race on-chain with the Gemini-verified finish proof. */
export async function settleRaceOnChain(raceId: number, winnerIdx: number, sha256: string, blobId: string) {
  const market = process.env.RACEMARKET_ADDRESS;
  if (!market) throw new Error("RACEMARKET_ADDRESS not set");
  const hash = await guardWallet().writeContract({
    address: market as `0x${string}`, abi: raceAbi, functionName: "settle",
    args: [BigInt(raceId), winnerIdx,
           (`0x${(sha256||"0".repeat(64)).replace(/^0x/,"")}`) as `0x${string}`, blobId || ""] });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { tx: hash, status: receipt.status, explorer: `${ARC.explorer}/tx/${hash}` };
}

// --- Treasury: Ledger-clear-signed withdrawal (governance climax) ----------
const treasuryAbi = parseAbi([
  "function withdraw(address to, uint256 amount)",
  "function balance() view returns (uint256)",
  "function owner() view returns (address)",
]);

/** Build an UNSIGNED EIP-1559 tx for Treasury.withdraw, for the Ledger to sign.
 * `from` = the connected Ledger address (needed for nonce). */
export async function buildWithdrawTx(from: string, to: string, amountUsdc: string) {
  const treasury = process.env.TREASURY_CONTRACT;
  if (!treasury) throw new Error("TREASURY_CONTRACT not set (deploy Treasury)");
  const data = encodeFunctionData({
    abi: treasuryAbi, functionName: "withdraw",
    args: [getAddress(to), parseUnits(amountUsdc, 6)],
  });
  const nonce = await pub.getTransactionCount({ address: getAddress(from) });
  const fees = await pub.estimateFeesPerGas();
  const tx = {
    to: getAddress(treasury), data, nonce, value: 0n,
    gas: 120000n, chainId: arcTestnet.id,
    maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    type: "eip1559" as const,
  };
  // serialize WITHOUT signature -> the exact bytes the Ledger signs
  const unsignedSerialized = serializeTransaction(tx);
  return {
    unsignedSerialized,
    // pass the tx fields back so broadcast can re-serialize WITH the signature
    tx: { ...tx, nonce, maxFeePerGas: tx.maxFeePerGas?.toString(),
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
          gas: tx.gas.toString(), value: "0" },
  };
}

/** Reconstruct the signed tx from the Ledger {r,s,v} and broadcast on Arc. */
export async function broadcastSigned(txFields: any, sig: { r: string; s: string; v: string | number }) {
  const tx = {
    to: getAddress(txFields.to), data: txFields.data as `0x${string}`,
    nonce: Number(txFields.nonce), value: 0n, gas: BigInt(txFields.gas),
    chainId: arcTestnet.id, type: "eip1559" as const,
    maxFeePerGas: BigInt(txFields.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(txFields.maxPriorityFeePerGas),
  };
  const vNum = typeof sig.v === "string" ? Number(sig.v) : sig.v;
  const yParity = vNum % 2 === 0 ? 1 : 0; // EIP-1559 uses yParity (0/1)
  const signed = serializeTransaction(tx, {
    r: ("0x" + sig.r.replace(/^0x/, "").padStart(64, "0")) as `0x${string}`,
    s: ("0x" + sig.s.replace(/^0x/, "").padStart(64, "0")) as `0x${string}`,
    yParity,
  });
  const hash = await pub.sendRawTransaction({ serializedTransaction: signed });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { tx: hash, status: receipt.status, explorer: `${ARC.explorer}/tx/${hash}` };
}

export async function treasuryInfo() {
  const treasury = process.env.TREASURY_CONTRACT;
  if (!treasury) return { deployed: false };
  const [bal, owner] = await Promise.all([
    pub.readContract({ address: treasury as `0x${string}`, abi: treasuryAbi, functionName: "balance" }),
    pub.readContract({ address: treasury as `0x${string}`, abi: treasuryAbi, functionName: "owner" }),
  ]);
  return { deployed: true, address: treasury, balanceUsdc6: (bal as bigint).toString(), owner };
}

export async function repSummary(agentId: number) {
  const reg = process.env.REPUTATION_ADDRESS;
  if (!reg) return { count: 0, avg: 0 };
  const [count, avg] = await pub.readContract({
    address: reg as `0x${string}`, abi: repAbi,
    functionName: "getSummary", args: [BigInt(agentId)],
  }) as [bigint, bigint];
  return { count: Number(count), avg: Number(avg) };
}
