import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { DriverSlot, Round } from "./rounds.js";

const BASE_SEPOLIA_CHAIN_ID = 84532;
const DEFAULT_BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const DEFAULT_STAKE_ETH = "0.0003";

const clanker500Abi = parseAbi([
  "function nextRaceId() view returns (uint256)",
  "function openRace(bytes32 localRoundId, uint256 stakeWei) returns (uint256)",
  "function joinRace(uint256 raceId, uint8 slot) payable",
  "function lockRace(uint256 raceId)",
  "function startRace(uint256 raceId)",
  "function finishRace(uint256 raceId, uint8 winnerSlot, bytes32 proofHash)",
  "function settleRace(uint256 raceId)",
  "function cancelRace(uint256 raceId,string reason)",
]);

export const BASE_SEPOLIA = {
  chainId: BASE_SEPOLIA_CHAIN_ID,
  chainIdHex: `0x${BASE_SEPOLIA_CHAIN_ID.toString(16)}`,
  name: "Base Sepolia",
  rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? DEFAULT_BASE_SEPOLIA_RPC,
  explorer: process.env.BASE_SEPOLIA_EXPLORER ?? "https://sepolia.basescan.org",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
} as const;

export function clanker500Config() {
  const stake = stakeWei();
  return {
    chain: {
      chainId: BASE_SEPOLIA.chainId,
      chainIdHex: BASE_SEPOLIA.chainIdHex,
      rpcUrl: BASE_SEPOLIA.rpcUrl,
      name: BASE_SEPOLIA.name,
      nativeCurrency: BASE_SEPOLIA.nativeCurrency,
      explorer: BASE_SEPOLIA.explorer,
    },
    escrowAddress: process.env.CLANKER500_ESCROW_ADDRESS || null,
    stakeWei: stake.toString(),
    stakeEth: formatEther(stake),
    stakeDisplay: `${formatEther(stake)} ETH`,
    tagMap: {
      guard: Number(process.env.CLANKER500_GUARD_TAG_ID ?? 1),
      courier: Number(process.env.CLANKER500_COURIER_TAG_ID ?? 2),
      finishA: Number(process.env.CLANKER500_FINISH_TAG_A ?? 20),
      finishB: Number(process.env.CLANKER500_FINISH_TAG_B ?? 21),
    },
  };
}

export async function openRoundOnChain(round: Round) {
  if (round.chainRaceId) {
    return { raceId: round.chainRaceId, tx: round.txHashes?.open ?? "" };
  }
  const client = publicClient();
  const wallet = facilitatorWallet();
  const raceId = await client.readContract({
    address: escrowAddress(),
    abi: clanker500Abi,
    functionName: "nextRaceId",
  });
  const tx = await wallet.writeContract({
    address: escrowAddress(),
    abi: clanker500Abi,
    functionName: "openRace",
    args: [keccak256(toBytes(round.id)), stakeWeiForRound(round)],
  });
  await wait(tx);
  return { raceId: raceId.toString(), tx };
}

export function buildJoinTransaction(round: Round, slot: DriverSlot, wallet: string) {
  if (!round.chainRaceId) throw new Error("open the Clanker500 escrow first");
  const driver = round.drivers[slot];
  if (!driver?.wallet) throw new Error(`${slot} has not claimed a wallet`);
  if (getAddress(driver.wallet) !== getAddress(wallet)) throw new Error("wallet does not match driver slot");
  const data = encodeFunctionData({
    abi: clanker500Abi,
    functionName: "joinRace",
    args: [BigInt(round.chainRaceId), slotToIndex(slot)],
  });
  return {
    chain: {
      chainId: BASE_SEPOLIA.chainId,
      chainIdHex: BASE_SEPOLIA.chainIdHex,
      rpcUrl: BASE_SEPOLIA.rpcUrl,
      name: BASE_SEPOLIA.name,
      nativeCurrency: BASE_SEPOLIA.nativeCurrency,
      explorer: BASE_SEPOLIA.explorer,
    },
    to: escrowAddress(),
    from: getAddress(wallet),
    value: `0x${stakeWeiForRound(round).toString(16)}`,
    valueWei: stakeWeiForRound(round).toString(),
    data,
    raceId: round.chainRaceId,
    slot,
    explorer: `${BASE_SEPOLIA.explorer}/address/${escrowAddress()}`,
  };
}

export async function verifyJoinTransaction(opts: {
  round: Round;
  slot: DriverSlot;
  wallet: string;
  txHash: string;
}) {
  const hash = normalizeHash(opts.txHash);
  const client = publicClient();
  const [receipt, tx] = await Promise.all([
    client.waitForTransactionReceipt({ hash, timeout: 120_000 }),
    client.getTransaction({ hash }),
  ]);
  if (receipt.status !== "success") throw new Error("join transaction failed");
  if (!tx.to || getAddress(tx.to) !== escrowAddress()) throw new Error("join transaction target mismatch");
  if (getAddress(tx.from) !== getAddress(opts.wallet)) throw new Error("join transaction sender mismatch");
  if (tx.value !== stakeWeiForRound(opts.round)) throw new Error("join transaction stake amount mismatch");
  const decoded = decodeFunctionData({ abi: clanker500Abi, data: tx.input });
  if (decoded.functionName !== "joinRace") throw new Error("join transaction function mismatch");
  const [raceId, slot] = decoded.args;
  if (raceId !== BigInt(opts.round.chainRaceId ?? "-1")) throw new Error("join transaction race id mismatch");
  if (slot !== slotToIndex(opts.slot)) throw new Error("join transaction slot mismatch");
  return {
    tx: hash,
    blockNumber: receipt.blockNumber.toString(),
    stakeWei: tx.value.toString(),
    explorer: `${BASE_SEPOLIA.explorer}/tx/${hash}`,
  };
}

