import { WebSocket } from "ws";

const sidecarHttp = normalizeHttpUrl(process.env.SIDECAR_URL ?? "http://127.0.0.1:4021");

async function main() {
  const chain = await getJson("/chain/health");
  if (!chain.ok) throw new Error("local chain is not healthy");

  let round = await postJson("/race/round/challenge", {
    stakeUsdc: "1.00",
    feeUsdc: "0.25",
    durationSecs: 10,
    countdownSecs: 1,
  });

  const prepared = await postJson(`/race/round/${round.id}/dev/join-local-wallets`, {
    amount: "20",
    lockChain: true,
  });
  round = prepared.round;
  assert(round.chainRaceId, "expected chain race id");
  assert(round.chainStatus === "locked", `expected locked chain status, got ${round.chainStatus}`);
  assert(round.status === "ready", `expected ready local status, got ${round.status}`);
  assert(round.drivers.challenger?.chainJoined, "challenger did not join on-chain");
  assert(round.drivers.opponent?.chainJoined, "opponent did not join on-chain");

  round = await postJson(`/race/round/${round.id}/lock`, { skipRobotAuth: true });
  round = await postJson(`/race/round/${round.id}/countdown`);
  const preGoPilot = await postJson(`/race/round/${round.id}/pilot/session`, {
    slot: "challenger",
    speed_mode: "high",
  });
  assert(preGoPilot.round?.status === "countdown", "pilot session should include countdown round state");
  assert(preGoPilot.round?.roundStartsAt, "pilot session should include shared start time");
  await assertPreGoDriveRejected(preGoPilot.driveWs, preGoPilot.token);
  await sleep(Math.max(0, (round.roundStartsAt ?? Date.now()) - Date.now()) + 100);
  round = await postJson(`/race/round/${round.id}/start`);

  const challengerPilot = await postJson(`/race/round/${round.id}/pilot/session`, {
    slot: "challenger",
    speed_mode: "high",
  });
  const opponentPilot = await postJson(`/race/round/${round.id}/pilot/session`, {
    slot: "opponent",
    speed_mode: "medium",
  });
  assert(challengerPilot.driveWs && challengerPilot.token, "challenger pilot session missing");
  assert(opponentPilot.driveWs && opponentPilot.token, "opponent pilot session missing");

  round = await postJson(`/race/round/${round.id}/finish`, {
    winner: "challenger",
    proof: { source: "e2e-dev-join" },
  });
  assert(round.status === "finished", `expected finished round, got ${round.status}`);
  await assertDriveRejectedAfterFinish(challengerPilot.driveWs);

  const evidence = await getJson(`/race/round/${round.id}/evidence`);
  const lifecycle = evidence.evidence?.lifecycle ?? [];
  assert(lifecycle.some((event: { event?: string }) => event.event === "started"), "started evidence missing");

  console.log("Local dev wallet rehearsal e2e passed");
  console.log(`  roundId:     ${round.id}`);
  console.log(`  chainRaceId: ${round.chainRaceId}`);
  console.log(`  chainStatus: ${round.chainStatus}`);
  console.log(`  pilot guard: ${challengerPilot.robot}`);
  console.log(`  pilot other: ${opponentPilot.robot}`);
}

async function getJson(path: string) {
  const res = await fetch(`${sidecarHttp}${path}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `${path} failed ${res.status}`);
  return json;
}

async function postJson(path: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${sidecarHttp}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `${path} failed ${res.status}`);
  return json;
}

function normalizeHttpUrl(value: string) {
  if (value.startsWith("ws://")) return value.replace(/^ws:/, "http:");
  if (value.startsWith("wss://")) return value.replace(/^wss:/, "https:");
  return value.replace(/\/$/, "");
}

function rebaseWsUrl(value: string) {
  const target = new URL(value);
  const sidecar = new URL(sidecarHttp);
  target.protocol = sidecar.protocol === "https:" ? "wss:" : "ws:";
  target.hostname = sidecar.hostname;
  target.port = sidecar.port;
  return target.toString();
}

async function assertPreGoDriveRejected(value: string, token: string) {
  const ws = new WebSocket(rebaseWsUrl(value));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const error = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("pre-GO drive command was not rejected")), 2000);
    ws.on("message", (raw) => {
      const body = JSON.parse(String(raw));
      if (body?.error) {
        clearTimeout(timeout);
        resolve(body);
      }
    });
  });
  ws.send(JSON.stringify({ token, left: 1, right: 1, speed_mode: "high", t: Date.now() }));
  const body = await error;
  ws.close();
  assert(body.error === "round has not started", `unexpected pre-GO response: ${String(body.error)}`);
}

async function assertDriveRejectedAfterFinish(value: string) {
  const ws = new WebSocket(rebaseWsUrl(value));
  const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("finished round drive socket stayed open")), 2000);
    ws.once("close", (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
    ws.once("error", reject);
  });
  const result = await closed;
  assert(result.code === 1008, `unexpected finished-round close code ${result.code}: ${result.reason}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
