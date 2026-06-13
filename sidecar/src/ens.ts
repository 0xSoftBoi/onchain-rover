/**
 * ENS fleet issuance via NameStone (offchain, gasless, instant) + live
 * resolution via viem (NO hardcoded values — ENS prize requirement).
 * Durin L2 upgrade path documented in plan if time allows.
 */
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { NAMESTONE, ensip25Key } from "./config.js";

const pub = createPublicClient({ chain: mainnet, transport: http() });

export async function issueSubname(opts: {
  label: string;            // "guard" | "courier"
  address: string;          // robot wallet
  agentId: string | number; // ERC-8004 id -> ENSIP-25 record
  description: string;
}) {
  const res = await fetch(NAMESTONE.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: NAMESTONE.apiKey,
    },
    body: JSON.stringify({
      domain: NAMESTONE.domain,
      name: opts.label,
      address: opts.address,
      text_records: {
        description: opts.description,
        "agent-context": `physical rover agent; skills: guard, deliver, race; pay: x402 USDC on ${"eip155:5042002"}`,
        [ensip25Key(opts.agentId)]: "1",
      },
    }),
  });
  if (!res.ok) throw new Error(`NameStone ${res.status}: ${await res.text()}`);
  return { name: `${opts.label}.${NAMESTONE.domain}`, ok: true };
}

export async function resolve(name: string) {
  const [address, description, context] = await Promise.all([
    pub.getEnsAddress({ name }),
    pub.getEnsText({ name, key: "description" }),
    pub.getEnsText({ name, key: "agent-context" }),
  ]);
  return { name, address, description, agentContext: context };
}
