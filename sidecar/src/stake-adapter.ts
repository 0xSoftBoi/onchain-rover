import {
  getAddress,
  keccak256,
  parseUnits,
  toBytes,
  toHex,
  verifyTypedData,
  type Hex,
} from "viem";

import * as chain from "./chain.js";
import type { DriverSlot, Round, StakeAuthorization } from "./rounds.js";

export type StakeAdapterKind = "base-spend-permission";

export type BaseSpendPermission = {
  account: string;
  spender: string;
  token: string;
  allowance: string;
  period: string;
  start: string;
  end: string;
  salt: string;
  extraData: Hex;
};

export type StakeTypedData = {
  domain: {
    name: "Spend Permission Manager";
    version: "1";
    chainId: number;
    verifyingContract: string;
  };
  types: {
    SpendPermission: Array<{ name: string; type: string }>;
  };
  primaryType: "SpendPermission";
  message: BaseSpendPermission;
};

export type PreparedStake = {
  adapter: StakeAdapterKind;
  roundId: string;
  slot: DriverSlot;
  wallet: string;
  token: string;
  spender: string;
  amountUsdc: string;
  amountUnits: string;
  expiresAt: number;
  permission: BaseSpendPermission;
  typedData: StakeTypedData;
};

export type VerifyStakeInput = {
  wallet?: string;
  signature?: Hex;
  permission?: Partial<BaseSpendPermission>;
  typedData?: Partial<StakeTypedData> & { message?: Partial<BaseSpendPermission> };
};

export type StakeSettlementPlan = {
  adapter: StakeAdapterKind;
  roundId: string;
  winner: DriverSlot;
  loser: DriverSlot;
  token: string;
  spender: string;
  amountUnits: string;
  charge: {
    from: string;
    amountUnits: string;
    permission: BaseSpendPermission;
    signature?: string;
  };
  payout: {
    to: string;
    amountUnits: string;
  };
  spenderExecution: {
    package: "@base-org/account/spend-permission";
    helper: "prepareSpendCallData";
    submitter: "spender";
    amountUnits: string;
    calls: ["approveWithSignature", "spend"];
  };
};

export interface StakeAdapter {
  kind: StakeAdapterKind;
  prepareStake(round: Round, slot: DriverSlot, wallet?: string): PreparedStake;
  verifyStake(round: Round, slot: DriverSlot, input: VerifyStakeInput): Promise<StakeAuthorization>;
  settle(round: Round): StakeSettlementPlan;
}

const SPEND_PERMISSION_TYPES: StakeTypedData["types"] = {
  SpendPermission: [
    { name: "account", type: "address" },
    { name: "spender", type: "address" },
    { name: "token", type: "address" },
    { name: "allowance", type: "uint160" },
    { name: "period", type: "uint48" },
    { name: "start", type: "uint48" },
    { name: "end", type: "uint48" },
    { name: "salt", type: "uint256" },
    { name: "extraData", type: "bytes" },
  ],
};

