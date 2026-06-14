/**
 * Session authorization — the OPENING Ledger ceremony (bookends the withdraw).
 *
 * Before the robots do anything, a human operator clear-signs an EIP-712
 * "Authorize Onchain Rover fleet" message on their Ledger. It's GASLESS (a typed
 * message, not a tx) so it can't fail on gas/RPC mid-demo; the sidecar verifies
 * the signature and unlocks the show. Symmetric with the closing withdraw:
 * autonomous robots, human-held keys — human authority at both ends.
 *
 * All message fields are strings (no BigInt) so the typed data serializes cleanly
 * to the browser and back, and clear-signs legibly on the device.
 */
import { verifyTypedData, getAddress } from "viem";
import { arcTestnet } from "./settle.js";

const EVENT = process.env.DEMO_EVENT || "ETHGlobal NYC 2026";
const FLEET = "guard.rover.eth + courier.rover.eth";

type State = { authorized: boolean; operator?: string; event?: string; at?: number };
let state: State = { authorized: false };
let issued: any = null; // the exact typed data we last handed out, to verify against

export function authMessage(operator: string) {
  const domain = { name: "Onchain Rover", version: "1", chainId: arcTestnet.id } as const;
  const types = {
    Authorization: [
      { name: "operator", type: "address" },
      { name: "fleet", type: "string" },
      { name: "event", type: "string" },
      { name: "action", type: "string" },
      { name: "issuedAt", type: "string" },
    ],
  } as const;
  const message = {
    operator: getAddress(operator),
    fleet: FLEET,
    event: EVENT,
    action: "Authorize fleet to operate and earn for this session",
    issuedAt: new Date().toISOString(),
  };
  return { domain, types, primaryType: "Authorization" as const, message };
}

/** Issue a fresh message for `operator` and remember it for verification. */
export function issue(operator: string) {
  if (!operator) throw new Error("operator address required");
  issued = authMessage(operator);
  return issued;
}

/** Verify the device signature against the last-issued message; unlock on success. */
export async function verify(signature: string) {
  if (!issued) throw new Error("request the authorization message first");
  const ok = await verifyTypedData({
    address: issued.message.operator,
    domain: issued.domain,
    types: issued.types,
    primaryType: "Authorization",
    message: issued.message,
    signature: signature as `0x${string}`,
  });
  if (ok) {
    state = { authorized: true, operator: issued.message.operator,
              event: issued.message.event, at: Date.now() };
  }
  return { ok, ...state };
}

export function status() {
  return state;
}

export function reset() {
  state = { authorized: false };
  issued = null;
  return state;
}
