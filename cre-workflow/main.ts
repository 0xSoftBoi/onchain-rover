/**
 * The Onchain Rover — decentralized work verification (Chainlink CRE).
 *
 * Each node in the DON independently calls the robot's GET /attest, parses the
 * verification score (0-100, Gemini verdict confidence on the Walrus-anchored
 * proof), and the runtime reaches MEDIAN CONSENSUS across nodes. The agreed
 * score + proof hash are encoded into an EVM report and written on-chain via
 * writeReport() to AttestationConsumer on Sepolia. The robot's self-claim never
 * settles anything — this consensus verdict gates the EventPass mint / x402
 * payment release / ERC-8004 reputation downstream.
 *
 * Drop-in workflow for a `cre init` (TypeScript) project. Config is read from
 * config.json (see this directory). Re-check SDK signatures against the
 * installed @chainlink/cre-sdk version — the CRE API moves between releases.
 */
import {
  cre,
  type Runtime,
  type NodeRuntime,
  HTTPSendRequester,
  consensusMedianAggregation,
  hexToBase64,
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, keccak256, toHex } from "viem";

type Config = {
  apiUrl: string;          // robot /attest endpoint, e.g. http://<robot>:8000/attest?job=demo
  job: string;             // job id this run verifies
  consumerAddress: `0x${string}`;
  chainSelector: string;   // Sepolia selector
  gasLimit: string;
};

type Attestation = {
  job: string; agent: string; score: number; verified: boolean;
  blobId: string; sha256: string; verdict: string; ts: number;
};

/** Runs on EACH node: fetch the robot's attestation, return the score as the
 *  consensus value. consensusMedianAggregation() makes the DON agree on it. */
const fetchScore = (nodeRuntime: NodeRuntime<Config>): bigint => {
  const http = new HTTPSendRequester(nodeRuntime);
  const resp = http.sendRequest({ url: nodeRuntime.config.apiUrl, method: "GET" }).result();
  const att = JSON.parse(new TextDecoder().decode(resp.body)) as Attestation;
  return BigInt(Math.max(0, Math.min(100, Math.round(att.score))));
};

/** Runs once: also grab the proof hash (single-node read is fine for metadata). */
const fetchProofHash = (nodeRuntime: NodeRuntime<Config>): `0x${string}` => {
  const http = new HTTPSendRequester(nodeRuntime);
  const resp = http.sendRequest({ url: nodeRuntime.config.apiUrl, method: "GET" }).result();
  const att = JSON.parse(new TextDecoder().decode(resp.body)) as Attestation;
  return att.sha256 ? (`0x${att.sha256}` as `0x${string}`) : ("0x" + "0".repeat(64) as `0x${string}`);
};

const onTrigger = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config;

  // 1. DON consensus on the verification score
  const score = runtime
    .runInNodeMode(fetchScore, consensusMedianAggregation())()
    .result();
  // proof hash (metadata; identical across nodes for the same job)
  const proofHash = runtime
    .runInNodeMode(fetchProofHash, consensusMedianAggregation())()
    .result?.() ?? fetchProofHash(runtime as unknown as NodeRuntime<Config>);

  runtime.log(`DON consensus score for job ${cfg.job}: ${score}/100`);

  // 2. encode the report: abi.encode(string job, uint256 score, bytes32 proofHash)
  const reportData = encodeAbiParameters(
    [{ type: "string" }, { type: "uint256" }, { type: "bytes32" }],
    [cfg.job, score, proofHash],
  );

  // 3. sign the report (DON ECDSA) and write it on-chain
  const report = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  const evm = new cre.EVMClient(cfg.chainSelector);
  const tx = evm
    .writeReport(runtime, {
      receiver: cfg.consumerAddress,
      report,
      gasConfig: { gasLimit: cfg.gasLimit },
    })
    .result();

  runtime.log(`writeReport tx: ${tx.txHash}`);
  return tx.txHash;
};

export const initWorkflow = () => [
  cre.handler(cre.cron({ schedule: "*/30 * * * * *" }), onTrigger),
];

export async function main() {
  const runner = await cre.newRunner<Config>();
  await runner.run(initWorkflow);
}

main();
