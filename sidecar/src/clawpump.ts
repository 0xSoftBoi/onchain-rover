/**
 * ClawPump integration — launch the winning rover's agent token on Solana.
 *
 * ClawPump (https://clawpump.tech, "Eternal AI Agents on Solana") is an
 * AI-agent token launchpad: an authenticated agent calls POST /api/launch with
 * { name, symbol, image, agentId }; ClawPump pays the ~0.02 SOL creation cost
 * and deploys the token on pump.fun's bonding curve. Every trade earns a 1%
 * creator fee, split (after the creation cost is recouped) 65% to the agent /
 * 35% to the platform, paid in SOL to the agent's registered wallet.
 * GET /api/fees/earnings reports accrued fees.
 *
 * This is the literal "clanker5000 native to Solana" hook: when a Clanker 500
 * race settles, the fleet can mint the winner's commemorative agent token via
 * ClawPump. Live calls require an agent API key (CLAWPUMP_API_KEY) issued from
 * the ClawPump dashboard; without it the helpers throw a clear error rather
 * than guessing. Field set follows the public docs; the exact base URL/auth are
 * configurable. See docs/SOLANA_PORT.md.
 */
import type { Round } from "./rounds.js";

export type ClawpumpConfig = {
  apiUrl: string;
  agentId: string;
  hasKey: boolean;
};

function apiUrl(): string {
  return (process.env.CLAWPUMP_API_URL ?? "https://clawpump.tech/api").replace(/\/$/, "");
}
function agentId(): string {
  return process.env.CLAWPUMP_AGENT_ID ?? "";
}
function apiKey(): string {
  const key = process.env.CLAWPUMP_API_KEY;
  if (!key) {
    throw new Error(
      "CLAWPUMP_API_KEY required — issue an agent key from the ClawPump dashboard (https://clawpump.tech)"
    );
  }
  return key;
}

export function clawpumpConfig(): ClawpumpConfig {
  return { apiUrl: apiUrl(), agentId: agentId(), hasKey: Boolean(process.env.CLAWPUMP_API_KEY) };
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`ClawPump ${method} ${path} returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`ClawPump ${method} ${path} failed (HTTP ${res.status}): ${json.error ?? text}`);
  }
  return json;
}

/** Launch an agent token on ClawPump (deploys on pump.fun's bonding curve). */
export async function launchAgentToken(opts: {
  name: string;
  symbol: string;
  image?: string;
  agentId?: string;
}): Promise<Record<string, unknown>> {
  const id = opts.agentId ?? agentId();
  if (!id) throw new Error("CLAWPUMP_AGENT_ID (or opts.agentId) required");
  return call("POST", "/launch", {
    name: opts.name,
    symbol: opts.symbol,
    image: opts.image,
    agentId: id,
  });
}

/** Accrued creator-fee earnings for the agent (65% of the 1% trade fee). */
export async function agentEarnings(): Promise<Record<string, unknown>> {
  return call("GET", "/fees/earnings");
}

/**
 * Mint the winning rover's commemorative token after a Clanker 500 race settles.
 * Symbol derived from the round id so it's deterministic and unique.
 */
export async function launchWinnerToken(round: Round): Promise<Record<string, unknown>> {
  if (!round.winner) throw new Error("round has no winner to commemorate");
  const robot = round.winner === "challenger" ? "Guard" : "Courier";
  const symbol = `C5K${round.id.slice(0, 4).toUpperCase()}`;
  return launchAgentToken({
    name: `Clanker 500 — ${robot} #${round.id}`,
    symbol,
    image: process.env.CLAWPUMP_DEFAULT_IMAGE,
  });
}
