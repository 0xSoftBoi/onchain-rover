import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseUnits,
} from "viem";
import { LOCAL_ACCOUNTS, LOCAL_KEYS } from "./accounts.js";
import { deploymentPath, readArtifact, sidecarExportPath } from "./artifacts.js";

const rpcUrl = process.env.LOCAL_CHAIN_RPC_URL ?? "http://127.0.0.1:8545";
const exportRpcUrl = process.env.LOCAL_CHAIN_EXPORT_RPC_URL ?? rpcUrl;
const publicRpcUrl = process.env.PUBLIC_LOCAL_CHAIN_RPC_URL ?? exportRpcUrl;
const chainId = Number(process.env.LOCAL_CHAIN_ID ?? 31337);

const localChain = defineChain({
  id: chainId,
  name: "Rover Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const publicClient = createPublicClient({ chain: localChain, transport: http(rpcUrl) });
const deployerWallet = createWalletClient({
  account: LOCAL_ACCOUNTS.deployer,
  chain: localChain,
  transport: http(rpcUrl),
});

async function main() {
  await publicClient.getBlockNumber();

  const tokenArtifact = readArtifact("MockRaceToken");
  const escrowArtifact = readArtifact("RaceEscrow");

  console.log("Deploying MockRaceToken...");
  const tokenHash = await deployerWallet.deployContract({
    abi: tokenArtifact.abi,
    bytecode: tokenArtifact.bytecode,
    args: [LOCAL_ACCOUNTS.deployer.address],
  });
  const tokenReceipt = await publicClient.waitForTransactionReceipt({ hash: tokenHash });
  const tokenAddress = tokenReceipt.contractAddress;
  if (!tokenAddress) throw new Error("MockRaceToken deployment returned no address");

  console.log("Deploying RaceEscrow...");
  const escrowHash = await deployerWallet.deployContract({
    abi: escrowArtifact.abi,
    bytecode: escrowArtifact.bytecode,
    args: [
      tokenAddress,
      LOCAL_ACCOUNTS.treasury.address,
      LOCAL_ACCOUNTS.deployer.address,
      LOCAL_ACCOUNTS.facilitator.address,
    ],
  });
  const escrowReceipt = await publicClient.waitForTransactionReceipt({ hash: escrowHash });
  const escrowAddress = escrowReceipt.contractAddress;
  if (!escrowAddress) throw new Error("RaceEscrow deployment returned no address");

  const driverFunding = parseUnits(process.env.LOCAL_DRIVER_FUNDS ?? "1000", 6);
  for (const driver of [LOCAL_ACCOUNTS.challenger.address, LOCAL_ACCOUNTS.opponent.address]) {
    const hash = await deployerWallet.writeContract({
      address: tokenAddress,
      abi: tokenArtifact.abi,
      functionName: "mint",
      args: [driver, driverFunding],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const deployment = {
    chainId,
    rpcUrl: exportRpcUrl,
    publicRpcUrl,
    deployedAt: new Date().toISOString(),
    accounts: {
      deployer: LOCAL_ACCOUNTS.deployer.address,
      challenger: LOCAL_ACCOUNTS.challenger.address,
      opponent: LOCAL_ACCOUNTS.opponent.address,
      facilitator: LOCAL_ACCOUNTS.facilitator.address,
      treasury: LOCAL_ACCOUNTS.treasury.address,
    },
    contracts: {
      RaceToken: tokenAddress,
      RaceEscrow: escrowAddress,
    },
    defaults: {
      stakeUnits: parseUnits(process.env.LOCAL_RACE_STAKE ?? "1", 6).toString(),
      feeUnits: parseUnits(process.env.LOCAL_RACE_FEE ?? "0.25", 6).toString(),
    },
  };

  writeJson(deploymentPath(), deployment);
  writeJson(sidecarExportPath(), deployment);

  console.log("Local deployment written:");
  console.log(`  chain/deployments/localhost.json`);
  console.log(`  sidecar/src/generated/contracts.local.json`);
  console.log(`RaceToken:  ${tokenAddress}`);
  console.log(`RaceEscrow: ${escrowAddress}`);
  console.log(`Driver funds: ${formatUnits(driverFunding, 6)} local units each`);
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
