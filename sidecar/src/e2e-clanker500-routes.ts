const sidecarHttp = normalizeHttpUrl(process.env.SIDECAR_URL ?? "http://127.0.0.1:4021");

const WALLETS = {
  challenger: "0x1111111111111111111111111111111111111111",
  opponent: "0x2222222222222222222222222222222222222222",
  third: "0x3333333333333333333333333333333333333333",
} as const;

async function main() {
  const config = await getJson("/clanker500/config");
  assert(config.chain.chainId === 84532, "expected Base Sepolia config");
  assert(config.chain.chainIdHex === "0x14a34", "expected Base Sepolia chain id hex");
  assert(/^\d+$/.test(config.stakeWei), "stakeWei missing");
  assert(String(config.stakeDisplay).includes("ETH"), "stake display missing");

  const stage = await getText("/clanker500.html");
  assert(stage.includes("Clanker500"), "stage page missing title");
  const joinPage = await getText("/clanker500-join.html");
  assert(joinPage.includes("Stake + Join"), "join page missing stake button");

  const created = await postJson("/clanker500/round", { open: false, durationSecs: 12, countdownSecs: 1 });
  let round = created.round;
  assert(round.stakeAsset === "native-eth", "created round is not native ETH");
  assert(round.stakeWei === config.stakeWei, "created round stakeWei mismatch");
  assert(round.status === "accepted", `expected accepted, got ${round.status}`);
  assert(round.chainStatus === "not-opened", `expected not-opened, got ${round.chainStatus}`);
  assert(round.drivers.challenger.robot === "guard", "challenger robot mismatch");
  assert(round.drivers.opponent.robot === "courier", "opponent robot mismatch");

  const active = await getJson("/clanker500/active");
  assert(active.round?.id === round.id, "active heat did not return created round");

  const challenger = await postJson(`/clanker500/round/${round.id}/claim-next-slot`, {
    wallet: WALLETS.challenger,
    displayName: "alpha",
  });
  assert(challenger.slot === "challenger", "first wallet should claim challenger");
  assert(challenger.driver.robot === "guard", "challenger should map to guard");
  assert(challenger.driver.lane === "left", "challenger should map to left lane");

  const challengerAgain = await postJson(`/clanker500/round/${round.id}/claim-next-slot`, {
    wallet: WALLETS.challenger,
    displayName: "alpha refresh",
  });
  assert(challengerAgain.slot === "challenger", "same wallet should keep challenger slot");
  assert(challengerAgain.driver.displayName === "alpha refresh", "same wallet should refresh display name");

  const opponent = await postJson(`/clanker500/round/${round.id}/claim-next-slot`, {
    wallet: WALLETS.opponent,
    displayName: "beta",
  });
  round = opponent.round;
  assert(opponent.slot === "opponent", "second wallet should claim opponent");
  assert(opponent.driver.robot === "courier", "opponent should map to courier");
  assert(opponent.driver.lane === "right", "opponent should map to right lane");

  await assertRejected(`/clanker500/round/${round.id}/lock`, {
    skipRobotAuth: true,
  }, "round is not ready");

  await assertRejected(`/clanker500/round/${round.id}/countdown`, {}, "expected locked");
  await assertRejected(`/clanker500/round/${round.id}/start`, {}, "expected countdown");
  await assertRejected(`/clanker500/round/${round.id}/settle`, {}, "round is not finished");

  await assertRejected(`/clanker500/round/${round.id}/claim-next-slot`, {
    wallet: WALLETS.third,
    displayName: "gamma",
  }, "heat is full");

  await assertRejected(`/clanker500/round/${round.id}/claim-next-slot`, {
    wallet: "not-a-wallet",
  }, "valid EVM wallet required");

  await assertRejected(`/clanker500/round/${round.id}/join-tx`, {
    wallet: WALLETS.challenger,
    slot: "challenger",
  }, "CLANKER500_FACILITATOR_PRIVATE_KEY");

  await assertRejected(`/clanker500/round/${round.id}/confirm-join`, {
    wallet: WALLETS.challenger,
    slot: "challenger",
    txHash: "not-a-tx",
  }, "invalid hex value");

  const regular = await postJson("/race/round/challenge", {
    wallet: WALLETS.third,
    displayName: "regular",
    stakeUsdc: "1.00",
    feeUsdc: "0.25",
  });
  await assertRejected(`/clanker500/round/${regular.id}/claim-next-slot`, {
    wallet: WALLETS.challenger,
  }, "not a Clanker500 round");
  await assertRejected(`/clanker500/round/${regular.id}/countdown`, {}, "not a Clanker500 round");

  const localJoined = await postJson(`/race/round/${round.id}/fee-paid`, {
    slot: "challenger",
    payment: { source: "manual", amountUsdc: "0" },
  });
  assert(localJoined.drivers.challenger.feePaid === true, "manual fee marker failed");
  await postJson(`/race/round/${round.id}/stake-authorize`, {
    slot: "challenger",
    authorization: { adapter: "native-eth-escrow", token: "ETH", amountUnits: config.stakeWei },
  });
  await postJson(`/race/round/${round.id}/fee-paid`, {
    slot: "opponent",
    payment: { source: "manual", amountUsdc: "0" },
  });
  const ready = await postJson(`/race/round/${round.id}/stake-authorize`, {
    slot: "opponent",
    authorization: { adapter: "native-eth-escrow", token: "ETH", amountUnits: config.stakeWei },
  });
  assert(ready.status === "ready", `expected ready after manual native markers, got ${ready.status}`);

  const locked = await postJson(`/clanker500/round/${round.id}/lock`, {
    skipRobotAuth: true,
  });
  assert(locked.status === "locked", `expected locked, got ${locked.status}`);

  const countdown = await postJson(`/clanker500/round/${round.id}/countdown`, {});
  assert(countdown.status === "countdown", `expected countdown, got ${countdown.status}`);

  const canceled = await postJson(`/clanker500/round/${round.id}/cancel`, {
    reason: "route test cleanup",
  });
  assert(canceled.status === "canceled", "cancel route did not cancel");
  assert(String(canceled.cancellation?.feePolicy ?? "").includes("no separate race fee"), "native fee policy missing");
  assert(String(canceled.cancellation?.stakePolicy ?? "").includes("refunded on-chain"), "native stake policy missing");

  console.log("Clanker500 route e2e passed");
  console.log(`  roundId: ${round.id}`);
  console.log(`  stake:   ${config.stakeDisplay}`);
  console.log(`  stage:   ${sidecarHttp}/clanker500.html`);
}

async function getJson(path: string) {
  const res = await fetch(`${sidecarHttp}${path}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `${path} failed ${res.status}`);
  return json;
}

async function getText(path: string) {
  const res = await fetch(`${sidecarHttp}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} failed ${res.status}`);
  return text;
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

async function assertRejected(path: string, body: Record<string, unknown>, expected: string) {
  const res = await fetch(`${sidecarHttp}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.ok || !String(json.error ?? "").includes(expected)) {
    throw new Error(`${path} should reject with ${expected}; got ${res.status} ${JSON.stringify(json)}`);
  }
}

function normalizeHttpUrl(value: string) {
  if (value.startsWith("ws://")) return value.replace(/^ws:/, "http:");
  if (value.startsWith("wss://")) return value.replace(/^wss:/, "https:");
  return value.replace(/\/$/, "");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
