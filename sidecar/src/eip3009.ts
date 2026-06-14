import "./env.js";
/**
 * EIP-3009 gasless settlement, handed off over the GibberLink channel.
 *
 * The buyer signs a USDC `TransferWithAuthorization` off-chain (its key never
 * moves). The signed authorization is transported robot->robot over GibberLink
 * (today: the network relay via /gibber/send -> peer /gibber/recv; tomorrow:
 * ggwave over sound — SAME call site, zero change here). The seller/facilitator
 * then submits it on-chain, paying the gas. The buyer pays ZERO gas.
 *
 * This is a real gasless pull-payment, not a plain transfer(): the value moves
 * because the payer SIGNED an authorization, and a different party broadcasts it.
 *
 * Verified prerequisite: Arc USDC (0x36..00) implements EIP-3009 — name "USDC",
 * version "2", authorizationState() present.
 */
import {
  createPublicClient, createWalletClient, defineChain, http,
  parseUnits, getAddress, parseSignature, recoverTypedDataAddress,
  type Hex, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { ARC, ROBOTS, type RobotName } from "./config.js";

const arcTestnet = defineChain({
  id: ARC.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC ?? ARC.rpc] } },
  blockExplorers: { default: { name: "Arcscan", url: ARC.explorer } },
});
const pub = createPublicClient({ chain: arcTestnet, transport: http() });

// EIP-3009 domain for Arc USDC (probed live: name "USDC", version "2").
const DOMAIN = {
  name: "USDC",
  version: "2",
  chainId: ARC.chainId,
  verifyingContract: ARC.usdc as Address,
} as const;
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const TWA_ABI = [{
  type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable",
  inputs: [
    { name: "from", type: "address" }, { name: "to", type: "address" },
    { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
  ], outputs: [],
}] as const;

const KEYS = (): Record<string, string | undefined> => ({
  guard: process.env.GUARD_PRIVATE_KEY,
  courier: process.env.COURIER_PRIVATE_KEY,
});
function accountFor(role: string) {
  const pk = KEYS()[role];
  if (!pk) throw new Error(`no private key for '${role}'`);
  return privateKeyToAccount(pk as Hex);
}
function addrFor(role: string): Address {
  return getAddress(ROBOTS[role as RobotName]?.wallet ?? "");
}

export interface SignedAuthorization {
  from: Address; to: Address; value: string;
  validAfter: string; validBefore: string; nonce: Hex; signature: Hex;
}

/** Buyer signs a gasless USDC transfer authorization. Key never leaves. */
export async function signAuthorization(
  buyerRole: string, sellerRole: string, amountUsdc: string,
): Promise<SignedAuthorization> {
  const account = accountFor(buyerRole);
  const from = getAddress(account.address);
  const to = addrFor(sellerRole);
  const value = parseUnits(amountUsdc, 6); // USDC = 6dp
  const now = Math.floor(Date.now() / 1000);
  const message = {
    from, to, value,
    validAfter: 0n,
    validBefore: BigInt(now + 600), // 10-min window
    nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
  };
  const signature = await account.signTypedData({
    domain: DOMAIN, types: TYPES, primaryType: "TransferWithAuthorization", message,
  });
  return {
    from, to, value: value.toString(),
    validAfter: message.validAfter.toString(),
    validBefore: message.validBefore.toString(),
    nonce: message.nonce, signature,
  };
}

/** Independently verify the authorization recovers to the claimed buyer. */
export async function verifyAuthorization(a: SignedAuthorization): Promise<boolean> {
  const signer = await recoverTypedDataAddress({
    domain: DOMAIN, types: TYPES, primaryType: "TransferWithAuthorization",
    message: {
      from: a.from, to: a.to, value: BigInt(a.value),
      validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce,
    },
    signature: a.signature,
  });
  return getAddress(signer) === getAddress(a.from);
}

/**
 * Full flow: buyer signs -> authorization travels over the GibberLink channel
 * (buyer /gibber/send -> peer mirror -> seller /gibber/recv) -> seller verifies
 * and submits on-chain. Swapping the relay for ggwave-over-sound is a robot-side
 * change only; this orchestration is unchanged.
 */
export async function settleOverGibber(
  buyerRole: string, sellerRole: string, amountUsdc: string,
) {
  const buyerUrl = ROBOTS[buyerRole as RobotName]?.url;
  const sellerUrl = ROBOTS[sellerRole as RobotName]?.url;
  if (!buyerUrl || !sellerUrl) throw new Error("missing robot URL(s)");

  // 1. buyer signs locally — key never leaves the buyer's custody
  const auth = await signAuthorization(buyerRole, sellerRole, amountUsdc);
  const payload = JSON.stringify({ kind: "x402-eip3009", ...auth });

  // 2. transport over GibberLink: buyer.send -> peer mirror -> seller.inbox
  await fetch(`${buyerUrl}/gibber/send`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });

  // 3. seller pulls it off its gibber channel (skip any stale negotiation msgs)
  let got: SignedAuthorization & { kind?: string } | null = null;
  for (let i = 0; i < 6 && !got; i++) {
    const r = await (await fetch(`${sellerUrl}/gibber/recv?timeout_secs=6`)).json();
    if (!r.payload) break;
    try { const p = JSON.parse(r.payload); if (p.kind === "x402-eip3009") got = p; } catch {}
  }
  if (!got) throw new Error("authorization did not arrive over gibber");

  // 4. seller verifies the signature locally, then settles on-chain (seller gas)
  const verified = await verifyAuthorization(got);
  if (!verified) throw new Error("signature failed verification at seller");
  const onchain = await submitAuthorization(sellerRole, got);
  return {
    transportedOverGibber: true, verifiedAtSeller: verified,
    buyerGas: "0", amountUsdc, ...onchain,
  };
}

/** Seller/facilitator submits the signed authorization on-chain (pays gas). */
export async function submitAuthorization(submitterRole: string, a: SignedAuthorization) {
  const wallet = createWalletClient({
    account: accountFor(submitterRole), chain: arcTestnet, transport: http(),
  });
  const { r, s, v, yParity } = parseSignature(a.signature);
  const vByte = v ?? BigInt(27 + (yParity ?? 0));
  const hash = await wallet.writeContract({
    address: ARC.usdc as Address, abi: TWA_ABI, functionName: "transferWithAuthorization",
    args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore),
           a.nonce, Number(vByte), r, s],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { tx: hash, status: receipt.status, explorer: `${ARC.explorer}/tx/${hash}` };
}
