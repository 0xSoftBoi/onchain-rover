import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

type DriverSlot = "challenger" | "opponent";

type PreparedStake = {
  amountUnits: string;
  permission: Record<string, string>;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  };
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
  const otherRound = await postJson("/race/round/challenge", {
    wallet: accounts.challenger.address,
    displayName: "challenger",
    stakeUsdc: "1.00",
    feeUsdc: "0.25",
  });
  await postJson(`/race/round/${otherRound.id}/accept`, {
    wallet: accounts.opponent.address,
    displayName: "opponent",
  });

  const prepared = await prepareStake(round.id, "challenger", accounts.challenger);
  await assertRejected(`/race/round/${otherRound.id}/stake/verify`, {
    slot: "challenger",
    wallet: accounts.challenger.address,
    permission: prepared.permission,
    signature: await signPrepared(accounts.challenger, prepared),
  }, "round scope mismatch");
  await assertRejectedTamper(round.id, "challenger", accounts.challenger, prepared, {
    token: "0x0000000000000000000000000000000000000001",
  }, "token mismatch");
  await assertRejectedTamper(round.id, "challenger", accounts.challenger, prepared, {
    spender: "0x0000000000000000000000000000000000000002",
  }, "spender mismatch");
  await assertRejectedTamper(round.id, "challenger", accounts.challenger, prepared, {
    allowance: String(BigInt(prepared.permission.allowance) + 1n),
  }, "allowance");
  const start = Math.floor(Date.now() / 1000) - 100;
  await assertRejectedTamper(round.id, "challenger", accounts.challenger, prepared, {
    start: String(start),
    end: String(start + 10),
    period: "10",
  }, "expired");

  round = await postJson(`/race/round/${round.id}/fee-paid`, {
    slot: "challenger",
    payment: { source: "manual", amountUsdc: "0.25" },
  });
  round = await postJson(`/race/round/${round.id}/fee-paid`, {
    slot: "opponent",
    payment: { source: "manual", amountUsdc: "0.25" },
  });
  round = await verifyStake(round.id, "challenger", accounts.challenger);
  round = await verifyStake(round.id, "opponent", accounts.opponent);
  assert(round.status === "ready", `expected ready round, got ${round.status}`);
  assert(round.drivers.challenger.stakeAuthorization.adapter === "base-spend-permission", "missing challenger adapter");
  assert(round.drivers.opponent.stakeAuthorization.amountUnits === round.drivers.challenger.stakeAuthorization.amountUnits, "stake amount mismatch");

  round = await postJson(`/race/round/${round.id}/lock`, { skipRobotAuth: true });
  round = await postJson(`/race/round/${round.id}/countdown`);
  await sleep(Math.max(0, (round.roundStartsAt ?? Date.now()) - Date.now()) + 100);
  round = await postJson(`/race/round/${round.id}/start`);
  round = await postJson(`/race/round/${round.id}/finish`, {
    winner: "challenger",
    proof: { source: "e2e-stake-adapter" },
  });
  const plan = await getJson(`/race/round/${round.id}/stake/settlement-plan`);
  assert(plan.winner === "challenger", "settlement winner mismatch");
  assert(plan.loser === "opponent", "settlement loser mismatch");
  assert(plan.charge.from.toLowerCase() === accounts.opponent.address.toLowerCase(), "settlement charges wrong driver");
  assert(plan.payout.to.toLowerCase() === accounts.challenger.address.toLowerCase(), "settlement pays wrong driver");
  assert(plan.charge.amountUnits === plan.payout.amountUnits, "settlement amount mismatch");
  assert(plan.spenderExecution.helper === "prepareSpendCallData", "settlement execution helper mismatch");

  console.log("Stake adapter e2e passed");
  console.log(`  roundId: ${round.id}`);
  console.log(`  adapter: ${plan.adapter}`);
  console.log(`  loser:   ${plan.loser}`);
  console.log(`  amount:  ${plan.amountUnits}`);
}

async function prepareStake(roundId: string, slot: DriverSlot, account: PrivateKeyAccount) {
  return postJson(`/race/round/${roundId}/stake/prepare`, {
    slot,
    wallet: account.address,
  }) as Promise<PreparedStake>;
}

async function verifyStake(roundId: string, slot: DriverSlot, account: PrivateKeyAccount) {
  const prepared = await prepareStake(roundId, slot, account);
  const signature = await signPrepared(account, prepared);
  return postJson(`/race/round/${roundId}/stake/verify`, {
    slot,
    wallet: account.address,
    permission: prepared.permission,
    signature,
  });
}

async function signPrepared(account: PrivateKeyAccount, prepared: PreparedStake) {
  return account.signTypedData({
    domain: prepared.typedData.domain,
    types: prepared.typedData.types,
    primaryType: prepared.typedData.primaryType,
    message: prepared.typedData.message,
  } as any);
}

async function assertRejectedTamper(
  roundId: string,
  slot: DriverSlot,
  account: PrivateKeyAccount,
  prepared: PreparedStake,
  tamper: Record<string, string>,
  expected: string,
) {
  const permission = { ...prepared.permission, ...tamper };
  await assertRejected(`/race/round/${roundId}/stake/verify`, {
    slot,
    wallet: account.address,
    permission,
    signature: await signPrepared(account, {
      ...prepared,
      typedData: { ...prepared.typedData, message: permission },
      permission,
    }),
  }, expected);
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
