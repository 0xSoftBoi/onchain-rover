/**
 * Real World ID verification. The frontend runs IDKit (real widget, real app_id),
 * the user proves with World App, and we verify the proof server-side against
 * World's cloud verifier. The returned nullifier_hash is the real per-human
 * identifier that enforces one-bet-per-human. No fake nullifiers.
 *
 * Requires WORLD_APP_ID (app_...) from developer.world.org. Verification fails
 * loudly if unset — there is no mock fallback.
 */
const APP_ID = process.env.WORLD_APP_ID;          // app_...
const ACTION = process.env.WORLD_ACTION ?? "rover-gp-bet";
const RP_ID = process.env.WORLD_RP_ID;            // rp_... (World ID 4.0 managed RP)
// World ID 4.0 verifies against the RP endpoint; classic apps use /api/v2/verify/{app_id}.
const VERIFY_URL = process.env.WORLD_VERIFY_ENDPOINT
  ?? (RP_ID
    ? `https://developer.world.org/api/v4/verify/${RP_ID}`
    : `https://developer.worldcoin.org/api/v2/verify/${APP_ID}`);

export function config() {
  return { appId: APP_ID ?? null, action: ACTION, rpId: RP_ID ?? null, configured: Boolean(APP_ID) };
}

export type WorldProof = {
  nullifier_hash: string;
  merkle_root: string;
  proof: string;
  verification_level: string;
};

/** Verify a World ID proof with the cloud verifier. Returns the real nullifier. */
export async function verify(p: WorldProof, signal?: string) {
  if (!APP_ID) throw new Error("WORLD_APP_ID not set — World ID required, no fallback");
  const res = await fetch(VERIFY_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nullifier_hash: p.nullifier_hash,
      merkle_root: p.merkle_root,
      proof: p.proof,
      verification_level: p.verification_level,
      action: ACTION,
      ...(signal ? { signal } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error("World ID verify failed: " + (body.detail || body.code || res.status));
  }
  return { verified: true, nullifier: p.nullifier_hash, action: ACTION };
}
