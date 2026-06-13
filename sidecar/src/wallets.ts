/**
 * Robot wallets = Privy SERVER wallets (real secp256k1 EOAs — Circle Gateway
 * requires plain EOA signatures; NEVER route through smart-wallet/4337 products).
 * Visitor/bettor wallets = Dynamic embedded (web/ side).
 */
import { PrivyClient } from "@privy-io/node";

const privy = new PrivyClient({
  appId: process.env.PRIVY_APP_ID!,
  appSecret: process.env.PRIVY_APP_SECRET!,
});

export async function createRobotWallet() {
  const wallet = await privy.wallets().create({ chain_type: "ethereum" });
  return { walletId: wallet.id, address: wallet.address };
}

export async function signTypedData(walletId: string, typedData: any) {
  // Emits standard ECDSA — Gateway/EIP-3009 compatible.
  return privy.wallets().ethereum().signTypedData(walletId, {
    params: { typed_data: typedData },
  });
}

export async function signMessage(walletId: string, message: string) {
  return privy.wallets().ethereum().signMessage(walletId, { message });
}
