import "./env.js";
/**
 * Deploy EventPass to Arc testnet with the guard wallet as minter.
 * Run once funds land:  npx tsx src/deploy-eventpass.ts
 * Prints the address — paste into .env EVENTPASS_ADDRESS.
 *
 * Uses the forge-built artifact (run `forge build` in contracts/ first), or
 * falls back to the inlined bytecode below.
 */
import { createWalletClient, createPublicClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { arcTestnet } from "./settle.js";

const guardPk = process.env.GUARD_PRIVATE_KEY as `0x${string}`;
const guard = getAddress(process.env.GUARD_WALLET!);

// forge artifact: contracts/out/EventPass.sol/EventPass.json
const artifact = JSON.parse(
  readFileSync(new URL("../../contracts/out/EventPass.sol/EventPass.json", import.meta.url), "utf8"));
const abi = artifact.abi;
const bytecode = artifact.bytecode.object as `0x${string}`;

const account = privateKeyToAccount(guardPk);
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });
const pub = createPublicClient({ chain: arcTestnet, transport: http() });

const hash = await wallet.deployContract({ abi, bytecode, args: [guard] });
console.log("deploy tx:", hash);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log("EVENTPASS_ADDRESS=" + receipt.contractAddress);
console.log("minter (guard):", guard);
