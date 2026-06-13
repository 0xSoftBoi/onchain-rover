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
import * as identity from "./identity.js";
import * as worldid from "./worldid.js";
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
    }
    const odds = race.placeBet({ bettor, racer, amount: Number(amount), nullifier: v.nullifier });
    res.json({ ...odds, onchain });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.get("/race/odds", (_req, res) => res.json(race.odds()));

// --- Treasury (Ledger clear-sign governance climax) ------------------------
app.get("/treasury/info", async (_req, res) => {
  try { res.json(await settle.treasuryInfo()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});
app.get("/treasury/withdraw-tx", async (req, res) => {
  try {
    const { from, to, amount } = req.query as Record<string, string>;
    res.json(await settle.buildWithdrawTx(from, to, amount));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post("/treasury/broadcast", async (req, res) => {
  try { res.json(await settle.broadcastSigned(req.body.tx, req.body.signature)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ERC-8004 reputation summary (the leaderboard score) for each robot.
app.get("/reputation", async (_req, res) => {
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
    let settled;
    if (process.env.RACEMARKET_ADDRESS && onChainRaceId !== null) {
      const winnerIdx = r.racers.indexOf(winner);
      // proof: the guard's finish photo sha256 + Walrus blobId (req may carry them)
      settled = await settle.settleRaceOnChain(
        onChainRaceId, winnerIdx, req.body.sha256 ?? "", req.body.blobId ?? "");
    }
    res.json({ ...r, settled });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
// On finish: watcher reports winner -> verify-photo + store-proof ->
// RaceMarket.settle(raceId, winnerIdx, proofHash, blobId) via judge wallet.
// Wire after contract deploy (TODO tonight).

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
      await fetch(`${ROBOTS.courier.url}/negotiate/buy`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budget: 1.25, auctionId, timeout_secs: 70 }),
      });
      await new Promise((r) => setTimeout(r, 800));
      await fetch(`${ROBOTS.guard.url}/negotiate/sell`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: 2.0, floor: 0.5, step: 0.25, tick_secs: 4.0, auctionId }),
      });
      st.note = "haggling…";
      let deal: any = {};
      for (let i = 0; i < 35; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        deal = await (await fetch(
          `${ROBOTS.guard.url}/negotiate/result?auctionId=${auctionId}`)).json();
        if (deal.price) st.price = deal.price;
        if (deal.agreed !== undefined && !deal.pending) break;
      }
      if (!deal.agreed) { st.note = "no deal"; return; }
      st.agreed = true; st.buyer = deal.buyer; st.price = deal.price;
      st.note = "sold — settling on Arc…";
      if (doSettle) {
        const pay = await settle.pay("courier", "guard", String(deal.price));
        st.pay = pay.tx;
        const mint = await settle.mintPass("courier", String(deal.price));
        st.mint = mint.tx;
        st.note = "settled + minted; recording reputation…";
        // flywheel: requester rates the guard for the completed sale (skill=guard)
        try {
          const fb = await settle.giveFeedback({
            agentId: Number(ROBOTS.guard.agentId ?? 0), score: 95, skill: "guard",
          });
          st.feedback = fb.tx;
        } catch (e: any) { st.note = "minted; feedback skipped: " + e.message; }
        st.note = "settled + minted + reputation on Arc";
      }
    } catch (e: any) { st.note = "error: " + e.message; }
  })();
});

app.get("/race/auction/state", (req, res) => {
  res.json(auctions.get(String(req.query.auctionId)) ?? { note: "unknown" });
});

// Dev pilot authorize (no payment) — for testing the control loop. The real
// paid path is /pilot/:robot/start (x402). Returns the robot's WS drive URL.
app.post("/pilot/dev-authorize", async (req, res) => {
  const name = (req.body.robot ?? "courier") as RobotName;
  const token = "dev-" + Math.random().toString(36).slice(2, 10);
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
  res.json({
    ok: true,
    arc: { chainId: ARC.chainId, explorer: ARC.explorer },
    eventPass: process.env.EVENTPASS_ADDRESS ?? null,
    robots: Object.fromEntries(robots),
    race: race.raceState(),
  });
});

app.use(express.static(new URL("../public", import.meta.url).pathname));

const PORT = Number(process.env.PORT ?? 4021);
app.listen(PORT, () => console.log(`sidecar on :${PORT} (Arc ${ARC.chainId})`));
