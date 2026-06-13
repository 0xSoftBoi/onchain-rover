import "./env.js";
/**
 * Reads the decentralized-verification result that the Chainlink CRE workflow
 * wrote on-chain (AttestationConsumer on Sepolia) so the wall can show the DON's
 * consensus verdict + the writeReport tx. No-ops cleanly until the consumer is
 * deployed (ATTESTATION_CONSUMER set).
 */
import { createPublicClient, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";

const CONSUMER = process.env.ATTESTATION_CONSUMER as `0x${string}` | undefined;
const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const JOB = process.env.CRE_JOB ?? "demo-1";
const EXPLORER = "https://sepolia.etherscan.io";

const abi = parseAbi([
  "function getAttestation(string job) view returns (uint256 score, bytes32 proofHash, uint64 timestamp, bool verified, bool exists)",
  "event AttestationVerified(string job, uint256 score, bytes32 proofHash, bool verified, uint64 timestamp)",
]);

const pub = CONSUMER ? createPublicClient({ chain: sepolia, transport: http(RPC) }) : null;

export function config() {
  return {
    configured: Boolean(CONSUMER), consumer: CONSUMER ?? null, job: JOB,
    chainSelector: "16015286601757825753", chain: "ethereum-sepolia",
    explorer: EXPLORER, threshold: 70,
  };
}

export async function latest() {
  if (!pub || !CONSUMER) return { configured: false, job: JOB };
  try {
    const a = await pub.readContract({
      address: CONSUMER, abi, functionName: "getAttestation", args: [JOB],
    }) as readonly [bigint, `0x${string}`, bigint, boolean, boolean];
    const [score, proofHash, timestamp, verified, exists] = a;
    // find the writeReport tx that set it (latest matching event)
    let tx: string | null = null;
    try {
      const head = await pub.getBlockNumber();
      const logs = await pub.getLogs({
        address: CONSUMER, abi, eventName: "AttestationVerified",
        fromBlock: head - 9000n > 0n ? head - 9000n : 0n, toBlock: "latest",
      });
      tx = logs.length ? logs[logs.length - 1].transactionHash : null;
    } catch { /* log window may be limited on public RPC */ }
    return {
      configured: true, job: JOB, exists,
      score: Number(score), verified,
      proofHash, timestamp: Number(timestamp),
      tx, explorer: EXPLORER, consumer: CONSUMER,
    };
  } catch (e: any) {
    return { configured: true, job: JOB, error: e.message };
  }
}
