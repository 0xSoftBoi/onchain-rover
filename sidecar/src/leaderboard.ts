/**
 * Fleet leaderboard — BigQuery over ERC-8004 NewFeedback events (Google track).
 * 🚨 Always partition-prune + cap bytes billed (logs table is multi-TB).
 * Auth: `gcloud auth application-default login` (no API key).
 * Mainnet registry for the public index; our live demo events land on Sepolia,
 * so the API merges BigQuery (mainnet ecosystem) + direct RPC logs (our fleet).
 */
import { BigQuery } from "@google-cloud/bigquery";
import { createPublicClient, http, parseAbiItem } from "viem";
import { sepolia } from "viem/chains";
import { ERC8004 } from "./config.js";

// Auth via ADC (GOOGLE_APPLICATION_CREDENTIALS = booth service-account JSON).
// projectId = the billing project for querying the public ERC-8004 dataset.
const bq = new BigQuery(process.env.GCP_PROJECT ? { projectId: process.env.GCP_PROJECT } : {});

const MAINNET_REPUTATION = "0x8004baa17c55a88189ae136b182e5fda19de9b63"; // lowercase

export async function mainnetRanking(limit = 20) {
  const query = `
    SELECT
      topics[OFFSET(1)] AS agent_id,
      COUNT(*) AS feedback_count,
      COUNT(DISTINCT topics[OFFSET(2)]) AS unique_reviewers
    FROM \`bigquery-public-data.crypto_ethereum.logs\`
    WHERE DATE(block_timestamp) >= '2026-01-29'
      AND address = '${MAINNET_REPUTATION}'
      AND topics[OFFSET(0)] = '${ERC8004.topicNewFeedback}'
    GROUP BY agent_id
    ORDER BY unique_reviewers DESC, feedback_count DESC
    LIMIT ${limit}`;
  const [job] = await bq.createQueryJob({
    query, maximumBytesBilled: String(50 * 1024 ** 3), // 50 GB cap
  });
  const [rows] = await job.getQueryResults();
  return rows;
}

const pub = createPublicClient({ chain: sepolia, transport: http() });
const newFeedback = parseAbiItem(
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)");

export async function fleetFeedback(agentIds: bigint[]) {
  const logs = await pub.getLogs({
    address: ERC8004.reputation as `0x${string}`,
    event: newFeedback,
    // public RPCs reject huge ranges — set to ~the block we register at tonight
    fromBlock: BigInt(process.env.FLEET_FROM_BLOCK ?? "0"),
  });
  return agentIds.map((id) => {
    const mine = logs.filter((l) => l.args.agentId === id);
    const avg = mine.length
      ? Number(mine.reduce((s, l) => s + Number(l.args.value ?? 0n), 0)) / mine.length
      : null;
    return {
      agentId: id.toString(),
      jobs: mine.length,
      avgScore: avg,
      skills: [...new Set(mine.map((l) => l.args.tag1))],
    };
  });
}
