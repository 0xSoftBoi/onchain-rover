/**
 * Rover sidecar — the crypto rails + PUBLIC paid surface (port 4021).
 *
 * Paid routes sit behind Circle's x402 Gateway middleware (nanopayments on
 * Arc testnet, gas-free EIP-3009). Free routes serve the demo orchestrator
 * and the web UI. Robot FastAPIs are LAN-only behind this.
 *
 * 🚨 facilitatorUrl MUST be set to the testnet URL (default is mainnet).
 * 🚨 Buyer wallets must be plain EOAs (Privy server wallets are).
 */
import express from "express";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

import "./env.js"; // MUST be first — loads dotenv before any env-reading module
import { ARC, ROBOTS, type RobotName } from "./config.js";
import * as erc8004 from "./erc8004.js";
import * as ens from "./ens.js";
import * as identity from "./identity.js";
import * as worldid from "./worldid.js";
import * as cre from "./cre.js";
import * as privy from "./privy.js";
import * as bq from "./bigquery.js";
import * as lb from "./leaderboard.js";
import * as race from "./race.js";
import * as chain from "./chain.js";
import * as clanker500 from "./clanker500-chain.js";
import * as evidence from "./evidence.js";
import * as fieldPreflight from "./field-preflight.js";
import * as localDevWallets from "./local-dev-wallets.js";
import * as raceStore from "./race-store.js";
import * as robotLink from "./robot-link.js";
import * as rounds from "./rounds.js";
import * as settle from "./settle.js";
import * as stakeAdapters from "./stake-adapter.js";
import * as telemetryTrace from "./telemetry-trace.js";
import * as treasuryLedger from "./treasury-ledger.js";
import * as session from "./session.js";

// Never let one bad call take down the demo: log unhandled errors, stay up.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

const app = express();
app.use(express.json());
const server = createServer(app);
robotLink.installRobotLink(app, server);

// ----- DEMO_MOCK: fills every panel with realistic data so the dashboard can
// be reviewed without live robots/funds. Unset DEMO_MOCK to go fully real. -----
const MOCK = process.env.DEMO_MOCK === "1";
const ex = (tx: string) => `${ARC.explorer}/tx/${tx}`;
const mockStatus = () => ({
  ok: true, arc: { chainId: ARC.chainId, explorer: ARC.explorer },
  eventPass: "0x8004EVENTpass000000000000000000000000a1",
  robots: {
    guard: { ok: true, role: "guard", battery_v: 12.4, ens: "guard.roverfleet.eth",
      wallet: ROBOTS.guard.wallet, usdc6: "6480000", url: ROBOTS.guard.url, feed: "/mock-cam.svg?guard" },
    courier: { ok: true, role: "courier", battery_v: 12.1, ens: "courier.roverfleet.eth",
      wallet: ROBOTS.courier.wallet, usdc6: "3250000", url: ROBOTS.courier.url, feed: "/mock-cam.svg?courier" },
  },
  race: { id: "demo-1", status: "betting", racers: ["guard", "courier"] },
  ens: { parent: "roverfleet.eth", chain: "Sepolia",
    guard: { name: "guard.roverfleet.eth", chain: "Sepolia", address: ROBOTS.guard.wallet, resolved: true, agentContext: "physical rover agent; skills: guard,deliver,race" },
    courier: { name: "courier.roverfleet.eth", chain: "Sepolia", address: ROBOTS.courier.wallet, resolved: true, agentContext: "physical rover agent; skills: guard,deliver,race" } },
});
// Live-growing mock feed: seeds a few, then appends a new settlement every few
// seconds so the LIVE panel visibly streams (design review). Mock-only.
const _mockEvents: OnchainEvent[] = [];
let _mockTx = 0xa1b2c3;
const _rndTx = () => "0x" + (_mockTx++).toString(16).padStart(6, "0") + "e5f6072839abcd";
const _mockKinds: [string, () => string, number][] = [
  ["PAY", () => "courier → guard $0.50 USDC", 0.5],
  ["MINT", () => "EventPass → courier @ $1.25", 0],
  ["REPUTATION", () => "guard rated 95 (skill: guard)", 0],
  ["BET", () => `$${[1, 2, 5][_mockTx % 3]} on ${_mockTx % 2 ? "courier" : "guard"} (World-verified)`, [1, 2, 5][_mockTx % 3]],
  ["RACE SETTLE", () => "courier wins · proof DhDkmlGywO…", 0],
];
let _mockKindIdx = 0;
function _pushMock() {
  const [kind, det, usdc] = _mockKinds[_mockKindIdx++ % _mockKinds.length];
  const tx = _rndTx();
  _mockEvents.unshift({ t: Date.now(), kind, detail: det(), tx, explorer: ex(tx), usdc });
  if (_mockEvents.length > 60) _mockEvents.pop();
}
function mockFeedLive() { return feedPayload(_mockEvents); }
if (MOCK) { for (let i = 0; i < 8; i++) _pushMock(); setInterval(_pushMock, 4000); }
// Mock negotiation reasoning — the two robots' local gemma3 thoughts streaming
// as the Dutch auction plays out. Loops. Mock-only (real path = POST /reason).
const _reasonScript: [string, string, string, string][] = [
  ["guard", "reserve", "demand 0.6 — moderate. setting reserve $0.75, step $0.25. won't dump it.", "plan"],
  ["guard", "offer", "EventPass. opening at $2.00. do I hear two dollars?", "offer"],
  ["courier", "observe", "offer $2.00, my budget $1.25. over budget — hold.", "thought"],
  ["courier", "decide", "WAIT. price falling ~$0.25/round, expect lower next.", "decision"],
  ["guard", "offer", "no takers. dropping to $1.75.", "offer"],
  ["courier", "observe", "$1.75 still > $1.25. risk: rival buyer? none seen. hold.", "thought"],
  ["guard", "offer", "$1.50, going once…", "offer"],
  ["courier", "observe", "$1.50. close. one more drop likely — but ~12s left, getting risky.", "thought"],
  ["guard", "offer", "$1.25! last call before reserve.", "offer"],
  ["courier", "decide", "ACCEPT @ $1.25 — at budget, low time left, waiting risks the reserve. take it.", "decision"],
  ["guard", "settle", "SOLD to courier.rover.eth for $1.25. yeehaw.", "decision"],
];
let _reasonIdx = 0;
const _reasonLog: Thought[] = [];
function _pushReason() {
  const [robot, phase, text, kind] = _reasonScript[_reasonIdx++ % _reasonScript.length];
  _reasonLog.unshift({ t: Date.now(), robot, phase, text, kind });
  if (_reasonLog.length > 60) _reasonLog.pop();
}
function mockReason() { return _reasonLog.slice(0, 40); }
if (MOCK) { for (let i = 0; i < 6; i++) _pushReason(); setInterval(_pushReason, 2500); }

const mockRep = () => ({
  guard: { ens: "guard.roverfleet.eth", count: 7, avg: 95 },
  courier: { ens: "courier.roverfleet.eth", count: 4, avg: 91 },
});
const mockOdds = () => ({ pool: { guard: 3, courier: 5 }, total: 8,
  odds: { guard: 2.67, courier: 1.6 }, count: 6 });
const mockLearning = () => ({
  demand: 0.72, n: 6, sellRate: 0.83, avgRounds: 2.2,
  note: "5/6 sold, avg 2.2 rounds → demand 0.72 (holding value)",
  history: [
    { t: Date.now() - 60000, price: 1.50, sold: true, rounds: 2 },
    { t: Date.now() - 120000, price: 1.25, sold: true, rounds: 3 },
    { t: Date.now() - 200000, price: 1.50, sold: true, rounds: 2 },
    { t: Date.now() - 300000, price: 0.75, sold: false, rounds: 6 },
    { t: Date.now() - 380000, price: 1.25, sold: true, rounds: 3 },
  ],
});

const gateway = createGatewayMiddleware({
  sellerAddress: process.env.TREASURY_ADDRESS!,    // fleet treasury (Ledger-governed)
  facilitatorUrl: ARC.facilitatorUrl,              // testnet! default is mainnet
  networks: [ARC.caip2],
});
const RACE_NETWORK_FEE_USDC = normalizeUsdcAmount(process.env.RACE_NETWORK_FEE_USDC ?? "0.25");
const raceJoinFeeGate = gateway.require(`$${RACE_NETWORK_FEE_USDC}`);

// Live robot registry — robots heartbeat their current IP here, so venue DHCP
// drift never breaks the demo. Falls back to the static .env URL if stale.
const liveRobots = new Map<string, { url: string; lastSeen: number; battery?: number }>();
const FRESH_MS = 30000;

const robot = (name: string) => {
  if (!(name in ROBOTS)) throw new Error("unknown robot");
  const live = liveRobots.get(name);
  const url = live && Date.now() - live.lastSeen < FRESH_MS
    ? live.url : ROBOTS[name as RobotName].url;
  return { ...ROBOTS[name as RobotName], url };
};

