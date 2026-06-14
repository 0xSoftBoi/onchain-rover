import "./env.js";
/**
 * Deploy the fleet Treasury to Arc and seed it with real USDC so the
 * /ledger.html clear-sign withdrawal demo has a live balance.
 *   npx tsx src/deploy-treasury.ts
 * owner = LEDGER_ADDRESS if set, else the guard wallet (transfer to the Ledger
 * later with setOwner once you connect the device).
 */
import { createWalletClient, createPublicClient, http, getAddress, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { arcTestnet } from "./settle.js";

const USDC = "0x3600000000000000000000000000000000000000";
const SEED = "5"; // USDC to seed into the treasury contract

const guardPk = process.env.GUARD_PRIVATE_KEY as `0x${string}`;
const treasuryPk = process.env.TREASURY_PRIVATE_KEY as `0x${string}`;
const owner = getAddress(process.env.LEDGER_ADDRESS || process.env.GUARD_WALLET!);

const art = JSON.parse(readFileSync(
  new URL("../../out/Treasury.sol/Treasury.json", import.meta.url), "utf8"));
const pub = createPublicClient({ chain: arcTestnet, transport: http() });

// 1. deploy (guard pays gas)
const gAcct = privateKeyToAccount(guardPk);
const gWallet = createWalletClient({ account: gAcct, chain: arcTestnet, transport: http() });
const hash = await gWallet.deployContract({
  abi: art.abi, bytecode: art.bytecode.object as `0x${string}`, args: [USDC, owner],
});
console.log("deploy tx:", hash);
const receipt = await pub.waitForTransactionReceipt({ hash });
const treasury = receipt.contractAddress!;
console.log("TREASURY_CONTRACT=" + treasury);
console.log("owner:", owner, process.env.LEDGER_ADDRESS ? "(Ledger)" : "(guard — setOwner to Ledger later)");

// 2. seed it with real USDC from the treasury EOA (ERC-20 transfer)
const erc20 = [{
  name: "transfer", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;
const tAcct = privateKeyToAccount(treasuryPk);
const tWallet = createWalletClient({ account: tAcct, chain: arcTestnet, transport: http() });
const tx2 = await tWallet.writeContract({
  address: USDC, abi: erc20, functionName: "transfer",
  args: [getAddress(treasury), parseUnits(SEED, 6)],
});
await pub.waitForTransactionReceipt({ hash: tx2 });
console.log(`seeded ${SEED} USDC into treasury: ${tx2}`);
