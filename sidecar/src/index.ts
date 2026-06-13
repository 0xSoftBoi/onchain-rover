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
import { createServer } from "node:http";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

import "./env.js"; // MUST be first — loads dotenv before any env-reading module
import { ARC, ROBOTS, type RobotName } from "./config.js";
import * as erc8004 from "./erc8004.js";
import * as ens from "./ens.js";
import * as identity from "./identity.js";
import * as worldid from "./worldid.js";
import * as lb from "./leaderboard.js";
import * as race from "./race.js";
import * as chain from "./chain.js";
import * as evidence from "./evidence.js";
import * as fieldPreflight from "./field-preflight.js";
import * as localDevWallets from "./local-dev-wallets.js";
import * as robotLink from "./robot-link.js";
import * as rounds from "./rounds.js";
import * as settle from "./settle.js";
import * as stakeAdapters from "./stake-adapter.js";
import * as treasuryLedger from "./treasury-ledger.js";

// Never let one bad call take down the demo: log unhandled errors, stay up.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

const app = express();
app.use(express.json());
const server = createServer(app);
robotLink.installRobotLink(app, server);

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
type OnchainEvent = { t: number; kind: string; tx?: string; detail: string; explorer?: string };
const onchainFeed: OnchainEvent[] = [];
function logOnchain(kind: string, detail: string, tx?: string) {
  onchainFeed.unshift({ t: Date.now(), kind, detail, tx,
    explorer: tx ? `${ARC.explorer}/tx/${tx}` : undefined });
  if (onchainFeed.length > 50) onchainFeed.pop();
}
app.get("/onchain/feed", (_req, res) => res.json({ events: onchainFeed.slice(0, 30) }));

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
      logOnchain("BET", `$${amount} on ${racer} (World-verified human)`, onchain?.tx);
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
    // The GUARD is the race oracle: capture its finish-line photo and anchor it
    // immutably on Walrus — that real hash + blobId settle the market on-chain.
    let proof: { sha256?: string; blobId?: string } = {};
    try {
      await fetch(`${robot("guard").url}/capture`, { method: "POST",
        signal: AbortSignal.timeout(8000) });
      proof = await (await fetch(`${robot("guard").url}/store-proof`, { method: "POST",
        signal: AbortSignal.timeout(20000) })).json();
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
  try {
    const r = robot(req.body.robot);
    // Arc reputation (same chain as the rest of the flywheel)
    res.json(await settle.giveFeedback({
      agentId: Number(r.agentId ?? 0),
      score: req.body.score, skill: req.body.skill,
      blobId: req.body.blobId, sha256: req.body.sha256,
    }));
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
      if (!deal.agreed) { st.note = "no deal"; return; }
      st.agreed = true; st.buyer = deal.buyer; st.price = deal.price;
      st.note = "sold — settling on Arc…";
      if (doSettle) {
        const pay = await settle.pay("courier", "guard", String(deal.price));
        st.pay = pay.tx;
        logOnchain("PAY", `courier → guard $${deal.price} USDC`, pay.tx);
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
  try { res.json(rounds.startCountdown(req.params.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/start", (req, res) => {
  try {
    const round = rounds.startRace(req.params.id);
    evidence.recordRoundSnapshot(round, "started");
    res.json(round);
  }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/finish", (req, res) => {
  try {
    res.json(finishRoundWithEvidence(req.params.id, requireDriverSlot(req.body.winner), req.body.proof));
  }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/race/round/:id/finish-detection", (req, res) => {
  try {
    let round = rounds.getRound(req.params.id);
    const detection = evidence.recordFinishDetection(round, req.body);
    if (round.status === "finished" || round.status === "settled") {
      if (round.winner && round.winner !== detection.slot) {
        throw new Error(`round already finished with ${round.winner}`);
      }
      const hashes = evidence.getEvidenceHash(round);
      round = rounds.markEvidenceHashes(req.params.id, hashes.proofHash, hashes.evidenceHash);
      return res.json({ round, detection, detections: evidence.listFinishDetections(round) });
    }
    if (req.body?.autoFinish === false) {
      const hashes = evidence.getEvidenceHash(round);
      round = rounds.markEvidenceHashes(req.params.id, hashes.proofHash, hashes.evidenceHash);
      return res.json({ round, detection, detections: evidence.listFinishDetections(round) });
    }
    round = finishRoundWithEvidence(req.params.id, detection.slot, {
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

function finishRoundWithEvidence(
  roundId: string,
  winner: rounds.DriverSlot,
  proof?: Record<string, unknown>,
): rounds.Round {
  let round = rounds.finishRound(roundId, winner, proof);
  evidence.recordRoundSnapshot(round, "finished");
  const finalized = evidence.finalizeResultProof(round, proof);
  round = rounds.markEvidenceHashes(roundId, finalized.proofHash, finalized.evidenceHash);
  revokeRoundPilots(round);
  return round;
}

function revokeRoundPilots(round: rounds.Round) {
  const robots = new Set(
    (["challenger", "opponent"] as const)
      .map((slot) => round.drivers[slot]?.robot)
      .filter((robot): robot is RobotName => robot === "guard" || robot === "courier"),
  );
  for (const robot of robots) robotLink.revokePilotSessions(robot, "round finished");
}
