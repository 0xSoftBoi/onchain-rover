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
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

import "./env.js"; // MUST be first — loads dotenv before any env-reading module
import { ARC, ROBOTS, type RobotName } from "./config.js";
import * as erc8004 from "./erc8004.js";
import * as ens from "./ens.js";
import * as lb from "./leaderboard.js";
import * as race from "./race.js";
import * as settle from "./settle.js";

const app = express();
app.use(express.json());

const gateway = createGatewayMiddleware({
  sellerAddress: process.env.TREASURY_ADDRESS!,    // fleet treasury (Ledger-governed)
  facilitatorUrl: ARC.facilitatorUrl,              // testnet! default is mainnet
  networks: [ARC.caip2],
});

const robot = (name: string) => {
  if (!(name in ROBOTS)) throw new Error("unknown robot");
  return ROBOTS[name as RobotName];
};

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

app.post("/race/open", (_req, res) => res.json(race.openRace()));
app.get("/race/state", (_req, res) => res.json(race.raceState()));
app.post("/race/arm", (_req, res) => res.json(race.armRace()));
app.post("/race/start", (_req, res) => res.json(race.startRace()));
app.post("/race/finish", (req, res) =>
  res.json(race.recordFinish(req.body.winner as RobotName)));
// On finish: watcher reports winner -> verify-photo + store-proof ->
// RaceMarket.settle(raceId, winnerIdx, proofHash, blobId) via judge wallet.
// Wire after contract deploy (TODO tonight).

// Checkpoint demo helpers.
app.post("/challenge", (req, res) => {
  const r = robot(req.body.robot);
  res.json({
    ens: r.ens, wallet: r.wallet, agentId: r.agentId,
    nonce: Math.random().toString(36).slice(2, 10), ts: Date.now(),
    // TODO tonight: sign {wallet,nonce,ts} with the robot's Privy wallet
  });
});

app.post("/verify-agent", async (req, res) => {
  // ERC-8004 registered? + AgentBook human-backed? + holds EventPass (on Arc)?
  const { wallet, agentId } = req.body;
  let holdsPass = false;
  try { holdsPass = wallet ? await settle.holdsPass(wallet) : false; } catch {}
  res.json({
    wallet, agentId,
    erc8004Registered: Boolean(agentId),
    humanBacked: null,   // TODO: AgentBook read on World Chain 480
    holdsPass,           // real on-chain EventPass read on Arc
  });
});

// Robot-to-robot payment: courier transfers the NEGOTIATED USDC to guard on Arc.
app.post("/pay", async (req, res) => {
  try {
    const { from = "courier", to = "guard", amt } = req.body;
    res.json(await settle.pay(from, to, String(amt)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Guard mints the EventPass to the buyer, recording the negotiated price on-chain.
app.post("/mint-pass", async (req, res) => {
  try {
    const { robot = "courier", price = "0.50" } = req.body;
    res.json(await settle.mintPass(robot, String(price)));
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
  const r = robot(req.body.robot);
  res.json(await erc8004.giveFeedback({
    agentId: BigInt(r.agentId ?? 0),
    score: req.body.score, skill: req.body.skill,
    blobId: req.body.blobId, sha256: req.body.sha256,
  }));
});

app.post("/ens/issue", async (req, res) => res.json(await ens.issueSubname(req.body)));
app.get("/ens/resolve", async (req, res) =>
  res.json(await ens.resolve(String(req.query.name))));

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

const PORT = Number(process.env.PORT ?? 4021);
app.listen(PORT, () => console.log(`sidecar on :${PORT} (Arc ${ARC.chainId})`));
