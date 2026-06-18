/**
 * x402 on Solana — the SPL-USDC counterpart of Circle's EVM x402 Gateway.
 *
 * `solanaPaymentGate(amount)` returns Express middleware shaped like
 * `gateway.require(amount)`: with no/invalid `X-PAYMENT` it answers HTTP 402 and
 * an x402 `accepts` payment-requirements body describing the Solana payment;
 * with a valid `X-PAYMENT` (carrying a settled USDC-transfer signature) it
 * verifies the transfer on-chain against the treasury, then populates
 * `req.payment` ({ payer, amount, network, transaction }) so the existing
 * race-fee flow (x402RaceFeePayment / recordRaceJoinFee) works unchanged.
 *
 * This is the x402 "exact" scheme with facilitator-side verification of an
 * already-settled SPL transfer. Active only when CHAIN_BACKEND=solana.
 * See docs/SOLANA_PORT.md.
 */
import type { Request, Response, NextFunction } from "express";
import { Connection, PublicKey } from "@solana/web3.js";

import { solanaChainConfig } from "./solana-config.js";

const X402_VERSION = 1;
// Settled-payment signatures are single-use to prevent replay across requests.
const usedSignatures = new Set<string>();

function parseUsdcUnits(amount: string): bigint {
  const input = String(amount ?? "").trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,6})?$/.test(input)) throw new Error(`invalid USDC amount: ${amount}`);
  const [whole, frac = ""] = input.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

function networkLabel(cluster: string): string {
  if (cluster === "mainnet-beta" || cluster === "mainnet") return "solana";
  if (cluster === "devnet") return "solana-devnet";
  if (cluster === "testnet") return "solana-testnet";
  return "solana-localnet";
}

export function x402SolanaPublicConfig() {
  const cfg = solanaChainConfig();
  return {
    enabled: Boolean(cfg.treasury && cfg.usdcMint),
    scheme: "exact",
    network: networkLabel(cfg.cluster),
    cluster: cfg.cluster,
    rpcUrl: cfg.publicRpcUrl,
    asset: cfg.usdcMint,
    payTo: cfg.treasury,
    decimals: 6,
    raceNetworkFeeUsdc: cfg.defaultFeeUnits
      ? (Number(cfg.defaultFeeUnits) / 1e6).toFixed(2)
      : undefined,
    joinRoute: "/race/round/:id/join",
  };
}

function paymentRequiredBody(amountUsdc: string, requiredUnits: bigint, error?: string) {
  const cfg = solanaChainConfig();
  return {
    x402Version: X402_VERSION,
    error: error ?? "payment required",
    accepts: [
      {
        scheme: "exact",
        network: networkLabel(cfg.cluster),
        maxAmountRequired: requiredUnits.toString(),
        resource: "/race/round/:id/join",
        description: "Clanker 500 race network fee",
        mimeType: "application/json",
        payTo: cfg.treasury,
        asset: cfg.usdcMint,
        maxTimeoutSeconds: 120,
        extra: { decimals: 6, cluster: cfg.cluster, amountUsdc },
      },
    ],
  };
}

function decodePaymentHeader(header: string): Record<string, unknown> {
  // x402 sends X-PAYMENT as base64(JSON); accept raw JSON too for convenience.
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return JSON.parse(header);
  }
}

/**
 * Verify a settled USDC transfer to the treasury. Returns the net amount
 * credited to the treasury token account and the payer (the owner whose USDC
 * balance fell), reading parsed pre/post token balances.
 */
async function verifySolanaPayment(signature: string, requiredUnits: bigint) {
  const cfg = solanaChainConfig();
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const tx = await conn.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta) throw new Error("payment transaction not found");
  if (tx.meta.err) throw new Error("payment transaction failed");

  const keys = tx.transaction.message.accountKeys.map((k: any) =>
    (k.pubkey ?? k).toString()
  );
  const treasury = cfg.treasury;
  const mint = cfg.usdcMint;
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];

  const isTreasury = (b: any) =>
    b.mint === mint && (keys[b.accountIndex] === treasury || b.owner === treasury);
  const amountOf = (entry: any) => (entry ? BigInt(entry.uiTokenAmount.amount) : 0n);

  const postT = post.find(isTreasury);
  const preT = pre.find(isTreasury);
  const credited = amountOf(postT) - amountOf(preT);
  if (credited < requiredUnits) {
    throw new Error(`insufficient payment: credited ${credited}, need ${requiredUnits}`);
  }

  // Payer = owner of a USDC account whose balance decreased; fallback to fee payer.
  let payer = keys[0];
  for (const p of post) {
    if (p.mint !== mint) continue;
    const before = amountOf(pre.find((q: any) => q.accountIndex === p.accountIndex));
    if (amountOf(p) < before && p.owner) {
      payer = p.owner;
      break;
    }
  }
  return { payer, amount: credited };
}

export function solanaPaymentGate(amountUsdc: string) {
  const required = parseUsdcUnits(amountUsdc.replace(/^\$/, ""));
  const cfg = solanaChainConfig();
  const network = networkLabel(cfg.cluster);

  return async function (req: Request, res: Response, next: NextFunction) {
    const header = req.header("X-PAYMENT");
    if (!header) {
      return res.status(402).json(paymentRequiredBody(amountUsdc, required));
    }
    let payload: Record<string, unknown>;
    try {
      payload = decodePaymentHeader(header);
    } catch {
      return res.status(402).json(paymentRequiredBody(amountUsdc, required, "invalid X-PAYMENT header"));
    }
    const signature = String(
      payload.transaction ?? payload.signature ?? payload.txSignature ?? ""
    );
    if (!signature) {
      return res.status(402).json(paymentRequiredBody(amountUsdc, required, "missing payment transaction"));
    }
    if (usedSignatures.has(signature)) {
      return res.status(402).json(paymentRequiredBody(amountUsdc, required, "payment already used"));
    }
    try {
      const { payer, amount } = await verifySolanaPayment(signature, required);
      usedSignatures.add(signature);
      (req as any).payment = {
        payer,
        amount: amount.toString(),
        network,
        transaction: signature,
      };
      res.setHeader(
        "X-PAYMENT-RESPONSE",
        Buffer.from(JSON.stringify({ success: true, transaction: signature, network })).toString("base64")
      );
      next();
    } catch (e: any) {
      return res.status(402).json(paymentRequiredBody(amountUsdc, required, e.message));
    }
  };
}
