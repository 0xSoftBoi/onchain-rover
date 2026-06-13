import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import type { TypedDataEnvelope } from "./chain.js";
import type { DriverSlot } from "./rounds.js";

export const LOCAL_DEV_PRIVATE_KEYS: Record<DriverSlot, Hex> = {
  challenger: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  opponent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};

const accounts: Record<DriverSlot, PrivateKeyAccount> = {
  challenger: privateKeyToAccount(LOCAL_DEV_PRIVATE_KEYS.challenger),
  opponent: privateKeyToAccount(LOCAL_DEV_PRIVATE_KEYS.opponent),
};

export function localDevWallet(slot: DriverSlot) {
  const account = accounts[slot];
  return {
    slot,
    address: account.address,
    displayName: slot,
  };
}

export function localDevWallets() {
  return {
    challenger: localDevWallet("challenger"),
    opponent: localDevWallet("opponent"),
  };
}

export async function signLocalDevRaceEntry(
  slot: DriverSlot,
  request: { entry: TypedDataEnvelope; permit: TypedDataEnvelope },
) {
  const account = accounts[slot];
  const [entrySignature, permitSignature] = await Promise.all([
    signTypedData(account, request.entry),
    signTypedData(account, request.permit),
  ]);
  return {
    entrySignature,
    permitSignature,
    entryDeadline: request.entry.message.deadline,
    permitDeadline: request.permit.message.deadline,
  };
}

function signTypedData(account: PrivateKeyAccount, data: TypedDataEnvelope) {
  return account.signTypedData({
    domain: data.domain,
    types: data.types,
    primaryType: data.primaryType,
    message: data.message,
  } as any);
}