export const baseSpendPermissionStakeAdapter: StakeAdapter = {
  kind: "base-spend-permission",

  prepareStake(round, slot, wallet) {
    const driver = requireDriver(round, slot);
    const account = getAddress(wallet ?? driver.wallet);
    if (getAddress(driver.wallet) !== account) throw new Error("wallet does not match driver slot");
    const cfg = stakeConfig(round);
    const nowSecs = unixSecs();
    const ttlSecs = stakeTtlSecs(round);
    const permission = buildPermission(round, slot, account, nowSecs, nowSecs + ttlSecs, cfg);
    return {
      adapter: this.kind,
      roundId: round.id,
      slot,
      wallet: account,
      token: cfg.token,
      spender: cfg.spender,
      amountUsdc: round.stakeUsdc,
      amountUnits: cfg.amountUnits,
      expiresAt: Number(permission.end) * 1000,
      permission,
      typedData: typedData(permission, cfg),
    };
  },

  async verifyStake(round, slot, input) {
    const driver = requireDriver(round, slot);
    const account = getAddress(input.wallet ?? driver.wallet);
    if (getAddress(driver.wallet) !== account) throw new Error("wallet does not match driver slot");
    const signature = input.signature;
    if (!signature) throw new Error("stake permission signature required");

    const cfg = stakeConfig(round);
    const permission = normalizePermission(input.permission ?? input.typedData?.message);
    validatePermission(round, slot, account, permission, cfg);
    const ok = await verifyTypedData({
      address: account,
      ...typedData(permission, cfg),
      signature,
    } as any);
    if (!ok) throw new Error("stake permission signature invalid");

    const permissionHash = keccak256(toBytes(stableJson(permission)));
    return {
      adapter: this.kind,
      status: "verified",
      roundId: round.id,
      token: cfg.token,
      spender: cfg.spender,
      amountUsdc: round.stakeUsdc,
      amountUnits: cfg.amountUnits,
      permissionHash,
      permission,
      signature,
      verifiedAt: Date.now(),
      expiresAt: Number(permission.end) * 1000,
    };
  },

  settle(round) {
    if (!round.winner) throw new Error("round winner required");
    const winner = round.winner;
    const loser: DriverSlot = winner === "challenger" ? "opponent" : "challenger";
    const winnerDriver = requireDriver(round, winner);
    const loserDriver = requireDriver(round, loser);
    const auth = loserDriver.stakeAuthorization;
    if (auth?.adapter !== this.kind || auth.status !== "verified") {
      throw new Error(`${loser} stake permission is not verified`);
    }
    if (!auth.permission) throw new Error(`${loser} stake permission missing`);
    const cfg = stakeConfig(round);
    const permission = normalizePermission(auth.permission as Partial<BaseSpendPermission>);
    validatePermission(round, loser, getAddress(loserDriver.wallet), permission, cfg);
    return {
      adapter: this.kind,
      roundId: round.id,
      winner,
      loser,
      token: cfg.token,
      spender: cfg.spender,
      amountUnits: cfg.amountUnits,
      charge: {
        from: getAddress(loserDriver.wallet),
        amountUnits: cfg.amountUnits,
        permission,
        signature: auth.signature,
      },
      payout: {
        to: getAddress(winnerDriver.wallet),
        amountUnits: cfg.amountUnits,
      },
      spenderExecution: {
        package: "@base-org/account/spend-permission",
        helper: "prepareSpendCallData",
        submitter: "spender",
        amountUnits: cfg.amountUnits,
        calls: ["approveWithSignature", "spend"],
      },
    };
  },
};

export function stakeAdapter(kind?: string): StakeAdapter {
  if (!kind || kind === "base-spend-permission") return baseSpendPermissionStakeAdapter;
  throw new Error(`unsupported stake adapter: ${kind}`);
}

function typedData(permission: BaseSpendPermission, cfg: StakeConfig): StakeTypedData {
  return {
    domain: {
      name: "Spend Permission Manager",
      version: "1",
      chainId: cfg.chainId,
      verifyingContract: cfg.manager,
    },
    types: SPEND_PERMISSION_TYPES,
    primaryType: "SpendPermission",
    message: permission,
  };
}

type StakeConfig = {
  chainId: number;
  manager: string;
  token: string;
  spender: string;
  amountUnits: string;
};

function stakeConfig(round: Round): StakeConfig {
  const local = chain.localChainConfig();
  return {
    chainId: Number(process.env.STAKE_CHAIN_ID ?? process.env.BASE_SPEND_PERMISSION_CHAIN_ID ?? local.chainId),
    manager: getAddress(
      process.env.SPEND_PERMISSION_MANAGER_ADDRESS ??
      process.env.BASE_SPEND_PERMISSION_MANAGER_ADDRESS ??
      local.raceEscrow,
    ),
    token: getAddress(process.env.STAKE_TOKEN_ADDRESS ?? process.env.BASE_STAKE_TOKEN_ADDRESS ?? local.raceToken),
    spender: getAddress(
      process.env.STAKE_SPENDER_ADDRESS ??
      process.env.BASE_SPEND_PERMISSION_SPENDER ??
      local.facilitator,
    ),
    amountUnits: parseUnits(round.stakeUsdc, 6).toString(),
  };
}