// Robots POST here every ~10s. We derive the URL from the source IP so the
// robot doesn't need to know its own address.
app.post("/robot/heartbeat", (req, res) => {
  const { role, port = 8000, battery } = req.body ?? {};
  if (!role || !(role in ROBOTS)) return res.status(400).json({ error: "unknown role" });
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
    || req.socket.remoteAddress?.replace(/^::ffff:/, "") || "";
  if (!ip) return res.status(400).json({ error: "no source ip" });
  liveRobots.set(role, { url: `http://${ip}:${port}`, lastSeen: Date.now(), battery });
  res.json({ ok: true, registered: `http://${ip}:${port}` });
});

// --- on-chain settlement feed (live "what's settling" for the dashboard) ---
type OnchainEvent = { t: number; kind: string; tx?: string; detail: string; explorer?: string; usdc?: number };
const onchainFeed: OnchainEvent[] = [];
function logOnchain(kind: string, detail: string, tx?: string, usdc?: number) {
  onchainFeed.unshift({ t: Date.now(), kind, detail, tx, usdc,
    explorer: tx ? `${ARC.explorer}/tx/${tx}` : undefined });
  if (onchainFeed.length > 80) onchainFeed.pop();
}
function feedPayload(events: OnchainEvent[]) {
  const settledUsdc = events.reduce((s, e) => s + (e.usdc || 0), 0);
  return { events: events.slice(0, 40), settledUsdc: +settledUsdc.toFixed(2),
           count: events.length };
}
app.get("/onchain/feed", (_req, res) =>
  res.json(MOCK ? mockFeedLive() : feedPayload(onchainFeed)));

// --- live reasoning feed: each robot's LOCAL-LLM thoughts during negotiation ---
type Thought = { t: number; robot: string; phase: string; text: string; kind: string };
const reasoning: Thought[] = [];
function logReason(robot: string, phase: string, text: string, kind = "thought") {
  reasoning.unshift({ t: Date.now(), robot, phase, text, kind });
  if (reasoning.length > 120) reasoning.pop();
}
// robots POST their LLM reasoning here (fire-and-forget); dashboard reads /reason/feed
app.post("/reason", (req, res) => {
  const { robot, phase = "", text = "", kind = "thought" } = req.body ?? {};
  if (robot && text) logReason(robot, phase, text, kind);
  res.json({ ok: true });
});
app.get("/reason/feed", (_req, res) => {
  if (MOCK) return res.json({ events: mockReason() });
  res.json({ events: reasoning.slice(0, 60) });
});

// --- adaptive learning: the seller learns demand from past auction outcomes --
type Outcome = { t: number; price: number; sold: boolean; rounds: number };
const auctionHistory: Outcome[] = [];
function recordOutcome(o: Omit<Outcome, "t">) {
  auctionHistory.unshift({ ...o, t: Date.now() });
  if (auctionHistory.length > 50) auctionHistory.pop();
}
// learned demand 0..1: recent sales that closed fast + near start price => high
// demand => seller holds value (higher reserve). Slow/floor sales => low demand.
function learnedDemand() {
  const recent = auctionHistory.slice(0, 8);
  if (!recent.length) return { demand: 0.5, note: "no history yet — neutral demand 0.5", n: 0 };
  const sold = recent.filter((o) => o.sold);
  const sellRate = sold.length / recent.length;
  const avgRounds = sold.length ? sold.reduce((s, o) => s + o.rounds, 0) / sold.length : 6;
  // fast sales (few rounds) + high sell-rate => high demand
  const speed = Math.max(0, 1 - (avgRounds - 1) / 6);       // 1 round->1.0, 7+->0
  const demand = Math.max(0.1, Math.min(0.95, 0.5 * sellRate + 0.5 * speed));
  const note = `${sold.length}/${recent.length} sold, avg ${avgRounds.toFixed(1)} rounds`
    + ` → demand ${demand.toFixed(2)} (${demand > 0.6 ? "holding value" : demand < 0.4 ? "moving inventory" : "balanced"})`;
  return { demand: +demand.toFixed(2), note, n: recent.length, sellRate, avgRounds: +avgRounds.toFixed(1) };
}
app.get("/learning", (_req, res) => {
  if (MOCK) return res.json(mockLearning());
  res.json({ ...learnedDemand(), history: auctionHistory.slice(0, 10) });
});
// record an auction outcome (a standalone-robot negotiation posts here)
app.post("/learning/outcome", (req, res) => {
  const { price = 0, sold = false, rounds = 4 } = req.body ?? {};
  recordOutcome({ price: Number(price), sold: !!sold, rounds: Number(rounds) });
  res.json(learnedDemand());
});

// --- latest proof-of-action (pulled from a public Walrus aggregator) -------
const WALRUS_AGG = process.env.WALRUS_AGGREGATOR
  ?? "https://aggregator.walrus-testnet.walrus.space";
type Proof = { t: number; blobId: string; sha256?: string; label?: string };
let latestProof: Proof | null = null;
function setProof(p: Proof) { latestProof = { ...p, t: Date.now() }; }
app.post("/proof", (req, res) => {
  const { blobId, sha256, label } = req.body ?? {};
  if (blobId) setProof({ blobId, sha256, label, t: Date.now() });
  res.json({ ok: true });
});
app.get("/proof/latest", (_req, res) => {
  // a REAL rover photo already on Walrus (guard /store-proof) for mock review
  const p = MOCK
    ? { t: Date.now(), blobId: "zTOQNkKtqGa-ziBkSF6Z-_oGuKYWvAQq79wkZZ-MhRw",
        sha256: "44d5699262c4714e87e07bd65fd34f774fe253fc5ed9563ef922a08fb58e2d5a",
        label: "courier delivery @ checkpoint" }
    : latestProof;
  res.json({ proof: p, aggregator: WALRUS_AGG,
             url: p ? `${WALRUS_AGG}/v1/blobs/${p.blobId}` : null });
});

app.get("/robot/registry", (_req, res) => {
  res.json(Object.fromEntries([...liveRobots.entries()].map(([k, v]) =>
    [k, { ...v, freshSecs: Math.round((Date.now() - v.lastSeen) / 1000) }])));
});

// ---------- PAID routes (x402 / Arc nanopayments) ---------------------------
// Hire a robot for an NL task — the core "hire over HTTP" thesis.
app.post("/task/:robot", gateway.require("$0.50"), async (req, res) => {
  const r = await fetch(`${robot(req.params.robot).url}/task`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: (req.body as any).task }),
  });
  res.json({ payment: (req as any).payment, result: await r.json() });
});

// Rover GP: pay to pilot ($1 per 120s session).
app.post("/pilot/:robot/start", gateway.require("$1.00"), async (req, res) => {
  const payer = (req as any).payment?.payer ?? "anon";
  res.json(await race.startPilotSession(req.params.robot as RobotName, payer));
});

// Race entry fleet fee. This is separate from the matched stake: x402 pays the
// network/treasury fee, while stake authorization stays in the race adapter.
app.post("/race/:id/join", preflightRaceJoinFee, raceJoinFeeGate, recordRaceJoinFee);
app.post("/race/round/:id/join", preflightRaceJoinFee, raceJoinFeeGate, recordRaceJoinFee);

// ---------- FREE routes (LAN/demo/web) --------------------------------------
app.post("/pilot/drive", async (req, res) => {
  const { sessionId, left, right } = req.body;
  try {
    res.json(await race.drive(sessionId, left, right));
  } catch (e: any) {
    res.status(403).json({ error: e.message });
  }
});

app.post("/estop/:robot", async (req, res) => {
  await race.stopRobot(req.params.robot as RobotName);
  res.json({ stopped: true });
});

let onChainRaceId: number | null = null;
app.post("/race/open", async (_req, res) => {
  const r = race.openRaceWithBets();
  onChainRaceId = null;
  if (process.env.RACEMARKET_ADDRESS) {
    try { onChainRaceId = (await settle.openRaceOnChain(2)).raceId; } catch (e: any) {
      return res.status(500).json({ error: "openRace on-chain failed: " + e.message }); }
  }
  res.json({ ...r, onChainRaceId });
});

// World ID config for the frontend IDKit widget (public app_id only).
app.get("/worldid/config", (_req, res) => res.json(worldid.config()));

// --- Chainlink CRE decentralized verification (read on-chain result) -------
app.get("/cre/config", (_req, res) => res.json(cre.config()));
app.get("/cre/latest", async (_req, res) => res.json(await cre.latest()));
app.get("/privy/status", (_req, res) => res.json(privy.config()));

// --- BigQuery: network-wide ERC-8004 reputation leaderboard ----------------
app.get("/leaderboard/network", async (_req, res) => {
  try { res.json(await bq.leaderboard()); }
  catch (e: any) { res.status(200).json({ configured: bq.configured(), error: e.message, rows: [] }); }
});

