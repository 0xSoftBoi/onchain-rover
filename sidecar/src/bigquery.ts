import "./env.js";
/**
 * Network-wide ERC-8004 reputation leaderboard via Google BigQuery.
 *
 * Queries the public `bigquery-public-data.crypto_ethereum.logs` dataset for
 * NewFeedback events on the canonical ERC-8004 Reputation registry (mainnet),
 * ranking every on-chain agent by feedback volume. Our rover runs the same
 * ERC-8004 standard on Arc — the wall shows the live global graph it's part of.
 *
 * Auth: Application Default Credentials (gcloud auth application-default login)
 * or GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> + GCP_PROJECT.
 * Safety: partition-pruned + maximum_bytes_billed + dry-run guard (1TB/mo free).
 * Result cached 10 min (BQ is slow and metered).
 */
import { BigQuery } from "@google-cloud/bigquery";

const PROJECT = process.env.GCP_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
const REP_MAINNET = "0x8004baa17c55a88189ae136b182e5fda19de9b63"; // ERC-8004 Reputation
const NEW_FEEDBACK = "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc";
const MAX_BYTES = 5 * 1024 ** 3; // 5 GB ceiling

const SQL = `
  SELECT topics[OFFSET(1)] AS agent, COUNT(*) AS feedback
  FROM \`bigquery-public-data.crypto_ethereum.logs\`
  WHERE block_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)
    AND address = '${REP_MAINNET}'
    AND topics[OFFSET(0)] = '${NEW_FEEDBACK}'
  GROUP BY agent ORDER BY feedback DESC LIMIT 10`;

let _bq: BigQuery | null = null;
function bq(): BigQuery | null {
  if (!PROJECT && !process.env.GOOGLE_APPLICATION_CREDENTIALS) return null;
  if (!_bq) _bq = new BigQuery(PROJECT ? { projectId: PROJECT } : {});
  return _bq;
}

export function configured() { return Boolean(bq()); }

let _cache: { at: number; rows: any[]; bytes?: number } | null = null;

export async function leaderboard() {
  const client = bq();
  if (!client) return { configured: false, rows: [] as any[] };
  if (_cache && Date.now() - _cache.at < 10 * 60_000) return { configured: true, cached: true, ..._cache };
  // dry run first — refuse if the query would scan more than the ceiling
  const [dry] = await client.createQueryJob({ query: SQL, dryRun: true });
  const bytes = Number(dry.metadata.statistics?.totalBytesProcessed ?? 0);
  if (bytes > MAX_BYTES) {
    return { configured: true, error: `query would scan ${(bytes / 1e9).toFixed(1)}GB > ceiling`, rows: [] };
  }
  const [rows] = await client.query({ query: SQL, maximumBytesBilled: String(MAX_BYTES) });
  const out = (rows as any[]).map((r, i) => ({
    rank: i + 1,
    agent: String(r.agent).replace(/^0x0+/, "0x").slice(0, 12) + "…",
    feedback: Number(r.feedback),
  }));
  _cache = { at: Date.now(), rows: out, bytes };
  return { configured: true, cached: false, rows: out, bytes };
}
