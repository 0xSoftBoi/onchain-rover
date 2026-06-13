/**
 * Rover GP — pay-to-pilot sessions + parimutuel race betting (Act 2).
 *
 * SAFETY IS SERVER-SIDE: the gamepad client is untrusted. This module clamps
 * speed, enforces session expiry, and rate-limits drive commands before
 * anything reaches the robot. Geofence runs on the robot (odometry).
 *
 * Betting: RaceMarket.sol on Arc testnet (USDC, 6dp). bet() during the open
 * window (one-bet-per-human enforced via World ID nullifier before we relay),
 * settle(raceId, winner) only by the judge wallet (GUARD attests the finish).
 */
import { randomUUID } from "node:crypto";
import { ROBOTS, type RobotName } from "./config.js";

const MAX_SPEED = 0.35;
const SESSION_SECS = 120;
const CMD_MIN_INTERVAL_MS = 80;

type Session = {
  id: string; robot: RobotName; expiresAt: number; lastCmdAt: number;
  pilot: string; // payer address from x402 (req.payment.payer)
};
const sessions = new Map<string, Session>();

export async function startPilotSession(robot: RobotName, pilot: string) {
  // one pilot per robot at a time
  for (const s of sessions.values())
    if (s.robot === robot && s.expiresAt > Date.now())
      throw new Error("robot busy");
  const s: Session = {
    id: randomUUID(), robot, pilot,
    expiresAt: Date.now() + SESSION_SECS * 1000, lastCmdAt: 0,
  };
  sessions.set(s.id, s);
  // Authorize the token on the robot — the pilot's browser then connects its
  // WebSocket DIRECTLY to the Jetson's /ws/drive (lowest latency; deadman +
  // speed clamp enforced robot-side).
  await fetch(`${ROBOTS[robot].url}/pilot/authorize`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: s.id, ttl_secs: SESSION_SECS }),
  });
  return {
    sessionId: s.id, robot, expiresInSecs: SESSION_SECS,
    driveWs: `${ROBOTS[robot].url.replace("http", "ws")}/ws/drive`,
    videoWhep: `${ROBOTS[robot].url.replace(":8000", ":8889")}/cam`,
  };
}

export async function drive(sessionId: string, left: number, right: number) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("no session");
  if (Date.now() > s.expiresAt) {
    sessions.delete(sessionId);
    await stopRobot(s.robot);
    throw new Error("session expired");
  }
  if (Date.now() - s.lastCmdAt < CMD_MIN_INTERVAL_MS) return { throttled: true };
  s.lastCmdAt = Date.now();

  const clamp = (v: number) => Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));
  const res = await fetch(`${ROBOTS[s.robot].url}/drive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ left: clamp(left), right: clamp(right) }),
  });
  return res.json();
}

export async function stopRobot(robot: RobotName) {
  await fetch(`${ROBOTS[robot].url}/stop`, { method: "POST" });
}

// --- DRAG RACE state (market on-chain; this is the off-chain coordinator) ---
// Straight-line sprint, first tag across the finish band wins (~10s heats).
// betting open -> armed (bets locked) -> 3-2-1-GO -> finished -> settle.
type Race = {
  id: string; status: "betting" | "armed" | "racing" | "finished";
  racers: RobotName[]; winner?: RobotName; startedAt?: number; finishMs?: number;
};
let current: Race | null = null;

export function openRace() {
  current = {
    id: randomUUID().slice(0, 8), status: "betting",
    racers: ["guard", "courier"],
  };
  return current;
}

export function raceState() {
  return current;
}

export function armRace() {
  if (!current || current.status !== "betting") throw new Error("no open race");
  current.status = "armed"; // RaceMarket bets close; pilots ready
  return current;
}

export function startRace() {
  if (!current || current.status !== "armed") throw new Error("not armed");
  current.status = "racing";
  current.startedAt = Date.now();
  // The web UI runs the 3-2-1-GO countdown; pilot WS inputs are ignored by
  // the robots until GO (web gates the joystick).
  return current;
}

export function recordFinish(winner: RobotName) {
  // Called when the finish camera (finish_line.py) reports the first tag
  // across the line. Follow with verify-photo + store-proof on the watcher,
  // then RaceMarket.settle(raceId, winnerIdx, proofHash, blobId).
  if (!current || current.status !== "racing") throw new Error("not racing");
  current.status = "finished";
  current.winner = winner;
  current.finishMs = Date.now() - (current.startedAt ?? Date.now());
  return current;
}
