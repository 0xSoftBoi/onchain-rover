import "./env.js";
/**
 * Provision Privy server wallets for the fleet (real secp256k1 EOAs in Privy's
 * TEE). Run once:  npx tsx src/privy-provision.ts
 * Needs PRIVY_APP_ID + PRIVY_APP_SECRET (Privy dashboard → app settings).
 * Prints wallet ids + addresses — add to .env:
 *   PRIVY_WALLET_GUARD=<id>   PRIVY_WALLET_COURIER=<id>
 * Then fund the printed addresses with Arc USDC and set CUSTODY=privy to route
 * settlement through the enclave.
 */
import { client } from "./privy.js";

const wallets = client().wallets();
for (const role of ["guard", "courier"]) {
  const w: any = await wallets.create({ chainType: "ethereum" } as any);
  console.log(`${role}: id=${w.id ?? w.walletId}  address=${w.address}`);
}
console.log("\nAdd the ids to .env (PRIVY_WALLET_GUARD / PRIVY_WALLET_COURIER),");
console.log("fund the addresses with Arc USDC, then set CUSTODY=privy.");
