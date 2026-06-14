import "./env.js";
/**
 * Deploy ReputationRegistry (ERC-8004) to Arc testnet. No constructor args.
 * Run once funds land:  npx tsx src/deploy-reputation.ts
 * Prints the address — paste into .env REPUTATION_ADDRESS.
 */
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { arcTestnet } from "./settle.js";

const guardPk = process.env.GUARD_PRIVATE_KEY as `0x${string}`;
const artifact = JSON.parse(
  readFileSync(new URL("../../out/ReputationRegistry.sol/ReputationRegistry.json", import.meta.url), "utf8"));
const abi = artifact.abi;
const bytecode = artifact.bytecode.object as `0x${string}`;

const account = privateKeyToAccount(guardPk);
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });
const pub = createPublicClient({ chain: arcTestnet, transport: http() });

const hash = await wallet.deployContract({ abi, bytecode });
console.log("deploy tx:", hash);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log("REPUTATION_ADDRESS=" + receipt.contractAddress);
