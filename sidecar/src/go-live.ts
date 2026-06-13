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
    new URL("../../out/EventPass.sol/EventPass.json", import.meta.url), "utf8"));
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

// 2b. deploy ReputationRegistry if not set
let rep = process.env.REPUTATION_ADDRESS;
if (!rep) {
  console.log("deploying ReputationRegistry...");
  const art = JSON.parse(readFileSync(
    new URL("../../out/ReputationRegistry.sol/ReputationRegistry.json", import.meta.url), "utf8"));
  const account = privateKeyToAccount(process.env.GUARD_PRIVATE_KEY as `0x${string}`);
  const w = createWalletClient({ account, chain: arcTestnet, transport: http() });
  const pub2 = createPublicClient({ chain: arcTestnet, transport: http() });
  const hash = await w.deployContract({ abi: art.abi, bytecode: art.bytecode.object });
  const r = await pub2.waitForTransactionReceipt({ hash });
  rep = r.contractAddress!;
  process.env.REPUTATION_ADDRESS = rep;
  console.log(`✅ ReputationRegistry deployed: ${rep}  (add to .env: REPUTATION_ADDRESS=${rep})`);
}

// 2c. deploy Treasury (owner = Ledger address if set, else guard for testing)
let treasury = process.env.TREASURY_CONTRACT;
if (!treasury) {
  console.log("deploying Treasury...");
  const art = JSON.parse(readFileSync(
    new URL("../../out/Treasury.sol/Treasury.json", import.meta.url), "utf8"));
  const account = privateKeyToAccount(process.env.GUARD_PRIVATE_KEY as `0x${string}`);
  const w = createWalletClient({ account, chain: arcTestnet, transport: http() });
  const pub3 = createPublicClient({ chain: arcTestnet, transport: http() });
  const ledgerOwner = getAddress(process.env.LEDGER_ADDRESS || ROBOTS.guard.wallet);
  const USDC = "0x3600000000000000000000000000000000000000";
  const hash = await w.deployContract({
    abi: art.abi, bytecode: art.bytecode.object, args: [USDC, ledgerOwner] });
  const r = await pub3.waitForTransactionReceipt({ hash });
  treasury = r.contractAddress!;
  process.env.TREASURY_CONTRACT = treasury;
  console.log(`✅ Treasury deployed: ${treasury} owner=${ledgerOwner}`);
  console.log(`   (add to .env: TREASURY_CONTRACT=${treasury})`);
}

// 2d. deploy RaceMarket (judge = guard, operator = treasury/Ledger)
let market = process.env.RACEMARKET_ADDRESS;
if (!market) {
  console.log("deploying RaceMarket...");
  const art = JSON.parse(readFileSync(
    new URL("../../out/RaceMarket.sol/RaceMarket.json", import.meta.url), "utf8"));
  const account = privateKeyToAccount(process.env.GUARD_PRIVATE_KEY as `0x${string}`);
  const w = createWalletClient({ account, chain: arcTestnet, transport: http() });
  const pub4 = createPublicClient({ chain: arcTestnet, transport: http() });
  const USDC = "0x3600000000000000000000000000000000000000";
  const operator = getAddress(process.env.LEDGER_ADDRESS || ROBOTS.guard.wallet);
  const hash = await w.deployContract({ abi: art.abi, bytecode: art.bytecode.object,
    args: [USDC, getAddress(ROBOTS.guard.wallet), operator] });
  const r = await pub4.waitForTransactionReceipt({ hash });
  market = r.contractAddress!;
  process.env.RACEMARKET_ADDRESS = market;
  console.log(`✅ RaceMarket deployed: ${market}  (add to .env: RACEMARKET_ADDRESS=${market})`);
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
console.log("recording reputation (flywheel)...");
const fb = await settle.giveFeedback({ agentId: 0, score: 95, skill: "guard" });
console.log(`✅ reputation: ${fb.explorer}`);
const sum = await settle.repSummary(0);
console.log(`✅ guard rep: ${sum.count} reviews, avg ${sum.avg}`);

// 5. verify the gate now opens
const holds = await settle.holdsPass(ROBOTS.courier.wallet);
console.log(`✅ courier holdsPass = ${holds}  ${holds ? "→ checkpoint ADMITS" : "??"}`);
console.log("\n🎉 full on-chain loop complete: haggle → pay → mint → admit");