function buildPermission(
  round: Round,
  slot: DriverSlot,
  account: string,
  start: number,
  end: number,
  cfg: StakeConfig,
): BaseSpendPermission {
  const amountUnits = cfg.amountUnits;
  return {
    account,
    spender: cfg.spender,
    token: cfg.token,
    allowance: amountUnits,
    period: String(end - start),
    start: String(start),
    end: String(end),
    salt: BigInt(keccak256(toBytes(`${round.id}:${slot}:${account}:${amountUnits}`))).toString(),
    extraData: stakeExtraData(round.id, slot, amountUnits),
  };
}

function validatePermission(
  round: Round,
  slot: DriverSlot,
  account: string,
  permission: BaseSpendPermission,
  cfg: StakeConfig,
) {
  if (getAddress(permission.account) !== account) throw new Error("stake permission account mismatch");
  if (getAddress(permission.spender) !== getAddress(cfg.spender)) throw new Error("stake permission spender mismatch");
  if (getAddress(permission.token) !== getAddress(cfg.token)) throw new Error("stake permission token mismatch");
  if (BigInt(permission.allowance) !== BigInt(cfg.amountUnits)) {
    throw new Error("stake permission allowance must equal matched stake");
  }
  if (permission.extraData !== stakeExtraData(round.id, slot, cfg.amountUnits)) {
    throw new Error("stake permission round scope mismatch");
  }
  const now = BigInt(unixSecs());
  const start = BigInt(permission.start);
  const end = BigInt(permission.end);
  if (end <= now) throw new Error("stake permission expired");
  if (start > now + 300n) throw new Error("stake permission is not active yet");
  if (BigInt(permission.period) !== end - start) {
    throw new Error("stake permission period must match validity window");
  }
}

function normalizePermission(value?: Partial<BaseSpendPermission>): BaseSpendPermission {
  if (!value) throw new Error("stake permission required");
  return {
    account: getAddress(requiredString(value.account, "permission.account")),
    spender: getAddress(requiredString(value.spender, "permission.spender")),
    token: getAddress(requiredString(value.token, "permission.token")),
    allowance: uintString(value.allowance, "permission.allowance"),
    period: uintString(value.period, "permission.period"),
    start: uintString(value.start, "permission.start"),
    end: uintString(value.end, "permission.end"),
    salt: uintString(value.salt, "permission.salt"),
    extraData: hexString(value.extraData, "permission.extraData"),
  };
}

function stakeTtlSecs(round: Round): number {
  const fallback = Math.max(600, round.durationSecs + round.countdownSecs + 300);
  const raw = Number(process.env.STAKE_PERMISSION_TTL_SECS ?? fallback);
  return Number.isFinite(raw) ? Math.max(60, Math.floor(raw)) : fallback;
}

function stakeExtraData(roundId: string, slot: DriverSlot, amountUnits: string): Hex {
  return toHex(stableJson({
    schema: "onchain-rover.race-stake.v1",
    roundId,
    slot,
    amountUnits,
  }));
}

function requireDriver(round: Round, slot: DriverSlot) {
  const driver = round.drivers[slot];
  if (!driver?.wallet) throw new Error(`missing ${slot}`);
  return driver;
}

function unixSecs() {
  return Math.floor(Date.now() / 1000);
}

function stableJson(value: Record<string, unknown>) {
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function uintString(value: unknown, name: string) {
  const raw = requiredString(value, name);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an unsigned integer string`);
  return raw;
}

function hexString(value: unknown, name: string): Hex {
  const raw = requiredString(value, name);
  if (!/^0x([a-fA-F0-9]{2})*$/.test(raw)) throw new Error(`${name} must be hex bytes`);
  return raw as Hex;
}
