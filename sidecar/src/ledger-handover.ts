import "./env.js";
/**
 * Hand the fleet treasury over to the physical Ledger:
 *  1. fund the Ledger address with a little USDC for gas on Arc
 *  2. Treasury.setOwner(ledger) from the current owner (guard)
 * After this, withdraw() clear-signed on the device will broadcast successfully.
 *   npx tsx src/ledger-handover.ts 0x<ledger-address>
 */
import { createWalletClient, createPublicClient, http, getAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "./settle.js";

const LEDGER = getAddress(process.argv[2] || process.env.LEDGER_ADDRESS!);
const TREASURY = getAddress(process.env.TREASURY_CONTRACT!);
const GAS_AMOUNT = "0.5"; // USDC-as-gas to seed the device so it can broadcast

const guard = privateKeyToAccount(process.env.GUARD_PRIVATE_KEY as `0x${string}`);
const wallet = createWalletClient({ account: guard, chain: arcTestnet, transport: http() });
const pub = createPublicClient({ chain: arcTestnet, transport: http() });

const setOwnerAbi = [{
  name: "setOwner", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "newOwner", type: "address" }], outputs: [],
}] as const;

console.log(`Ledger:   ${LEDGER}`);
console.log(`Treasury: ${TREASURY}`);

// 1. fund gas (native USDC value transfer)
const fundTx = await wallet.sendTransaction({ to: LEDGER, value: parseEther(GAS_AMOUNT) });
await pub.waitForTransactionReceipt({ hash: fundTx });
console.log(`✅ funded ${GAS_AMOUNT} USDC gas → device: ${fundTx}`);

// 2. transfer treasury ownership to the Ledger
const ownTx = await wallet.writeContract({
  address: TREASURY, abi: setOwnerAbi, functionName: "setOwner", args: [LEDGER],
});
await pub.waitForTransactionReceipt({ hash: ownTx });
console.log(`✅ Treasury owner → Ledger: ${ownTx}`);
console.log("\nDone. Reload ledger.html, connect, and Withdraw — it will broadcast from your device.");
