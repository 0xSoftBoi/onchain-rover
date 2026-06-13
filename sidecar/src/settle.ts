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
  parseAbi, parseUnits, getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC, ROBOTS } from "./config.js";

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

function wallet(pk: string) {
  return createWalletClient({
    account: privateKeyToAccount(pk as `0x${string}`),
    chain: arcTestnet, transport: http(),
  });
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
  const pk = KEYS()[from];
  if (!pk) throw new Error(`no private key for '${from}'`);
  const toAddr = getAddress(ROBOTS[to as keyof typeof ROBOTS]?.wallet ?? to);
  const value = parseUnits(amountUsdc, 6); // USDC token is 6dp
  const hash = await wallet(pk).writeContract({
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
