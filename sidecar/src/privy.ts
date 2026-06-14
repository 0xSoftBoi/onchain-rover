import "./env.js";
/**
 * Privy server-wallet custody for the rover fleet.
 *
 * Instead of robot private keys sitting in .env on the host, the signing keys
 * live in Privy's secure TEE. We sign settlement transactions via the Privy API
 * — the host never holds the key. This is the "agent wallet" the Privy AI-Agent
 * track wants, and it's a real custody upgrade, not a swap: settle.ts can route
 * through here (CUSTODY=privy) while the local-key path stays as a fallback.
 *
 * Provision wallets with `npx tsx src/privy-provision.ts`, then set in .env:
 *   PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_GUARD, PRIVY_WALLET_COURIER
 * Re-check method signatures against the installed @privy-io/node.
 */
import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";

const APP_ID = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;

let _client: PrivyClient | null = null;
export function client(): PrivyClient {
  if (!APP_ID || !APP_SECRET) throw new Error("PRIVY_APP_ID / PRIVY_APP_SECRET not set");
  if (!_client) _client = new PrivyClient({ appId: APP_ID, appSecret: APP_SECRET });
  return _client;
}

const WALLETS: Record<string, { id?: string; addr?: string }> = {
  guard: { id: process.env.PRIVY_WALLET_GUARD, addr: process.env.PRIVY_ADDR_GUARD },
  courier: { id: process.env.PRIVY_WALLET_COURIER, addr: process.env.PRIVY_ADDR_COURIER },
};

export function config() {
  const wallets = Object.fromEntries(
    Object.entries(WALLETS).map(([k, v]) => [k, v.addr ?? null]));
  return {
    configured: Boolean(APP_ID && APP_SECRET),
    custody: process.env.CUSTODY === "privy" ? "privy-tee" : "local-key",
    wallets,
  };
}

/** A viem account whose signing happens inside Privy's TEE (no local key).
 *  Uses Privy's official viem integration (handles BigInt→hex over the wire). */
export function privyAccount(walletId: string, address: `0x${string}`) {
  return createViemAccount(client(), { walletId, address });
}

/** Resolve a robot name to a Privy-backed viem account, or null if not provisioned. */
export function accountFor(name: string) {
  const w = WALLETS[name];
  if (!APP_ID || !APP_SECRET || !w?.id || !w?.addr) return null;
  return privyAccount(w.id, w.addr as `0x${string}`);
}
