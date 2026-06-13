/**
 * ERC-8004 on Sepolia — register agents + giveFeedback (ABI byte-verified).
 * 🚨 agentIds start at 0. 🚨 Caller of giveFeedback must NOT be the agent
 * owner ("Self-feedback not allowed") — the REQUESTER wallet rates the robot.
 */
import {
  createPublicClient, createWalletClient, http, parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const abi = parseAbi([
  "function register(string agentURI) returns (uint256)",
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

import { ERC8004 } from "./config.js";

const pub = createPublicClient({ chain: sepolia, transport: http() });
// Requester key (rates the robots) — separate from robot wallets by design.
const requester = privateKeyToAccount(
  process.env.REQUESTER_PRIVATE_KEY! as `0x${string}`);
const wallet = createWalletClient({
  account: requester, chain: sepolia, transport: http(),
});

export async function registerAgent(agentURI: string, ownerKey: `0x${string}`) {
  const owner = privateKeyToAccount(ownerKey);
  const w = createWalletClient({ account: owner, chain: sepolia, transport: http() });
  const hash = await w.writeContract({
    address: ERC8004.identity as `0x${string}`, abi,
    functionName: "register", args: [agentURI],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const log = receipt.logs.find((l) => l.topics[0] === ERC8004.topicRegistered);
  const agentId = log ? BigInt(log.topics[1]!).toString() : null;
  return { tx: hash, agentId };
}

export async function giveFeedback(opts: {
  agentId: bigint; score: number; skill: string; blobId: string; sha256: string;
}) {
  const hash = await wallet.writeContract({
    address: ERC8004.reputation as `0x${string}`, abi,
    functionName: "giveFeedback",
    args: [
      opts.agentId,
      BigInt(opts.score),          // value (0-100, "starred" convention)
      0,                            // valueDecimals
      opts.skill,                   // tag1 = skill ("guard"/"deliver"/"race")
      "starred",                    // tag2
      "",                           // endpoint
      `walrus://${opts.blobId}`,    // feedbackURI -> the proof blob
      `0x${opts.sha256}` as `0x${string}`, // feedbackHash = photo sha256 (32B)
    ],
  });
  await pub.waitForTransactionReceipt({ hash });
  return { tx: hash };
}
