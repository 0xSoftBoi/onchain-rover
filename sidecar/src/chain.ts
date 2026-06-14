import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseSignature,
  parseUnits,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { DriverSlot, Round } from "./rounds.js";

const deploymentUrl = new URL("./generated/contracts.local.json", import.meta.url);

const raceEscrowAbi = parseAbi([
  "function nextRaceId() view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
  "function openRace(bytes32 localRoundId, uint256 stakeAmount, uint256 feeAmount) returns (uint256)",
  "function joinWithAuthorization(uint256 raceId,address driver,uint8 slot,uint256 stakeAmount,uint256 feeAmount,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
  "function joinWithAuthorizationAndPermit(uint256 raceId,address driver,uint8 slot,uint256 stakeAmount,uint256 feeAmount,uint256 deadline,uint8 v,bytes32 r,bytes32 s,uint256 permitDeadline,uint8 permitV,bytes32 permitR,bytes32 permitS)",
  "function lockRace(uint256 raceId)",
  "function startRace(uint256 raceId)",
  "function finishRace(uint256 raceId,uint8 winnerSlot,bytes32 proofHash)",
  "function settleRace(uint256 raceId)",
  "function cancelRace(uint256 raceId,string reason)",
  "function totalFeesCollected() view returns (uint256)",
]);

const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);

type Deployment = {
  chainId: number;
  rpcUrl: string;
  publicRpcUrl?: string;
  accounts: {
    treasury: Address;
    facilitator: Address;
  };
  contracts: {
    RaceToken: Address;
    RaceEscrow: Address;
  };
  defaults: {
    stakeUnits: string;
    feeUnits: string;
  };
};

type LocalChainConfig = {
  chainId: number;
  rpcUrl: string;
  publicRpcUrl: string;
  sidecarUrl: string;
  raceToken: Address;
  raceEscrow: Address;
  treasury: Address;
  facilitator: Address;
  defaultStakeUnits: string;
  defaultFeeUnits: string;
};

export type TypedDataEnvelope = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

export function localChainConfig(): LocalChainConfig {
  const deployment = readDeployment();
  return {
    chainId: Number(process.env.LOCAL_CHAIN_ID ?? deployment.chainId),
    rpcUrl: process.env.LOCAL_CHAIN_RPC_URL ?? deployment.rpcUrl,
    publicRpcUrl: process.env.PUBLIC_LOCAL_CHAIN_RPC_URL ?? deployment.publicRpcUrl ?? deployment.rpcUrl,
    sidecarUrl: process.env.PUBLIC_SIDECAR_URL ?? "",
    raceToken: getAddress(process.env.RACE_TOKEN_ADDRESS ?? deployment.contracts.RaceToken),
    raceEscrow: getAddress(process.env.RACE_ESCROW_ADDRESS ?? deployment.contracts.RaceEscrow),
    treasury: getAddress(process.env.LOCAL_TREASURY_ADDRESS ?? deployment.accounts.treasury),
    facilitator: getAddress(process.env.LOCAL_FACILITATOR_ADDRESS ?? deployment.accounts.facilitator),
    defaultStakeUnits: deployment.defaults.stakeUnits,
    defaultFeeUnits: deployment.defaults.feeUnits,
  };
}

export function publicLocalChainConfig() {
  const cfg = localChainConfig();
  return {
    chainId: cfg.chainId,
    rpcUrl: cfg.publicRpcUrl,
    backendRpcUrl: cfg.rpcUrl,
    sidecarUrl: cfg.sidecarUrl,
    raceToken: cfg.raceToken,
    raceEscrow: cfg.raceEscrow,
    treasury: cfg.treasury,
    facilitator: cfg.facilitator,
    defaultStakeUnits: cfg.defaultStakeUnits,
    defaultFeeUnits: cfg.defaultFeeUnits,
  };
}

export async function localChainHealth() {
  const cfg = localChainConfig();
  const client = publicClient();
  const [blockNumber, escrowCode, tokenCode] = await Promise.all([
    client.getBlockNumber(),
    client.getCode({ address: cfg.raceEscrow }),
    client.getCode({ address: cfg.raceToken }),
  ]);
  return {
    ok: escrowCode !== undefined && tokenCode !== undefined,
    chainId: cfg.chainId,
    blockNumber: blockNumber.toString(),
    raceEscrow: cfg.raceEscrow,
    raceToken: cfg.raceToken,
    escrowDeployed: Boolean(escrowCode && escrowCode !== "0x"),
    tokenDeployed: Boolean(tokenCode && tokenCode !== "0x"),
  };
}

export async function openRoundOnChain(round: Round) {
  if (round.chainRaceId) {
    return { raceId: round.chainRaceId, tx: round.txHashes?.open ?? "" };
  }
  const cfg = localChainConfig();
  const client = publicClient();
  const wallet = facilitatorWallet();
  const raceId = await client.readContract({
    address: cfg.raceEscrow,
    abi: raceEscrowAbi,
    functionName: "nextRaceId",
  });
  const tx = await wallet.writeContract({
    address: cfg.raceEscrow,
    abi: raceEscrowAbi,
    functionName: "openRace",
    args: [keccak256(toBytes(round.id)), parseRaceUnits(round.stakeUsdc), parseRaceUnits(round.feeUsdc)],
  });
  await wait(tx);
  return { raceId: raceId.toString(), tx };
}

