/**
 * One-shot on-chain go-live: deploy EventPass (if needed) -> run a live Dutch
 * auction on the robots -> settle the negotiated price on Arc -> mint the pass
 * -> verify the courier now holds it. Run once wallets are funded:
 *     npx tsx src/go-live.ts
 */
import "./env.js";
import {
  createWalletClient, createPublicClient, http, getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { ROBOTS } from "./config.js";
import { arcTestnet } from "./settle.js";
import * as settle from "./settle.js";

const GUARD = ROBOTS.guard.url, COURIER = ROBOTS.courier.url;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const j = async (u: string, body?: any) =>
  (await fetch(u, body ? {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : {})).json();

// 1. pre-flight: funded?
const cBal = await settle.usdcBalance(ROBOTS.courier.wallet);
const gBal = await settle.usdcBalance(ROBOTS.guard.wallet);
console.log(`balances  courier=${cBal} guard=${gBal} (6dp USDC)`);
if (cBal === 0n || gBal === 0n) {
  console.error("✋ fund both wallets first (faucet.circle.com, Arc Testnet USDC)");
  process.exit(1);
}

// 2. deploy EventPass if not set
let pass = process.env.EVENTPASS_ADDRESS;
if (!pass) {
  console.log("deploying EventPass...");
  const art = JSON.parse(readFileSync(
    new URL("../../contracts/out/EventPass.sol/EventPass.json", import.meta.url), "utf8"));
  const account = privateKeyToAccount(process.env.GUARD_PRIVATE_KEY as `0x${string}`);
  const w = createWalletClient({ account, chain: arcTestnet, transport: http() });
  const pub = createPublicClient({ chain: arcTestnet, transport: http() });
  const hash = await w.deployContract({
    abi: art.abi, bytecode: art.bytecode.object,
    args: [getAddress(ROBOTS.guard.wallet)],
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  pass = r.contractAddress!;
  process.env.EVENTPASS_ADDRESS = pass;
  console.log(`✅ EventPass deployed: ${pass}  (add to .env: EVENTPASS_ADDRESS=${pass})`);
}

// 3. live Dutch auction on the robots
const aid = `live-${cBal}`.slice(0, 16);
console.log("🤠 starting Dutch auction on the robots...");
await j(`${COURIER}/negotiate/buy`, { budget: 1.25, auctionId: aid, timeout_secs: 60 });
await sleep(800);
await j(`${GUARD}/negotiate/sell`,
  { start: 2.0, floor: 0.5, step: 0.25, tick_secs: 4.0, auctionId: aid });

let deal: any = {};
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  deal = await j(`${GUARD}/negotiate/result?auctionId=${aid}`);
  if (deal.agreed !== undefined && !deal.pending) break;
}
if (!deal.agreed) { console.error("auction did not close:", deal); process.exit(1); }
const price = String(deal.price);
console.log(`✅ negotiated price: $${price}`);

// 4. settle on Arc + mint
console.log("paying on Arc...");
const pay = await settle.pay("courier", "guard", price);
console.log(`✅ paid: ${pay.explorer}`);
console.log("minting EventPass...");
const mint = await settle.mintPass("courier", price);
console.log(`✅ minted: ${mint.explorer}`);

// 5. verify the gate now opens
const holds = await settle.holdsPass(ROBOTS.courier.wallet);
console.log(`✅ courier holdsPass = ${holds}  ${holds ? "→ checkpoint ADMITS" : "??"}`);
console.log("\n🎉 full on-chain loop complete: haggle → pay → mint → admit");
