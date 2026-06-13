import "./env.js";
/**
 * Deploy AttestationConsumer to Sepolia (the chain the CRE workflow writes to).
 *   npx tsx src/deploy-consumer.ts
 * Needs Sepolia ETH on ENS_OWNER_KEY (get it at faucets.chain.link).
 * Prints the address — paste into cre-workflow/config.json consumerAddress.
 * forwarder = 0 (unrestricted) so `cre workflow simulate --broadcast` can write
 * during the demo; lock it to the real forwarder with setForwarder() for prod.
 */
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { readFileSync } from "node:fs";

const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const pk = process.env.ENS_OWNER_KEY as `0x${string}`;
const art = JSON.parse(readFileSync(
  new URL("../../out/AttestationConsumer.sol/AttestationConsumer.json", import.meta.url), "utf8"));

const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });

const bal = await pub.getBalance({ address: account.address });
console.log(`deployer ${account.address}  balance ${Number(bal) / 1e18} ETH`);
if (bal === 0n) { console.error("✋ fund ENS_OWNER_KEY with Sepolia ETH (faucets.chain.link)"); process.exit(1); }

const hash = await wallet.deployContract({
  abi: art.abi, bytecode: art.bytecode.object as `0x${string}`,
  args: ["0x0000000000000000000000000000000000000000"], // forwarder = unrestricted (demo)
});
console.log("deploy tx:", hash);
const r = await pub.waitForTransactionReceipt({ hash });
console.log("ATTESTATION_CONSUMER=" + r.contractAddress);
console.log("→ paste into cre-workflow/config.json consumerAddress");
