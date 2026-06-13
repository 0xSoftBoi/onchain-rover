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