// Real World ID verify -> real nullifier. Frontend posts the IDKit proof here
// and gets back the verified nullifier to use when betting.
app.post("/worldid/verify", async (req, res) => {
  try { res.json(await worldid.verify(req.body.proof, req.body.signal)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Bet: requires a World-ID-verified nullifier. The proof is re-verified server
// side here (don't trust a client-asserted nullifier), then one-per-human is
// enforced. No proof -> no bet.
app.post("/race/bet", async (req, res) => {
  try {
    const { bettor = "anon", racer, amount = 1, proof } = req.body;
    if (!proof) throw new Error("World ID proof required to bet");
    const v = await worldid.verify(proof, racer); // signal = racer (binds proof to choice)
    // REAL on-chain bet (relayer-staked, nullifier on-chain) when market is live
    let onchain;
    if (process.env.RACEMARKET_ADDRESS && onChainRaceId !== null) {
      const racerIdx = race.raceState()?.racers.indexOf(racer as RobotName) ?? 0;
      onchain = await settle.betOnChain(onChainRaceId, racerIdx, String(amount), v.nullifier);
      logOnchain("BET", `$${amount} on ${racer} (World-verified human)`, onchain?.tx, Number(amount));
    }
    const odds = race.placeBet({ bettor, racer, amount: Number(amount), nullifier: v.nullifier });
    res.json({ ...odds, onchain });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.get("/race/odds", (_req, res) => res.json(MOCK ? mockOdds() : race.odds()));

// --- Treasury (Ledger clear-sign governance climax) ------------------------
app.get("/treasury/info", async (_req, res) => {
  try { res.json(await settle.treasuryInfo()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});
app.get("/treasury/withdraw-tx", async (req, res) => {
  try {
    const { from, to, amount } = req.query as Record<string, string>;
    console.log(`[treasury] withdraw-tx from=${from} to=${to} amount=${amount}`);
    res.json(await settle.buildWithdrawTx(from, to, amount));
  } catch (e: any) {
    console.error("[treasury] withdraw-tx error:", e.message);
    res.status(400).json({ error: e.message });
  }
});
app.post("/treasury/broadcast", async (req, res) => {
  try {
    const r = await settle.broadcastSigned(req.body.tx, req.body.signature);
    console.log("[treasury] broadcast ok:", r?.tx);
    res.json(r);
  } catch (e: any) {
    console.error("[treasury] broadcast error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Session authorization — the OPENING Ledger ceremony (bookends the withdraw).
// Gasless EIP-712 clear-sign that unlocks the show. See session.ts.
app.get("/session/auth-message", (req, res) => {
  try { res.json(session.issue(String(req.query.operator || ""))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post("/session/authorize", async (req, res) => {
  try {
    const r = await session.verify(req.body.signature);
    console.log(`[session] authorize ${r.ok ? "OK" : "FAILED"} operator=${r.operator}`);
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.get("/session/status", (_req, res) => res.json(session.status()));
app.post("/session/reset", (_req, res) => res.json(session.reset()));

// ERC-8004 reputation summary (the leaderboard score) for each robot.
app.get("/reputation", async (_req, res) => {
  if (MOCK) return res.json(mockRep());
  const out: Record<string, any> = {};
  for (const [n, r] of Object.entries(ROBOTS)) {
    try { out[n] = { ens: r.ens, ...(await settle.repSummary(Number(r.agentId ?? 0))) }; }
    catch (e: any) { out[n] = { ens: r.ens, error: e.message }; }
  }
  res.json(out);
});
app.get("/race/state", (_req, res) => res.json(race.raceState()));
app.post("/race/arm", (_req, res) => res.json(race.armRace()));
app.post("/race/start", (_req, res) => res.json(race.startRace()));
app.post("/race/finish", async (req, res) => {
  try {
    const winner = req.body.winner as RobotName;
    const r = race.recordFinish(winner);
    // The GUARD is the race oracle: capture its finish-line photo and anchor it
    // immutably on Walrus — that real hash + blobId settle the market on-chain.
    let proof: { sha256?: string; blobId?: string } = {};
    try {
      await fetch(`${robot("guard").url}/capture`, { method: "POST",
        signal: AbortSignal.timeout(8000) });
      proof = await (await fetch(`${robot("guard").url}/store-proof`, { method: "POST",
        signal: AbortSignal.timeout(20000) })).json();
      if (proof?.blobId) setProof({ blobId: proof.blobId, sha256: proof.sha256,
        label: `${winner} wins`, t: Date.now() });
    } catch (e: any) { proof = { } /* proof capture failed; settle still records winner */ ; }
    let settled;
    if (process.env.RACEMARKET_ADDRESS && onChainRaceId !== null) {
      const winnerIdx = r.racers.indexOf(winner);
      settled = await settle.settleRaceOnChain(
        onChainRaceId, winnerIdx, proof.sha256 ?? "", proof.blobId ?? "");
      logOnchain("RACE SETTLE", `${winner} wins · proof ${(proof.blobId||"").slice(0,10)}…`, settled?.tx);
    }
    res.json({ ...r, proof, settled });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
// /race/finish settles on-chain via RaceMarket.settle (judge=guard) with the
// finish proof — wired above in settle.settleRaceOnChain.

// Checkpoint: a robot signs a real challenge with its OWN EOA key.
app.post("/challenge", async (req, res) => {
  try { res.json(await identity.signChallenge(req.body.robot as RobotName)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Verify an agent: real signature recovery + live AgentBook human-backing +
// on-chain ERC-8004 reputation + EventPass hold. Every field is real.
app.post("/verify-agent", async (req, res) => {
  const { wallet, agentId, message, signature, nonce } = req.body;
  const out: any = { wallet, agentId };
  try {
    if (message && signature) {
      const v = await identity.verifyChallenge({ message, signature, wallet, nonce });
      out.signatureValid = v.signatureValid; out.replay = v.replay;
    }
    const hb = await identity.lookupHuman(wallet);
    out.humanBacked = hb.humanBacked; out.humanId = hb.humanId;
    out.holdsPass = await settle.holdsPass(wallet);
    const rep = await settle.repSummary(Number(agentId ?? 0));
    out.reputation = rep;
  } catch (e: any) { out.error = e.message; }
  res.json(out);
});

// Robot-to-robot payment: courier transfers the NEGOTIATED USDC to guard on Arc.
app.post("/pay", async (req, res) => {
  try {
    const { from = "courier", to = "guard", amt } = req.body;
    const r = await settle.pay(from, to, String(amt));
    logOnchain("PAY", `${from} → ${to} $${amt} USDC`, r?.tx, Number(amt));
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Guard mints the EventPass to the buyer, recording the negotiated price on-chain.
app.post("/mint-pass", async (req, res) => {
  try {
    const { robot = "courier", price = "0.50" } = req.body;
    const m = await settle.mintPass(robot, String(price));
    logOnchain("MINT", `EventPass → ${robot} @ $${price}`, m?.tx);
    res.json(m);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Balances helper (demo dashboard / pre-flight check).
app.get("/balances", async (_req, res) => {
  const out: Record<string, string> = {};
  for (const [n, r] of Object.entries(ROBOTS)) {
    if (r.wallet) out[n] = (await settle.usdcBalance(r.wallet)).toString();
  }
  res.json({ usdc6: out });
});

app.post("/register-agent", async (req, res) => {
  const { agentURI, ownerKey } = req.body;
  res.json(await erc8004.registerAgent(agentURI, ownerKey));
});

app.post("/give-feedback", async (req, res) => {
  try {
    const r = robot(req.body.robot);
    // Arc reputation (same chain as the rest of the flywheel)
    const fb = await settle.giveFeedback({
      agentId: Number(r.agentId ?? 0),
      score: req.body.score, skill: req.body.skill,
      blobId: req.body.blobId, sha256: req.body.sha256,
    });
    logOnchain("REPUTATION", `${req.body.robot || "guard"} rated ${req.body.score} (skill: ${req.body.skill})`, fb?.tx);
    res.json(fb);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ENS is issued on-chain by register-ens.ts (real registration, not an API).
// These endpoints resolve the live records.
app.get("/ens/resolve", async (req, res) =>
  res.json(await ens.resolve(String(req.query.name))));
app.get("/ens/fleet", async (_req, res) => res.json(await ens.fleet()));

app.get("/leaderboard", async (_req, res) => {
  const fleet = await lb.fleetFeedback(
    Object.values(ROBOTS).filter(r => r.agentId).map(r => BigInt(r.agentId!)));
  res.json({ fleet });
});
app.get("/leaderboard/mainnet", async (_req, res) =>
  res.json(await lb.mainnetRanking()));

app.get("/health", async (_req, res) => {
  const robots = await Promise.all(Object.entries(ROBOTS).map(async ([n, r]) => {
    try {
      const h = await (await fetch(`${r.url}/health`,
        { signal: AbortSignal.timeout(3000) })).json();
      return [n, h];
    } catch { return [n, { ok: false, error: "unreachable" }]; }
  }));
  res.json({ ok: true, robots: Object.fromEntries(robots) });
});

// ---------- Auction orchestration (dashboard-driven) -----------------------
type AuctionState = {
  price?: number; agreed?: boolean; buyer?: string; note?: string;
  pay?: string; mint?: string; feedback?: string; settle: boolean;
};
const auctions = new Map<string, AuctionState>();

app.post("/race/auction/start", async (req, res) => {
  const { auctionId, settle: doSettle = false } = req.body;
  const st: AuctionState = { settle: doSettle, note: "starting…" };
  auctions.set(auctionId, st);
  res.json({ started: true, auctionId });

  // fire-and-forget orchestration; dashboard polls /race/auction/state
  (async () => {
    try {
      await fetch(`${robot("courier").url}/negotiate/buy`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budget: 1.25, auctionId, timeout_secs: 70 }),
      });
      await new Promise((r) => setTimeout(r, 800));
      await fetch(`${robot("guard").url}/negotiate/sell`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: 2.0, floor: 0.5, step: 0.25, tick_secs: 4.0, auctionId }),
      });
      st.note = "haggling…";
      let deal: any = {};
      for (let i = 0; i < 35; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        deal = await (await fetch(
          `${robot("guard").url}/negotiate/result?auctionId=${auctionId}`)).json();
        if (deal.price) st.price = deal.price;
        if (deal.agreed !== undefined && !deal.pending) break;
      }
      // LEARNING: record the outcome so the seller adapts demand next time
      recordOutcome({ price: deal.price ?? 0, sold: !!deal.agreed,
                      rounds: deal.rounds ?? (deal.history?.length ?? 4) });
      if (!deal.agreed) { st.note = "no deal"; return; }
      st.agreed = true; st.buyer = deal.buyer; st.price = deal.price;
      st.note = "sold — settling on Arc…";
      if (doSettle) {
        const pay = await settle.pay("courier", "guard", String(deal.price));
        st.pay = pay.tx;
        logOnchain("PAY", `courier → guard $${deal.price} USDC`, pay.tx, Number(deal.price));
        const mint = await settle.mintPass("courier", String(deal.price));
        st.mint = mint.tx;
        logOnchain("MINT", `EventPass → courier @ $${deal.price}`, mint.tx);
        st.note = "settled + minted; recording reputation…";
        // flywheel: requester rates the guard for the completed sale (skill=guard)
        try {
          const fb = await settle.giveFeedback({
            agentId: Number(ROBOTS.guard.agentId ?? 0), score: 95, skill: "guard",
          });
          st.feedback = fb.tx;
          logOnchain("REPUTATION", "guard rated 95 (skill: guard)", fb.tx);
        } catch (e: any) { st.note = "minted; feedback skipped: " + e.message; }
        st.note = "settled + minted + reputation on Arc";
      }
    } catch (e: any) { st.note = "error: " + e.message; }
  })();
});

app.get("/race/auction/state", (req, res) => {
  res.json(auctions.get(String(req.query.auctionId)) ?? { note: "unknown" });
});

// ---------- Local Hardhat race payment harness -----------------------------
app.get("/chain/config", (_req, res) => {
  try { res.json(chain.publicLocalChainConfig()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/chain/health", async (_req, res) => {
  try { res.json(await chain.localChainHealth()); }
  catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/treasury/local", async (_req, res) => {
  try { res.json(await chain.localTreasuryInfo()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/treasury/fee-ledger", (_req, res) => {
  try { res.json(treasuryLedger.buildTreasuryFeeLedger()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/chain/faucet", async (req, res) => {
  try { res.json(await chain.fundLocalWallet(req.body.wallet, String(req.body.amount ?? "100"))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/chain/open", async (req, res) => {
  try {
    const round = rounds.getRound(req.params.id);
    const opened = await chain.openRoundOnChain(round);
    res.json(rounds.attachChainRace(req.params.id, opened.raceId, opened.tx));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/chain/authorization-request", async (req, res) => {
  try {
    const slot = requireDriverSlot(req.body.slot);
    const round = rounds.getRound(req.params.id);
    res.json(await chain.buildRaceEntryRequest(round, slot, req.body.wallet));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/chain/join", async (req, res) => {
  try {
    const slot = requireDriverSlot(req.body.slot);
    const round = rounds.getRound(req.params.id);
    if (!req.body.entrySignature) throw new Error("entrySignature required");
    if (!req.body.entryDeadline) throw new Error("entryDeadline required");
    const joined = await chain.joinRoundOnChain({
      round,
      slot,
      entrySignature: req.body.entrySignature,
      permitSignature: req.body.permitSignature,
      entryDeadline: req.body.entryDeadline,
      permitDeadline: req.body.permitDeadline,
    });
    res.json(rounds.markChainJoined(req.params.id, slot, joined.tx, {
      entrySignature: req.body.entrySignature,
      permitSignature: req.body.permitSignature,
    }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/chain/lock", async (req, res) => {
  try {
    const locked = await chain.lockRoundOnChain(rounds.getRound(req.params.id));
    res.json(rounds.markChainLocked(req.params.id, locked.tx));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/dev/join-local-wallets", async (req, res) => {
  try {
    if (!localDevWalletsEnabled()) {
      return res.status(403).json({
        error: "local dev wallets require ALLOW_LOCAL_DEV_WALLETS=1 or ALLOW_FREE_PILOT=1",
      });
    }
    const actions: Array<Record<string, unknown>> = [];
    const fundAmount = String(req.body?.amount ?? "20");
    const lockChain = req.body?.lockChain !== false;
    const id = req.params.id;

    let round = ensureLocalDevDriver(id, "challenger");
    round = ensureLocalDevDriver(id, "opponent");

    const needsJoin = !round.drivers.challenger?.chainJoined || !round.drivers.opponent?.chainJoined;
    if (needsJoin && round.status !== "accepted" && round.status !== "ready") {
      throw new Error(`local dev join requires accepted or ready round, got ${round.status}`);
    }

    if (!round.chainRaceId) {
      const opened = await chain.openRoundOnChain(round);
      round = rounds.attachChainRace(id, opened.raceId, opened.tx);
      actions.push({ type: "open", raceId: opened.raceId, tx: opened.tx });
    }

    for (const slot of ["challenger", "opponent"] as const) {
      const driver = round.drivers[slot];
      if (!driver?.wallet) throw new Error(`missing ${slot} wallet`);
      if (driver.chainJoined) {
        actions.push({ type: "skip-join", slot, reason: "already joined" });
        continue;
      }

      const funded = await chain.fundLocalWallet(driver.wallet, fundAmount);
      actions.push({ type: "fund", slot, wallet: funded.wallet, amount: funded.amount, tx: funded.tx });

      const request = await chain.buildRaceEntryRequest(round, slot, driver.wallet);
      const signed = await localDevWallets.signLocalDevRaceEntry(slot, request);
      const joined = await chain.joinRoundOnChain({
        round,
        slot,
        entrySignature: signed.entrySignature,
        permitSignature: signed.permitSignature,
        entryDeadline: signed.entryDeadline as string,
        permitDeadline: signed.permitDeadline as string,
      });
      round = rounds.markChainJoined(id, slot, joined.tx, {
        entrySignature: signed.entrySignature,
        permitSignature: signed.permitSignature,
      });
      actions.push({ type: "join", slot, tx: joined.tx });
    }

    if (lockChain && round.chainStatus === "joined") {
      const locked = await chain.lockRoundOnChain(round);
      round = rounds.markChainLocked(id, locked.tx);
      actions.push({ type: "lock", tx: locked.tx });
    } else if (lockChain && round.chainStatus === "locked") {
      actions.push({ type: "skip-lock", reason: "already locked" });
    }

    res.json({ round, wallets: localDevWallets.localDevWallets(), actions });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/chain/start", async (req, res) => {
  try {
    const started = await chain.startRoundOnChain(rounds.getRound(req.params.id));
    res.json(rounds.markChainStarted(req.params.id, started.tx));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/chain/settle", async (req, res) => {
  try {
    let round = rounds.getRound(req.params.id);
    if (round.chainStatus === "started") {
      round = ensureResultEvidence(round);
      const finished = await chain.finishRoundOnChain(round);
      round = rounds.markChainFinished(req.params.id, finished.tx);
    }
    const settled = await chain.settleRoundOnChain(round);
    round = rounds.markChainSettled(req.params.id, settled.tx);
    evidence.recordRoundSnapshot(round, "settled");
    const hashes = evidence.getEvidenceHash(round);
    res.json(rounds.markEvidenceHashes(req.params.id, hashes.proofHash, hashes.evidenceHash));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/chain/cancel", async (req, res) => {
  try {
    const reason = String(req.body.reason ?? "canceled");
    const canceled = await chain.cancelRoundOnChain(rounds.getRound(req.params.id), reason);
    res.json(rounds.markChainCanceled(req.params.id, canceled.tx, reason));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ---------- Two-driver race-room coordinator -------------------------------
app.post("/race/round/challenge", (req, res) => {
  try { res.json(rounds.createRound(req.body)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/claim-slot", (req, res) => {
  try { res.json(rounds.claimSlot(req.params.id, requireDriverSlot(req.body.slot), req.body)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get("/race/rounds", (_req, res) => res.json({ rounds: rounds.listRounds() }));

// ---------- Clanker500 stage race (native Base Sepolia ETH) ----------------
app.get("/clanker500/config", (_req, res) => {
  try { res.json(clanker500.clanker500Config()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/clanker500/active", (_req, res) => {
  try { res.json({ round: activeClankerRound(), config: clanker500.clanker500Config() }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/clanker500/round", async (req, res) => {
  try {
    const config = clanker500.clanker500Config();
    let round = rounds.createRound({
      stakeUsdc: "0",
      stakeAsset: "native-eth",
      stakeWei: config.stakeWei,
      stakeDisplay: config.stakeDisplay,
      chainNetwork: "base-sepolia",
      feeUsdc: "0",
      durationSecs: Number(req.body?.durationSecs ?? 30),
      countdownSecs: Number(req.body?.countdownSecs ?? 3),
      challengeTtlSecs: Number(req.body?.challengeTtlSecs ?? 600),
      stageCalibration: req.body?.stageCalibration ?? clankerStageCalibration(),
    });
    let openError: string | undefined;
    if (req.body?.open !== false && process.env.CLANKER500_ESCROW_ADDRESS && process.env.CLANKER500_FACILITATOR_PRIVATE_KEY) {
      try {
        const opened = await clanker500.openRoundOnChain(round);
        round = rounds.attachChainRace(round.id, opened.raceId, opened.tx);
        logOnchain("CLANKER500 OPEN", `round ${round.id} opened on Base Sepolia`, opened.tx);
      } catch (e: any) {
        openError = e.message;
      }
    }
    res.json({ round, config, openError });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/clanker500/round/:id/claim-next-slot", (req, res) => {
  try {
    const wallet = requireWalletAddress(req.body?.wallet);
    const round = rounds.getRound(req.params.id);
    if (round.stakeAsset !== "native-eth") throw new Error("not a Clanker500 round");
    const slot = nextClankerSlot(round, wallet);
    const claimed = rounds.claimSlot(req.params.id, slot, {
      wallet,
      displayName: optionalString(req.body?.displayName) ?? shortWallet(wallet),
    });
    res.json({ round: claimed, slot, driver: claimed.drivers[slot] });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/clanker500/round/:id/join-tx", async (req, res) => {
  try {
    const slot = requireDriverSlot(req.body?.slot);
    const wallet = requireWalletAddress(req.body?.wallet);
    let round = rounds.getRound(req.params.id);
    if (round.stakeAsset !== "native-eth") throw new Error("not a Clanker500 round");
    if (!round.chainRaceId) {
      const opened = await clanker500.openRoundOnChain(round);
      round = rounds.attachChainRace(round.id, opened.raceId, opened.tx);
      logOnchain("CLANKER500 OPEN", `round ${round.id} opened on Base Sepolia`, opened.tx);
    }
    res.json(clanker500.buildJoinTransaction(round, slot, wallet));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/clanker500/round/:id/confirm-join", async (req, res) => {
  try {
    const slot = requireDriverSlot(req.body?.slot);
    const wallet = requireWalletAddress(req.body?.wallet);
    const round = rounds.getRound(req.params.id);
    if (round.stakeAsset !== "native-eth") throw new Error("not a Clanker500 round");
    const verified = await clanker500.verifyJoinTransaction({
      round,
      slot,
      wallet,
      txHash: String(req.body?.txHash ?? ""),
    });
    const joined = rounds.markNativeChainJoined(req.params.id, slot, verified.tx, {
      stakeWei: verified.stakeWei,
      chainNetwork: "base-sepolia",
    });
    logOnchain("CLANKER500 JOIN", `${slot} staked ${joined.stakeDisplay ?? joined.stakeWei ?? "ETH"}`, verified.tx);
    res.json({ round: joined, slot, verified });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/clanker500/round/:id/lock", async (req, res) => {
  try {
    let round = rounds.getRound(req.params.id);
    if (round.stakeAsset !== "native-eth") throw new Error("not a Clanker500 round");
    if (round.status !== "ready" && round.status !== "locked") throw new Error("round is not ready");
    if (round.chainStatus === "joined") {
      const locked = await clanker500.lockRoundOnChain(round);
      round = rounds.markChainLocked(req.params.id, locked.tx);
      logOnchain("CLANKER500 LOCK", `round ${round.id} locked`, locked.tx);
    }
    if (round.status === "ready") {
      round = req.body?.skipRobotAuth || process.env.ALLOW_FREE_PILOT === "1"
        ? rounds.lockRoundLocal(req.params.id)
        : await rounds.lockRound(req.params.id, (name) => robot(name).url);
      evidence.recordRoundSnapshot(round, "locked");
    }
    res.json(round);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/clanker500/round/:id/countdown", (req, res) => {
  try {
    const existing = rounds.getRound(req.params.id);
    if (existing.stakeAsset !== "native-eth") throw new Error("not a Clanker500 round");
    const round = rounds.startCountdown(req.params.id);
    telemetryTrace.appendRoundTraceEvent(round, "countdown-start", {
      countdownSecs: round.countdownSecs,
      roundStartsAt: round.roundStartsAt ?? null,
    }, { atMs: round.countdownStartedAt });
    res.json(round);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/clanker500/round/:id/start", async (req, res) => {
  try {
    let round = rounds.getRound(req.params.id);
    if (round.stakeAsset !== "native-eth") throw new Error("not a Clanker500 round");
    if (round.status !== "countdown") throw new Error(`expected countdown, got ${round.status}`);
    if ((round.roundStartsAt ?? 0) > Date.now()) throw new Error("countdown has not finished");
    if (round.chainStatus === "locked") {
      const started = await clanker500.startRoundOnChain(round);
      round = rounds.markChainStarted(req.params.id, started.tx);
      logOnchain("CLANKER500 START", `round ${round.id} started on-chain`, started.tx);
    }
    round = rounds.startRace(req.params.id);
    evidence.recordRoundSnapshot(round, "started");
    telemetryTrace.appendRoundTraceEvent(round, "go", {
      startedAt: round.startedAt ?? null,
      durationSecs: round.durationSecs,
    }, { atMs: round.startedAt });
    res.json(round);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/clanker500/round/:id/settle", async (req, res) => {
  try {
    let round = rounds.getRound(req.params.id);
    if (round.stakeAsset !== "native-eth") throw new Error("not a Clanker500 round");
    if (round.status !== "finished" && round.status !== "settled") throw new Error("round is not finished");
    if (round.chainStatus !== "started" && round.chainStatus !== "finished" && round.chainStatus !== "settled") {
      throw new Error("on-chain round is not ready to settle");
    }
    if (round.chainStatus === "started") {
      round = ensureResultEvidence(round);
      const finished = await clanker500.finishRoundOnChain(round);
      round = rounds.markChainFinished(req.params.id, finished.tx);
      logOnchain("CLANKER500 FINISH", `${round.winner} wins round ${round.id}`, finished.tx);
    }
    const settled = await clanker500.settleRoundOnChain(round);
    round = rounds.markChainSettled(req.params.id, settled.tx);
    evidence.recordRoundSnapshot(round, "settled");
    const hashes = evidence.getEvidenceHash(round);
    const finalRound = rounds.markEvidenceHashes(req.params.id, hashes.proofHash, hashes.evidenceHash);
    logOnchain("CLANKER500 SETTLE", `${finalRound.winner} paid native ETH stake`, settled.tx);
    res.json(finalRound);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/clanker500/round/:id/cancel", async (req, res) => {
  try {
    let round = rounds.getRound(req.params.id);
    const reason = String(req.body?.reason ?? "operator canceled");
    if (round.stakeAsset !== "native-eth") throw new Error("not a Clanker500 round");
    if (round.chainRaceId && round.chainStatus !== "canceled" && round.chainStatus !== "settled") {
      const canceled = await clanker500.cancelRoundOnChain(round, reason);
      round = rounds.markChainCanceled(req.params.id, canceled.tx, reason);
      logOnchain("CLANKER500 CANCEL", reason, canceled.tx);
    } else {
      round = rounds.cancelRound(req.params.id, { code: "operator_cancel", reason });
    }
    res.json(round);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get("/race/round/:id", (req, res) => {
  try { res.json(rounds.getRound(req.params.id)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

app.post("/race/round/:id/accept", (req, res) => {
  try { res.json(rounds.acceptRound(req.params.id, req.body)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/fee-paid", (req, res) => {
  try { res.json(rounds.markFeePaid(req.params.id, req.body.slot, req.body.payment)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/stake-authorize", (req, res) => {
  try { res.json(rounds.authorizeStake(req.params.id, req.body.slot, req.body.authorization)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/stake/prepare", (req, res) => {
  try {
    const round = rounds.getRound(req.params.id);
    const slot = requireDriverSlot(req.body.slot);
    const adapter = stakeAdapters.stakeAdapter(req.body.adapter);
    res.json(adapter.prepareStake(round, slot, req.body.wallet));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/stake/verify", async (req, res) => {
  try {
    const round = rounds.getRound(req.params.id);
    const slot = requireDriverSlot(req.body.slot);
    const adapter = stakeAdapters.stakeAdapter(req.body.adapter);
    const authorization = await adapter.verifyStake(round, slot, req.body);
    res.json(rounds.authorizeStake(req.params.id, slot, authorization as Record<string, unknown>));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get("/race/round/:id/stake/settlement-plan", (req, res) => {
  try {
    const round = rounds.getRound(req.params.id);
    const adapter = stakeAdapters.stakeAdapter(String(req.query.adapter ?? "base-spend-permission"));
    res.json(adapter.settle(round));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get("/race/round/:id/calibration", (req, res) => {
  try { res.json({ roundId: req.params.id, stageCalibration: rounds.getStageCalibration(req.params.id) }); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

app.post("/race/round/:id/calibration", (req, res) => {
  try { res.json(rounds.updateStageCalibration(req.params.id, req.body.stageCalibration ?? req.body)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/lock", async (req, res) => {
  try {
    if (req.body?.skipRobotAuth) {
      if (process.env.ALLOW_FREE_PILOT !== "1") {
        return res.status(403).json({ error: "skipRobotAuth requires ALLOW_FREE_PILOT=1" });
      }
      const round = rounds.lockRoundLocal(req.params.id);
      evidence.recordRoundSnapshot(round, "locked");
      return res.json(round);
    }
    const round = await rounds.lockRound(req.params.id, (name) => robot(name).url);
    evidence.recordRoundSnapshot(round, "locked");
    res.json(round);
  }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/countdown", (req, res) => {
  try {
    const round = rounds.startCountdown(req.params.id);
    telemetryTrace.appendRoundTraceEvent(round, "countdown-start", {
      countdownSecs: round.countdownSecs,
      roundStartsAt: round.roundStartsAt ?? null,
    }, { atMs: round.countdownStartedAt });
    res.json(round);
  }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/start", (req, res) => {
  try {
    const round = rounds.startRace(req.params.id);
    evidence.recordRoundSnapshot(round, "started");
    telemetryTrace.appendRoundTraceEvent(round, "go", {
      startedAt: round.startedAt ?? null,
      durationSecs: round.durationSecs,
    }, { atMs: round.startedAt });
    res.json(round);
  }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/finish", async (req, res) => {
  try {
    res.json(await finishRoundWithEvidence(req.params.id, requireDriverSlot(req.body.winner), req.body.proof));
  }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/finish-detection", async (req, res) => {
  try {
    let round = rounds.getRound(req.params.id);
    const detection = evidence.recordFinishDetection(round, req.body);
    if (round.status === "finished" || round.status === "settled") {
      if (round.winner && round.winner !== detection.slot) {
        throw new Error(`round already finished with ${round.winner}`);
      }
      telemetryTrace.appendDriverTraceEvent(round, detection.slot, "finish-proof-captured", finishDetectionTraceDetail(detection), {
        atMs: detection.detectedAtMs,
      });
      const hashes = evidence.getEvidenceHash(round);
      round = rounds.markEvidenceHashes(req.params.id, hashes.proofHash, hashes.evidenceHash);
      return res.json({ round, detection, detections: evidence.listFinishDetections(round) });
    }
    if (req.body?.autoFinish === false) {
      telemetryTrace.appendDriverTraceEvent(round, detection.slot, "finish-proof-captured", finishDetectionTraceDetail(detection), {
        atMs: detection.detectedAtMs,
      });
      const hashes = evidence.getEvidenceHash(round);
      round = rounds.markEvidenceHashes(req.params.id, hashes.proofHash, hashes.evidenceHash);
      return res.json({ round, detection, detections: evidence.listFinishDetections(round) });
    }
    round = await finishRoundWithEvidence(req.params.id, detection.slot, {
      source: "finish-detection",
      detectionId: detection.id,
      detection,
    });
    res.json({ round, detection, detections: evidence.listFinishDetections(round) });
  }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get("/race/round/:id/finish-detections", (req, res) => {
  try { res.json({ detections: evidence.listFinishDetections(rounds.getRound(req.params.id)) }); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

app.get("/race/round/:id/telemetry-trace", (req, res) => {
  try {
    const includeFrames = req.query.frames === "1" || req.query.frames === "true";
    res.json(telemetryTrace.buildTelemetryTraceSummary(rounds.getRound(req.params.id), includeFrames));
  } catch (e: any) { res.status(404).json({ error: e.message }); }
});

app.get("/race/round/:id/evidence", (req, res) => {
  try {
    const round = rounds.getRound(req.params.id);
    const body = evidence.getEvidence(round);
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", `attachment; filename=round-${round.id}-evidence.json`);
    }
    res.json(body);
  } catch (e: any) { res.status(404).json({ error: e.message }); }
});

app.get("/race/round/:id/evidence/hash", (req, res) => {
  try { res.json(evidence.getEvidenceHash(rounds.getRound(req.params.id))); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

app.get("/race/round/:id/proof-frame/:file", (req, res) => {
  try {
    rounds.getRound(req.params.id);
    res.type("image/jpeg");
    res.sendFile(raceStore.proofFramePath(req.params.id, req.params.file));
  } catch (e: any) { res.status(404).json({ error: e.message }); }
});

app.post("/race/round/:id/cancel", (req, res) => {
  try { res.json(rounds.cancelRound(req.params.id, req.body)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/pilot/session", (req, res) => {
  try {
    const round = rounds.getRound(req.params.id);
    const slot = requireDriverSlot(req.body.slot);
    const driver = round.drivers[slot];
    if (!driver?.robot) throw new Error(`missing robot for ${slot}`);
    if (!driver.feePaid || !driver.stakeAuthorized) throw new Error(`${slot} has not joined the round`);
    if (round.chainRaceId && !driver.chainJoined) throw new Error(`${slot} has not joined on-chain`);
    if (!["locked", "countdown", "racing"].includes(round.status)) {
      throw new Error("round must be locked before pilot delegation");
    }
    if (round.status === "locked" && !round.roundStartsAt) {
      throw new Error("countdown has not been scheduled");
    }
    if (process.env.ALLOW_FREE_PILOT !== "1") {
      throw new Error("round pilot delegation requires ALLOW_FREE_PILOT=1 in the local harness");
    }
    const publicBaseUrl = process.env.PUBLIC_SIDECAR_URL
      || `${req.protocol}://${req.get("host")}`;
    const ttlSecs = Math.max(30, round.durationSecs + round.countdownSecs + 30);
    const startsAt = round.roundStartsAt ?? Date.now();
    const notBeforeMs = round.status === "racing" ? undefined : startsAt;
    const notAfterMs = startsAt + round.durationSecs * 1000;
    const session = robotLink.authorizePilotSession(driver.robot, publicBaseUrl, {
      ttlSecs,
      speedMode: calibratedSpeedMode(round, robotLink.parseSpeedMode(req.body.speed_mode)),
      maxSpeedMode: round.stageCalibration.speedDefaults.maxSpeedMode,
      notBeforeMs,
      notAfterMs,
    });
    res.json({ ...session, round: pilotRoundState(round, slot) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Free pilot session (gated by ALLOW_FREE_PILOT). This local harness path
// issues a sidecar bridge token; paid production sessions can keep using the
// lower-latency direct robot path until the bridge is promoted there too.
app.post("/pilot/dev-authorize", async (req, res) => {
  if (process.env.ALLOW_FREE_PILOT !== "1")
    return res.status(403).json({ error: "free pilot disabled — use the paid /pilot/:robot/start (x402)" });
  const name = robotLink.requireRobotName(req.body.robot ?? "courier");
  const publicBaseUrl = process.env.PUBLIC_SIDECAR_URL
    || `${req.protocol}://${req.get("host")}`;
  try {
    res.json(robotLink.authorizePilotSession(name, publicBaseUrl, {
      ttlSecs: 300,
      speedMode: robotLink.parseSpeedMode(req.body.speed_mode) ?? "medium",
    }));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ---------- Mission-control dashboard --------------------------------------
// One aggregate poll for the dashboard: robots + auction + on-chain balances.
app.get("/status", async (_req, res) => {
  if (MOCK) return res.json(mockStatus());
  const robots = await Promise.all(Object.entries(ROBOTS).map(async ([n, r]) => {
    let health: any = { ok: false, error: "unreachable" };
    try {
      health = await (await fetch(`${r.url}/health`,
        { signal: AbortSignal.timeout(2500) })).json();
    } catch {}
    let usdc6 = "0";
    try { if (r.wallet) usdc6 = (await settle.usdcBalance(r.wallet)).toString(); } catch {}
    return [n, { ...health, ens: r.ens, wallet: r.wallet, usdc6, url: r.url }];
  }));
  let ensFleet: any = null;
  try { ensFleet = await ens.fleet(); } catch {}
  res.json({
    ok: true,
    arc: { chainId: ARC.chainId, explorer: ARC.explorer },
    eventPass: process.env.EVENTPASS_ADDRESS ?? null,
    robots: Object.fromEntries(robots),
    race: race.raceState(),
    ens: ensFleet,
  });
});

app.get("/field/preflight", async (req, res) => {
  const publicBaseUrl = process.env.PUBLIC_SIDECAR_URL
    || `${req.protocol}://${req.get("host")}`;
  res.json(await fieldPreflight.buildFieldPreflight({
    publicBaseUrl,
    allowFreePilot: process.env.ALLOW_FREE_PILOT === "1",
    allowLocalDevWallets: localDevWalletsEnabled(),
  }));
});

app.use(express.static(new URL("../public", import.meta.url).pathname));

// Express error middleware — any thrown/rejected handler returns 500, no crash.
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("handler error:", err?.message ?? err);
  if (!res.headersSent) res.status(500).json({ error: String(err?.message ?? err) });
});

const PORT = Number(process.env.PORT ?? 4021);
server.listen(PORT, () => console.log(`sidecar on :${PORT} (Arc ${ARC.chainId})`));

function localDevWalletsEnabled() {
  return process.env.ALLOW_LOCAL_DEV_WALLETS === "1" || process.env.ALLOW_FREE_PILOT === "1";
}

function preflightRaceJoinFee(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const slot = requireDriverSlot(req.body?.slot);
    const wallet = requireWalletAddress(req.body?.wallet);
    const displayName = optionalString(req.body?.displayName);
    const round = rounds.getRound(req.params.id);
    validateRaceJoinFeePreflight(round, slot, wallet);
    (req as any).raceJoinFee = { slot, wallet, displayName };
    next();
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}

function recordRaceJoinFee(req: express.Request, res: express.Response) {
  try {
    const join = (req as any).raceJoinFee as {
      slot: rounds.DriverSlot;
      wallet: string;
      displayName?: string;
    };
    if (!join) throw new Error("missing race join preflight");

    let round = rounds.getRound(req.params.id);
    if (!round.drivers[join.slot]?.wallet) {
      round = rounds.claimSlot(req.params.id, join.slot, {
        wallet: join.wallet,
        displayName: join.displayName,
      });
    }

    const payment = x402RaceFeePayment(req, join.wallet, join.displayName);
    round = rounds.markFeePaid(req.params.id, join.slot, payment);
    res.json({
      round,
      slot: join.slot,
      feePayment: round.drivers[join.slot]?.feePayment,
      payment: (req as any).payment,
      ready: round.status === "ready",
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}

function validateRaceJoinFeePreflight(
  round: rounds.Round,
  slot: rounds.DriverSlot,
  wallet: string,
) {
  if (!isWalletAddress(process.env.TREASURY_ADDRESS)) {
    throw new Error("TREASURY_ADDRESS required for x402 race join fee");
  }
  if (round.status !== "accepted" && round.status !== "ready") {
    throw new Error(`round is not joinable in ${round.status}`);
  }
  if (normalizeUsdcAmount(round.feeUsdc) !== RACE_NETWORK_FEE_USDC) {
    throw new Error(`round fee must match fixed x402 fleet fee ${RACE_NETWORK_FEE_USDC}`);
  }

  const driver = round.drivers[slot];
  if (driver?.feePaid) throw new Error(`${slot} fee already paid`);
  if (driver?.wallet && driver.wallet.toLowerCase() !== wallet) {
    throw new Error(`${slot} is claimed by a different wallet`);
  }

  const otherSlot: rounds.DriverSlot = slot === "challenger" ? "opponent" : "challenger";
  if (round.drivers[otherSlot]?.wallet.toLowerCase() === wallet) {
    throw new Error("wallet already claimed the other slot");
  }
}

function x402RaceFeePayment(
  req: express.Request,
  wallet: string,
  displayName?: string,
): Record<string, unknown> {
  const payment = (req as any).payment as {
    payer?: string;
    amount?: string;
    network?: string;
    transaction?: string;
  } | undefined;
  const payer = payment?.payer ? requireWalletAddress(payment.payer) : wallet;
  if (payer !== wallet) throw new Error("x402 payer does not match joined wallet");

  const expectedUnits = parseUsdcUnits(RACE_NETWORK_FEE_USDC).toString();
  const amountUnits = String(payment?.amount ?? expectedUnits);
  if (amountUnits !== expectedUnits) {
    throw new Error(`x402 amount mismatch: expected ${expectedUnits}, got ${amountUnits}`);
  }
  const network = optionalString(payment?.network) ?? ARC.caip2;
  const transaction = optionalString(payment?.transaction);

  return {
    status: "paid",
    source: "x402",
    amountUsdc: RACE_NETWORK_FEE_USDC,
    amountUnits,
    recipientTreasury: process.env.TREASURY_ADDRESS,
    paymentId: transaction ? `${network}:${transaction}` : undefined,
    txHash: transaction,
    payer,
    paidAt: Date.now(),
    reconciliationStatus: transaction ? "reconciled" : "needs-proof",
    displayName,
  };
}

function ensureLocalDevDriver(roundId: string, slot: rounds.DriverSlot): rounds.Round {
  const devWallet = localDevWallets.localDevWallet(slot);
  let round = rounds.getRound(roundId);
  const currentWallet = round.drivers[slot]?.wallet ?? "";
  if (!currentWallet) {
    return rounds.claimSlot(roundId, slot, {
      wallet: devWallet.address,
      displayName: devWallet.displayName,
    });
  }
  if (currentWallet.toLowerCase() !== devWallet.address.toLowerCase()) {
    throw new Error(`${slot} is claimed by ${currentWallet}, not local dev wallet ${devWallet.address}`);
  }
  return round;
}

function requireDriverSlot(value: unknown): rounds.DriverSlot {
  if (value === "challenger" || value === "opponent") return value;
  throw new Error("slot must be challenger or opponent");
}

function requireWalletAddress(value: unknown): string {
  const wallet = optionalString(value);
  if (!isWalletAddress(wallet)) throw new Error("valid EVM wallet required");
  return wallet.toLowerCase();
}

function activeClankerRound(): rounds.Round | null {
  return rounds.listRounds().find((round) =>
    round.stakeAsset === "native-eth" &&
    !["settled", "canceled"].includes(round.status)
  ) ?? null;
}

function nextClankerSlot(round: rounds.Round, wallet: string): rounds.DriverSlot {
  const normalized = wallet.toLowerCase();
  for (const slot of ["challenger", "opponent"] as const) {
    if (round.drivers[slot]?.wallet?.toLowerCase() === normalized) return slot;
  }
  if (!round.drivers.challenger?.wallet) return "challenger";
  if (!round.drivers.opponent?.wallet) return "opponent";
  throw new Error("Clanker500 heat is full");
}

function clankerStageCalibration() {
  return {
    laneLengthFt: 12,
    laneWidthFt: 3,
    startLineFt: 0,
    finishLineFt: 12,
    robotAssignments: {
      challenger: { robot: "guard", lane: "left" },
      opponent: { robot: "courier", lane: "right" },
    },
    speedDefaults: {
      defaultSpeedMode: "medium",
      maxSpeedMode: "medium",
    },
    safetyDefaults: {
      obstacleStopDistanceFt: 1.5,
      warningDistanceFt: 3,
    },
  };
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function isWalletAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeUsdcAmount(value: unknown): string {
  return formatUsdcUnits(parseUsdcUnits(value));
}

function parseUsdcUnits(value: unknown): bigint {
  const input = String(value ?? "").trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,6})?$/.test(input)) {
    throw new Error(`invalid USDC amount: ${String(value)}`);
  }
  const [whole, fraction = ""] = input.split(".");
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (units <= 0n) throw new Error(`invalid USDC amount: ${String(value)}`);
  return units;
}

function formatUsdcUnits(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function ensureResultEvidence(round: rounds.Round): rounds.Round {
  if (round.proofHash) return round;
  if (!round.winner) throw new Error("round winner required");
  const finalized = evidence.finalizeResultProof(round, round.proof);
  return rounds.markEvidenceHashes(round.id, finalized.proofHash, finalized.evidenceHash);
}

function calibratedSpeedMode(
  round: rounds.Round,
  requested: robotLink.SpeedMode | null | undefined,
): robotLink.SpeedMode {
  const max = round.stageCalibration.speedDefaults.maxSpeedMode;
  const fallback = round.stageCalibration.speedDefaults.defaultSpeedMode;
  const mode = requested ?? fallback;
  const rank: Record<robotLink.SpeedMode, number> = { low: 0, medium: 1, high: 2 };
  return rank[mode] > rank[max] ? max : mode;
}

function pilotRoundState(round: rounds.Round, slot: rounds.DriverSlot) {
  const driver = round.drivers[slot];
  return {
    id: round.id,
    status: round.status,
    stakeUsdc: round.stakeUsdc,
    stakeAsset: round.stakeAsset ?? "usdc",
    stakeWei: round.stakeWei,
    stakeDisplay: round.stakeDisplay,
    chainNetwork: round.chainNetwork,
    feeUsdc: round.feeUsdc,
    durationSecs: round.durationSecs,
    countdownSecs: round.countdownSecs,
    roundStartsAt: round.roundStartsAt,
    startedAt: round.startedAt,
    driver: driver ? {
      slot,
      wallet: driver.wallet,
      displayName: driver.displayName,
      robot: driver.robot,
      lane: driver.lane,
      feePaid: driver.feePaid,
      stakeAuthorized: driver.stakeAuthorized,
      chainJoined: Boolean(driver.chainJoined),
    } : null,
  };
}

async function finishRoundWithEvidence(
  roundId: string,
  winner: rounds.DriverSlot,
  proof?: Record<string, unknown>,
): Promise<rounds.Round> {
  const preFinishRound = rounds.getRound(roundId);
  const proofWithFrame = await enrichFinishProofWithCameraFrame(preFinishRound, winner, proof);
  let round = rounds.finishRound(roundId, winner, proofWithFrame);
  evidence.recordRoundSnapshot(round, "finished");
  const finalized = evidence.finalizeResultProof(round, proofWithFrame);
  round = rounds.markEvidenceHashes(roundId, finalized.proofHash, finalized.evidenceHash);
  telemetryTrace.appendDriverTraceEvent(round, winner, "finish-proof-captured", finishProofTraceDetail(round.proof ?? proofWithFrame), {
    atMs: finishProofAtMs(round.proof ?? proofWithFrame) ?? round.finishedAt,
  });
  telemetryTrace.appendRoundTraceEvent(round, "race-finish", {
    winner,
    finishMs: round.finishMs ?? null,
    proofHash: round.proofHash ?? null,
    evidenceHash: round.evidenceHash ?? null,
  }, { atMs: round.finishedAt });
  revokeRoundPilots(round);
  return round;
}

async function enrichFinishProofWithCameraFrame(
  round: rounds.Round,
  winner: rounds.DriverSlot,
  proof?: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const base = proof ? structuredClone(proof) : {};
  const existingFrame = base.proofFrame && typeof base.proofFrame === "object"
    ? base.proofFrame as Record<string, unknown>
    : {};
  const existingHash = typeof base.frameHash === "string"
    ? base.frameHash
    : typeof existingFrame.frameHash === "string"
      ? existingFrame.frameHash
      : undefined;
  const capture = await captureFinishProofFrame(round, winner);
  if (capture.status === "captured") {
    return {
      ...base,
      frameHash: capture.frameHash,
      frameSource: capture.source,
      frameCapturedAtMs: capture.capturedAtMs,
      proofFrame: capture,
    };
  }
  if (existingHash) {
    return {
      ...base,
      proofFrame: {
        ...existingFrame,
        status: existingFrame.status ?? "captured",
        frameHash: existingHash,
        robotCapture: capture,
      },
    };
  }
  return {
    ...base,
    proofFrame: capture,
    frameCaptureStatus: capture.status,
    frameError: capture.error,
  };
}

async function captureFinishProofFrame(round: rounds.Round, winner: rounds.DriverSlot): Promise<Record<string, unknown>> {
  const driver = round.drivers[winner];
  if (!driver?.robot) {
    return {
      status: "failed",
      source: "robot-camera",
      capturedAtMs: Date.now(),
      error: `missing robot for ${winner}`,
    };
  }
  const robotName = driver.robot;
  const frames: Array<{ bytes: Buffer; contentType: string; source: string; capturedAtMs: number }> = [];
  const errors: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    try {
      frames.push(await captureRobotCameraFrame(robotName));
    } catch (e: any) {
      errors.push(e?.message || String(e));
    }
    if (index < 2) await sleep(120);
  }
  const best = frames.sort((a, b) => b.bytes.length - a.bytes.length).at(0);
  if (!best) {
    return {
      status: "failed",
      source: "robot-camera",
      robot: robotName,
      cameraId: `${robotName}/camera`,
      capturedAtMs: Date.now(),
      burstCount: 0,
      error: errors.at(-1) ?? "camera capture failed",
    };
  }
  const frameHash = `0x${createHash("sha256").update(best.bytes).digest("hex")}`;
  const filename = `${winner}-${best.capturedAtMs}-${frameHash.slice(2, 10)}.jpg`;
  const stored = raceStore.saveProofFrame(round.id, filename, best.bytes);
  return {
    status: "captured",
    frameHash,
    source: best.source,
    robot: robotName,
    cameraId: `${robotName}/camera`,
    capturedAtMs: best.capturedAtMs,
    blobRef: stored.blobRef,
    url: `/race/round/${encodeURIComponent(round.id)}/proof-frame/${encodeURIComponent(filename)}`,
    contentType: best.contentType,
    byteLength: best.bytes.length,
    burstCount: frames.length,
    frameAgeMs: Math.max(0, Date.now() - best.capturedAtMs),
  };
}

async function captureRobotCameraFrame(robotName: RobotName) {
  const baseUrl = robot(robotName).url;
  const snapshotUrl = new URL("/camera/snapshot", baseUrl).toString();
  const snapshot = await fetch(snapshotUrl, { signal: AbortSignal.timeout(1800) }).catch(() => null);
  if (snapshot?.ok && isImageResponse(snapshot)) {
    const bytes = Buffer.from(await snapshot.arrayBuffer());
    if (bytes.length > 0) {
      return {
        bytes,
        contentType: snapshot.headers.get("content-type") ?? "image/jpeg",
        source: "robot-camera-snapshot",
        capturedAtMs: Date.now(),
      };
    }
  }

  const streamUrl = new URL("/stream", baseUrl).toString();
  const stream = await fetch(streamUrl, { signal: AbortSignal.timeout(3500) });
  if (!stream.ok || !stream.body) throw new Error(`camera stream failed ${stream.status}`);
  const bytes = await readFirstJpeg(stream.body);
  return {
    bytes,
    contentType: "image/jpeg",
    source: "robot-camera-stream",
    capturedAtMs: Date.now(),
  };
}

function isImageResponse(res: Response) {
  return String(res.headers.get("content-type") ?? "").startsWith("image/");
}

async function readFirstJpeg(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  const maxBytes = 2_500_000;
  const deadline = Date.now() + 3000;
  try {
    while (Date.now() < deadline && total < maxBytes) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => setTimeout(() => reject(new Error("camera frame read timeout")), remaining)),
      ]);
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      chunks.push(chunk);
      total += chunk.length;
      const frame = firstJpeg(Buffer.concat(chunks, total));
      if (frame) return frame;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  throw new Error("no jpeg frame in camera stream");
}

function firstJpeg(buffer: Buffer): Buffer | null {
  let start = -1;
  for (let i = 0; i < buffer.length - 1; i += 1) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xd8) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  for (let i = start + 2; i < buffer.length - 1; i += 1) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) return buffer.subarray(start, i + 2);
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finishDetectionTraceDetail(detection: evidence.FinishDetectionEvent): Record<string, unknown> {
  return {
    detectionId: detection.id,
    source: detection.source,
    method: detection.method,
    confidence: detection.confidence,
    frameHash: detection.frameHash ?? null,
  };
}

function finishProofTraceDetail(proof?: Record<string, unknown>): Record<string, unknown> {
  const detection = proof?.detection as evidence.FinishDetectionEvent | undefined;
  if (detection?.id) return finishDetectionTraceDetail(detection);
  const proofFrame = proof?.proofFrame && typeof proof.proofFrame === "object"
    ? proof.proofFrame as Record<string, unknown>
    : undefined;
  return {
    source: typeof proof?.source === "string" ? proof.source : "operator",
    method: typeof proof?.method === "string" ? proof.method : "operator-confirmation",
    operatorActionId: typeof proof?.operatorActionId === "string" ? proof.operatorActionId : null,
    frameHash: typeof proof?.frameHash === "string" ? proof.frameHash : proofFrame?.hash ?? null,
    proofFrameStatus: proofFrame?.status ?? null,
    blobRef: proofFrame?.blobRef ?? null,
    url: proofFrame?.url ?? null,
    error: proofFrame?.error ?? null,
  };
}

function finishProofAtMs(proof?: Record<string, unknown>): number | undefined {
  const detection = proof?.detection as evidence.FinishDetectionEvent | undefined;
  if (Number.isFinite(Number(detection?.detectedAtMs))) return Number(detection?.detectedAtMs);
  const proofFrame = proof?.proofFrame && typeof proof.proofFrame === "object"
    ? proof.proofFrame as Record<string, unknown>
    : undefined;
  const capturedAtMs = Number(proofFrame?.capturedAtMs);
  return Number.isFinite(capturedAtMs) ? capturedAtMs : undefined;
}

function revokeRoundPilots(round: rounds.Round) {
  const robots = new Set(
    (["challenger", "opponent"] as const)
      .map((slot) => round.drivers[slot]?.robot)
      .filter((robot): robot is RobotName => robot === "guard" || robot === "courier"),
  );
  for (const robot of robots) robotLink.revokePilotSessions(robot, "round finished");
}
