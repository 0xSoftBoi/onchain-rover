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
import { randomUUID } from "node:crypto";
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
import * as settle from "./settle.js";

// Never let one bad call take down the demo: log unhandled errors, stay up.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

const app = express();
app.use(express.json());

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

// Free pilot session (gated by ALLOW_FREE_PILOT). The PAID path is
// /pilot/:robot/start (x402, $1). Both issue the same real cryptographic
// session token authorizing the robot's WS drive — the only difference is
// payment. Off by default so production requires payment.
app.post("/pilot/dev-authorize", async (req, res) => {
  if (process.env.ALLOW_FREE_PILOT !== "1")
    return res.status(403).json({ error: "free pilot disabled — use the paid /pilot/:robot/start (x402)" });
  const name = (req.body.robot ?? "courier") as RobotName;
  const token = randomUUID();
  try {
    await fetch(`${robot(name).url}/pilot/authorize`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ttl_secs: 300 }),
    });
    res.json({ token, robot: name,
      driveWs: `${robot(name).url.replace("http", "ws")}/ws/drive` });
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

app.use(express.static(new URL("../public", import.meta.url).pathname));

// Express error middleware — any thrown/rejected handler returns 500, no crash.
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("handler error:", err?.message ?? err);
  if (!res.headersSent) res.status(500).json({ error: String(err?.message ?? err) });
});

const PORT = Number(process.env.PORT ?? 4021);
app.listen(PORT, () => console.log(`sidecar on :${PORT} (Arc ${ARC.chainId})`));
