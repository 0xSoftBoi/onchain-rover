/**
 * Demo doctor — one command that checks every dependency and prints a
 * green/red readiness board before judging.  npx tsx src/preflight.ts
 */
import "./env.js";
import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { mainnet, sepolia, worldchain } from "viem/chains";
import { ARC, ROBOTS } from "./config.js";
import { arcTestnet } from "./settle.js";

const ok = (b: boolean) => (b ? "✅" : "❌");
const rows: { ok: boolean; label: string; detail: string }[] = [];
const check = (label: string, pass: boolean, detail = "") => rows.push({ ok: pass, label, detail });

const arc = createPublicClient({ chain: arcTestnet, transport: http() });
const usdcAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const codeAt = (c: any, a?: string) => a ? c.getBytecode({ address: a as `0x${string}` }).then((b: any) => !!b && b !== "0x").catch(() => false) : Promise.resolve(false);
const usdc = (a: string) => arc.readContract({ address: ARC.usdc as `0x${string}`, abi: usdcAbi, functionName: "balanceOf", args: [getAddress(a)] }).catch(() => -1n);

async function main() {
  // Arc RPC
  const chainId = await arc.getChainId().catch(() => 0);
  check("Arc RPC", chainId === ARC.chainId, `chainId ${chainId}`);

  // Robots
  for (const [n, r] of Object.entries(ROBOTS)) {
    try {
      const h = await (await fetch(`${r.url}/health`, { signal: AbortSignal.timeout(3000) })).json();
      check(`Robot ${n}`, !!h.ok, `${r.url} · ${h.battery_v ?? "?"}V`);
    } catch { check(`Robot ${n}`, false, `${r.url} unreachable`); }
  }

  // Wallet balances on Arc (need gas+stake)
  for (const [n, r] of Object.entries(ROBOTS)) {
    const b = await usdc(r.wallet);
    check(`${n} USDC funded`, b > 0n, b < 0n ? "read failed" : `${Number(b) / 1e6} USDC`);
  }
  if (process.env.TREASURY_ADDRESS) {
    const b = await usdc(process.env.TREASURY_ADDRESS);
    check("treasury USDC funded", b > 0n, `${Number(b) / 1e6} USDC`);
  }

  // Contracts deployed on Arc
  check("EventPass deployed", await codeAt(arc, process.env.EVENTPASS_ADDRESS), process.env.EVENTPASS_ADDRESS ?? "unset");
  check("ReputationRegistry deployed", await codeAt(arc, process.env.REPUTATION_ADDRESS), process.env.REPUTATION_ADDRESS ?? "unset");
  check("RaceMarket deployed", await codeAt(arc, process.env.RACEMARKET_ADDRESS), process.env.RACEMARKET_ADDRESS ?? "unset");
  check("Treasury deployed", await codeAt(arc, process.env.TREASURY_CONTRACT), process.env.TREASURY_CONTRACT ?? "unset");

  // ENS (Sepolia/mainnet) live resolution
  const ensChain = (process.env.ENS_CHAIN ?? "sepolia") === "mainnet" ? mainnet : sepolia;
  const ensClient = createPublicClient({ chain: ensChain, transport: http() });
  const parent = `${process.env.ENS_PARENT_LABEL ?? "roverfleet"}.eth`;
  try {
    const addr = await ensClient.getEnsAddress({ name: `guard.${parent}` });
    check("ENS resolves", !!addr, `guard.${parent} -> ${addr ?? "unresolved"} (${ensChain.name})`);
  } catch (e: any) { check("ENS resolves", false, e.message.slice(0, 40)); }

  // World ID configured
  check("World ID configured", !!process.env.WORLD_APP_ID, process.env.WORLD_APP_ID ?? "WORLD_APP_ID unset");

  // Walrus reachable
  try {
    const w = await fetch("https://publisher.walrus-testnet.walrus.space/v1/api", { signal: AbortSignal.timeout(5000) });
    check("Walrus reachable", w.status < 500, `HTTP ${w.status}`);
  } catch { check("Walrus reachable", false, "unreachable"); }

  // AgentBook (World Chain) reachable
  try {
    const wc = createPublicClient({ chain: worldchain, transport: http(process.env.WORLDCHAIN_RPC ?? "https://worldchain-mainnet.gateway.tenderly.co") });
    const bn = await wc.getBlockNumber();
    check("AgentBook chain reachable", bn > 0n, `World Chain block ${bn}`);
  } catch { check("AgentBook chain reachable", false, "RPC unreachable"); }

  // Ledger config
  check("Ledger owner set", !!process.env.LEDGER_ADDRESS, process.env.LEDGER_ADDRESS ?? "LEDGER_ADDRESS unset (Treasury owner=guard fallback)");

  // print board
  console.log("\n  THE ONCHAIN ROVER — PRE-FLIGHT\n  " + "─".repeat(46));
  for (const r of rows) console.log(`  ${ok(r.ok)} ${r.label.padEnd(26)} ${r.detail}`);
  const blockers = rows.filter((r) => !r.ok).length;
  console.log("  " + "─".repeat(46));
  console.log(blockers === 0 ? "  🟢 ALL SYSTEMS GO" : `  🟡 ${blockers} blocker(s) — see ❌ above\n`);
}
main();
