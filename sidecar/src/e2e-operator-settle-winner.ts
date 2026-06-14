import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

type DriverSlot = "challenger" | "opponent";

type TypedDataEnvelope = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

const LOCAL_KEYS = {
  challenger: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  opponent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;

const accounts = {
  challenger: privateKeyToAccount(LOCAL_KEYS.challenger),
  opponent: privateKeyToAccount(LOCAL_KEYS.opponent),
} as const;

const sidecarHttp = normalizeHttpUrl(process.env.SIDECAR_URL ?? "http://127.0.0.1:4021");

async function main() {
  const chain = await getJson("/chain/health");
  if (!chain.ok) throw new Error("local chain is not healthy");

  let round = await postJson("/race/round/challenge", {
    wallet: accounts.challenger.address,
    displayName: "challenger",
    stakeUsdc: "1.00",
    feeUsdc: "0.25",
    durationSecs: 5,
    countdownSecs: 1,
  });
  round = await postJson(`/race/round/${round.id}/accept`, {
    wallet: accounts.opponent.address,
    displayName: "opponent",
  });
  round = await markX402FeePaid(round.id, "challenger", accounts.challenger.address);
  round = await markX402FeePaid(round.id, "opponent", accounts.opponent.address);
  round = await postJson(`/race/round/${round.id}/chain/open`);

  await postJson("/chain/faucet", { wallet: accounts.challenger.address, amount: "20" });
  await postJson("/chain/faucet", { wallet: accounts.opponent.address, amount: "20" });

  round = await joinDriver(round.id, "challenger", accounts.challenger);
  assert(round.drivers.challenger.feePayment.source === "x402", "challenger x402 receipt was overwritten");
  round = await joinDriver(round.id, "opponent", accounts.opponent);
  assert(round.drivers.opponent.feePayment.source === "x402", "opponent x402 receipt was overwritten");
  assert(round.status === "ready", `expected ready after chain joins, got ${round.status}`);

  round = await postJson(`/race/round/${round.id}/chain/lock`);
  round = await postJson(`/race/round/${round.id}/lock`, { skipRobotAuth: true });
  round = await postJson(`/race/round/${round.id}/countdown`);
  await sleep(Math.max(0, (round.roundStartsAt ?? Date.now()) - Date.now()) + 100);
  round = await postJson(`/race/round/${round.id}/start`);
  round = await postJson(`/race/round/${round.id}/chain/start`);
  assert(round.status === "racing", `expected racing, got ${round.status}`);
  assert(round.chainStatus === "started", `expected chain started, got ${round.chainStatus}`);

  const preflight = await getJson(`/race/round/${round.id}/operator/settlement-preflight?winner=challenger`);
  assert(preflight.canSettle === true, `preflight blocked: ${(preflight.blockers ?? []).join("; ")}`);

  const result = await postJson(`/race/round/${round.id}/operator/settle-winner`, {
    winner: "challenger",
    proof: { source: "e2e-operator-settle-winner" },
  });
  round = result.round;
  assert(round.status === "settled", `expected settled round, got ${round.status}`);
  assert(round.chainStatus === "settled", `expected settled chain, got ${round.chainStatus}`);
  assert(round.winner === "challenger", `expected challenger winner, got ${round.winner}`);
  assert(round.txHashes.finish, "finish tx missing");
  assert(round.txHashes.settle, "settle tx missing");
  assert(result.proofHash, "proof hash missing");
  assert(result.evidenceHash, "evidence hash missing");

  const retry = await postJson(`/race/round/${round.id}/operator/settle-winner`, {
    winner: "challenger",
    proof: { source: "e2e-operator-settle-winner-retry" },
  });
  assert(retry.round.status === "settled", "retry did not keep settled status");
  assert(retry.actions.some((action: { type?: string }) => action.type === "skip-settle"), "retry did not report idempotent skip");

  await assertRejected(`/race/round/${round.id}/operator/settle-winner`, {
    winner: "opponent",
    proof: { source: "e2e-operator-settle-winner-rewrite" },
  }, "already finished with challenger");

  console.log("Operator winner settlement e2e passed");
  console.log(`  roundId:      ${round.id}`);
  console.log(`  winner:       ${round.winner}`);
  console.log(`  status:       ${round.status}/${round.chainStatus}`);
  console.log(`  finish tx:    ${round.txHashes.finish}`);
  console.log(`  settle tx:    ${round.txHashes.settle}`);
  console.log(`  proofHash:    ${result.proofHash}`);
  console.log(`  evidenceHash: ${result.evidenceHash}`);
}

async function markX402FeePaid(roundId: string, slot: DriverSlot, wallet: string) {
  return postJson(`/race/round/${roundId}/fee-paid`, {
    slot,
    payment: {
      source: "x402",
      status: "paid",
      amountUsdc: "0.25",
      paymentId: `e2e-${roundId}-${slot}`,
      payer: wallet,
      reconciliationStatus: "reconciled",
    },
  });
}

async function joinDriver(roundId: string, slot: DriverSlot, account: PrivateKeyAccount) {
  const request = await postJson(`/race/round/${roundId}/chain/authorization-request`, {
    slot,
    wallet: account.address,
  }) as { entry: TypedDataEnvelope; permit: TypedDataEnvelope };
  const entrySignature = await signTypedData(account, request.entry);
  const permitSignature = await signTypedData(account, request.permit);
  return postJson(`/race/round/${roundId}/chain/join`, {
    slot,
    entrySignature,
    permitSignature,
    entryDeadline: request.entry.message.deadline,
    permitDeadline: request.permit.message.deadline,
  });
}

async function signTypedData(account: PrivateKeyAccount, data: TypedDataEnvelope) {
  return account.signTypedData({
    domain: data.domain,
    types: data.types,
    primaryType: data.primaryType,
    message: data.message,
  } as any);
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

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHttpUrl(value: string) {
  if (value.startsWith("ws://")) return value.replace(/^ws:/, "http:");
  if (value.startsWith("wss://")) return value.replace(/^wss:/, "https:");
  return value.replace(/\/$/, "");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