export async function lockRoundOnChain(round: Round) {
  const tx = await facilitatorWallet().writeContract({
    address: escrowAddress(),
    abi: clanker500Abi,
    functionName: "lockRace",
    args: [chainRaceId(round)],
  });
  await wait(tx);
  return { tx };
}

export async function startRoundOnChain(round: Round) {
  const tx = await facilitatorWallet().writeContract({
    address: escrowAddress(),
    abi: clanker500Abi,
    functionName: "startRace",
    args: [chainRaceId(round)],
  });
  await wait(tx);
  return { tx };
}

export async function finishRoundOnChain(round: Round) {
  if (!round.winner) throw new Error("round winner required");
  const tx = await facilitatorWallet().writeContract({
    address: escrowAddress(),
    abi: clanker500Abi,
    functionName: "finishRace",
    args: [chainRaceId(round), slotToIndex(round.winner), proofHash(round)],
  });
  await wait(tx);
  return { tx };
}

export async function settleRoundOnChain(round: Round) {
  const tx = await facilitatorWallet().writeContract({
    address: escrowAddress(),
    abi: clanker500Abi,
    functionName: "settleRace",
    args: [chainRaceId(round)],
  });
  await wait(tx);
  return { tx };
}

export async function cancelRoundOnChain(round: Round, reason: string) {
  const tx = await facilitatorWallet().writeContract({
    address: escrowAddress(),
    abi: clanker500Abi,
    functionName: "cancelRace",
    args: [chainRaceId(round), reason],
  });
  await wait(tx);
  return { tx };
}

export function stakeWeiForRound(round: Round): bigint {
  const value = round.stakeWei ?? stakeWei().toString();
  if (!/^\d+$/.test(value)) throw new Error("native stake must be wei units");
  const wei = BigInt(value);
  if (wei <= 0n) throw new Error("native stake must be positive");
  return wei;
}

export function stakeWei(): bigint {
  const rawWei = process.env.CLANKER500_STAKE_WEI;
  if (rawWei) {
    if (!/^\d+$/.test(rawWei)) throw new Error("CLANKER500_STAKE_WEI must be wei units");
    return BigInt(rawWei);
  }
  return parseEther(process.env.CLANKER500_STAKE_ETH ?? DEFAULT_STAKE_ETH);
}

export function slotToIndex(slot: DriverSlot): 0 | 1 {
  return slot === "challenger" ? 0 : 1;
}

function publicClient() {
  return createPublicClient({ chain: baseSepoliaChain(), transport: http(BASE_SEPOLIA.rpcUrl) });
}

function facilitatorWallet() {
  const key = process.env.CLANKER500_FACILITATOR_PRIVATE_KEY;
  if (!key) throw new Error("CLANKER500_FACILITATOR_PRIVATE_KEY required");
  return createWalletClient({
    account: privateKeyToAccount(normalizeHash(key)),
    chain: baseSepoliaChain(),
    transport: http(BASE_SEPOLIA.rpcUrl),
  });
}

function baseSepoliaChain() {
  return defineChain({
    id: BASE_SEPOLIA.chainId,
    name: BASE_SEPOLIA.name,
    nativeCurrency: BASE_SEPOLIA.nativeCurrency,
    rpcUrls: { default: { http: [BASE_SEPOLIA.rpcUrl] } },
    blockExplorers: {
      default: { name: "BaseScan", url: BASE_SEPOLIA.explorer },
    },
  });
}

function escrowAddress(): Address {
  const value = process.env.CLANKER500_ESCROW_ADDRESS;
  if (!value) throw new Error("CLANKER500_ESCROW_ADDRESS required");
  return getAddress(value);
}

function chainRaceId(round: Round): bigint {
  if (!round.chainRaceId) throw new Error("round has no Clanker500 race id");
  return BigInt(round.chainRaceId);
}

function proofHash(round: Round): Hex {
  const hash = round.proofHash;
  if (hash && /^0x[a-fA-F0-9]{64}$/.test(hash)) return hash as Hex;
  return keccak256(toBytes(`${round.id}:${round.winner ?? "unknown"}`));
}

async function wait(tx: Hex) {
  await publicClient().waitForTransactionReceipt({ hash: tx });
}

function normalizeHash(value: string): Hex {
  if (!/^0x[a-fA-F0-9]+$/.test(value)) throw new Error("invalid hex value");
  return value as Hex;
}