export async function buildRaceEntryRequest(round: Round, slot: DriverSlot, wallet?: string) {
  if (!round.chainRaceId) throw new Error("open the round on-chain first");
  const driver = round.drivers[slot];
  if (!driver) throw new Error(`missing ${slot}`);
  if (wallet && getAddress(wallet) !== getAddress(driver.wallet)) {
    throw new Error("wallet does not match driver slot");
  }

  const cfg = localChainConfig();
  const client = publicClient();
  const latestBlock = await client.getBlock({ blockTag: "latest" });
  const deadline = latestBlock.timestamp + BigInt(Number(process.env.LOCAL_RACE_AUTH_TTL_SECS ?? 3600));
  const stakeAmount = parseRaceUnits(round.stakeUsdc);
  const feeAmount = parseRaceUnits(round.feeUsdc);
  const totalAmount = stakeAmount + feeAmount;
  const driverAddress = getAddress(driver.wallet);
  const [raceNonce, tokenNonce, tokenName] = await Promise.all([
    client.readContract({
      address: cfg.raceEscrow,
      abi: raceEscrowAbi,
      functionName: "nonces",
      args: [driverAddress],
    }),
    client.readContract({
      address: cfg.raceToken,
      abi: tokenAbi,
      functionName: "nonces",
      args: [driverAddress],
    }),
    client.readContract({
      address: cfg.raceToken,
      abi: tokenAbi,
      functionName: "name",
    }),
  ]);

  const entry: TypedDataEnvelope = {
    domain: {
      name: "RoverRace",
      version: "1",
      chainId: cfg.chainId,
      verifyingContract: cfg.raceEscrow,
    },
    types: {
      RaceEntry: [
        { name: "raceId", type: "uint256" },
        { name: "driver", type: "address" },
        { name: "slot", type: "uint8" },
        { name: "stakeAmount", type: "uint256" },
        { name: "feeAmount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "RaceEntry",
    message: {
      raceId: round.chainRaceId,
      driver: driverAddress,
      slot: slotToIndex(slot),
      stakeAmount: stakeAmount.toString(),
      feeAmount: feeAmount.toString(),
      nonce: raceNonce.toString(),
      deadline: deadline.toString(),
    },
  };

  const permit: TypedDataEnvelope = {
    domain: {
      name: tokenName,
      version: "1",
      chainId: cfg.chainId,
      verifyingContract: cfg.raceToken,
    },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: {
      owner: driverAddress,
      spender: cfg.raceEscrow,
      value: totalAmount.toString(),
      nonce: tokenNonce.toString(),
      deadline: deadline.toString(),
    },
  };

  return {
    chain: {
      chainId: cfg.chainId,
      chainIdHex: `0x${cfg.chainId.toString(16)}`,
      rpcUrl: cfg.publicRpcUrl,
      name: "Clanker500 Local",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    },
    slot,
    entry,
    permit,
  };
}

export async function joinRoundOnChain(opts: {
  round: Round;
  slot: DriverSlot;
  entrySignature: Hex;
  permitSignature?: Hex;
  entryDeadline: string | number | bigint;
  permitDeadline?: string | number | bigint;
}) {
  if (!opts.round.chainRaceId) throw new Error("open the round on-chain first");
  const driver = opts.round.drivers[opts.slot];
  if (!driver) throw new Error(`missing ${opts.slot}`);
  const cfg = localChainConfig();
  const wallet = facilitatorWallet();
  const entry = parseSignature(opts.entrySignature);
  const stakeAmount = parseRaceUnits(opts.round.stakeUsdc);
  const feeAmount = parseRaceUnits(opts.round.feeUsdc);
  const baseArgs = [
    BigInt(opts.round.chainRaceId),
    getAddress(driver.wallet),
    slotToIndex(opts.slot),
    stakeAmount,
    feeAmount,
    BigInt(opts.entryDeadline),
    Number(entry.v),
    entry.r,
    entry.s,
  ] as const;

  let tx: Hex;
  if (opts.permitSignature) {
    const permit = parseSignature(opts.permitSignature);
    tx = await wallet.writeContract({
      address: cfg.raceEscrow,
      abi: raceEscrowAbi,
      functionName: "joinWithAuthorizationAndPermit",
      args: [
        ...baseArgs,
        BigInt(opts.permitDeadline ?? opts.entryDeadline),
        Number(permit.v),
        permit.r,
        permit.s,
      ],
    });
  } else {
    tx = await wallet.writeContract({
      address: cfg.raceEscrow,
      abi: raceEscrowAbi,
      functionName: "joinWithAuthorization",
      args: baseArgs,
    });
  }
  await wait(tx);
  return { tx };
}

export async function lockRoundOnChain(round: Round) {
  return writeRaceTx(round, "lockRace", [BigInt(requireChainRaceId(round))]);
}

export async function startRoundOnChain(round: Round) {
  return writeRaceTx(round, "startRace", [BigInt(requireChainRaceId(round))]);
}

export async function finishRoundOnChain(round: Round) {
  if (!round.winner) throw new Error("round winner required");
  const proofHash = round.proofHash ? normalizeHash(round.proofHash) : proofToHash(round.proof);
  return writeRaceTx(round, "finishRace", [
    BigInt(requireChainRaceId(round)),
    slotToIndex(round.winner),
    proofHash,
  ]);
}

export async function settleRoundOnChain(round: Round) {
  return writeRaceTx(round, "settleRace", [BigInt(requireChainRaceId(round))]);
}

export async function cancelRoundOnChain(round: Round, reason = "canceled") {
  return writeRaceTx(round, "cancelRace", [BigInt(requireChainRaceId(round)), reason]);
}

export async function localTreasuryInfo() {
  const cfg = localChainConfig();
  const client = publicClient();
  const [balance, totalFees] = await Promise.all([
    client.readContract({
      address: cfg.raceToken,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [cfg.treasury],
    }),
    client.readContract({
      address: cfg.raceEscrow,
      abi: raceEscrowAbi,
      functionName: "totalFeesCollected",
    }),
  ]);
  return {
    treasury: cfg.treasury,
    raceToken: cfg.raceToken,
    balanceUnits: balance.toString(),
    balance: formatUnits(balance, 6),
    totalFeesUnits: totalFees.toString(),
    totalFees: formatUnits(totalFees, 6),
  };
}

export async function fundLocalWallet(wallet: string, amount = "100") {
  const cfg = localChainConfig();
  const privateKey = process.env.LOCAL_TOKEN_OWNER_PRIVATE_KEY as Hex | undefined;
  if (!privateKey) {
    throw new Error("LOCAL_TOKEN_OWNER_PRIVATE_KEY required for local faucet");
  }
  const owner = createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: localChain(),
    transport: http(cfg.rpcUrl),
  });
  const to = getAddress(wallet);
  const value = parseRaceUnits(amount);
  const tx = await owner.writeContract({
    address: cfg.raceToken,
    abi: tokenAbi,
    functionName: "mint",
    args: [to, value],
  });
  await wait(tx);
  const balance = await publicClient().readContract({
    address: cfg.raceToken,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [to],
  });
  return {
    wallet: to,
    tx,
    amount,
    amountUnits: value.toString(),
    balance: formatUnits(balance, 6),
    balanceUnits: balance.toString(),
  };
}

function readDeployment(): Deployment {
  if (!fs.existsSync(deploymentUrl)) {
    throw new Error("local chain deployment missing; run npm run chain:deploy");
  }
  return JSON.parse(fs.readFileSync(deploymentUrl, "utf8"));
}

function localChain() {
  const cfg = localChainConfig();
  return defineChain({
    id: cfg.chainId,
    name: "Clanker500 Local",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

function publicClient() {
  const cfg = localChainConfig();
  return createPublicClient({ chain: localChain(), transport: http(cfg.rpcUrl) });
}

function facilitatorWallet() {
  const cfg = localChainConfig();
  const privateKey = (process.env.FACILITATOR_PRIVATE_KEY ??
    process.env.LOCAL_FACILITATOR_PRIVATE_KEY) as Hex | undefined;
  if (!privateKey) {
    throw new Error("LOCAL_FACILITATOR_PRIVATE_KEY required for local chain writes");
  }
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: localChain(),
    transport: http(cfg.rpcUrl),
  });
}

async function wait(hash: Hex) {
  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction failed: ${hash}`);
  return receipt;
}

async function writeRaceTx(round: Round, functionName: string, args: readonly unknown[]) {
  const cfg = localChainConfig();
  const tx = await facilitatorWallet().writeContract({
    address: cfg.raceEscrow,
    abi: raceEscrowAbi,
    functionName: functionName as any,
    args: args as any,
  });
  await wait(tx);
  return { tx };
}

function parseRaceUnits(value: string): bigint {
  return parseUnits(value, 6);
}

function slotToIndex(slot: DriverSlot): 0 | 1 {
  return slot === "challenger" ? 0 : 1;
}

function requireChainRaceId(round: Round): string {
  if (!round.chainRaceId) throw new Error("round is not open on-chain");
  return round.chainRaceId;
}

function proofToHash(proof?: Record<string, unknown>): Hex {
  const explicit = String(proof?.proofHash ?? proof?.sha256 ?? "").replace(/^0x/, "");
  if (/^[a-fA-F0-9]{64}$/.test(explicit)) return `0x${explicit}`;
  return `0x${createHash("sha256").update(JSON.stringify(proof ?? {})).digest("hex")}`;
}

function normalizeHash(value: string): Hex {
  const hash = value.replace(/^0x/, "");
  if (!/^[a-fA-F0-9]{64}$/.test(hash)) throw new Error("proofHash must be bytes32");
  return `0x${hash}`;
}
