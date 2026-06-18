import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

describe("Clanker500 static pages", () => {
  const stage = readPublic("clanker500.html");
  const join = readPublic("clanker500-join.html");

  it("wires the stage board to the Clanker500 route surface", () => {
    for (const endpoint of [
      "/clanker500/active",
      "/clanker500/round",
      "/clanker500/config",
      "/race/round/",
      "/clanker500/round/${state.round.id}/lock",
      "/clanker500/round/${state.round.id}/countdown",
      "/clanker500/round/${state.round.id}/start",
      "/clanker500/round/${state.round.id}/settle",
      "/clanker500/round/${state.round.id}/cancel",
    ]) {
      assert(stage.includes(endpoint), `stage page missing ${endpoint}`);
    }
  });

  it("keeps the stage operator controls addressable by stable ids", () => {
    for (const id of [
      "refresh",
      "newHeat",
      "qr",
      "joinLink",
      "stake",
      "challengerSlot",
      "opponentSlot",
      "roundId",
      "localStatus",
      "chainStatus",
      "winner",
      "lock",
      "countdown",
      "start",
      "settle",
      "cancel",
      "log",
    ]) {
      assert(stage.includes(`id="${id}"`), `stage page missing #${id}`);
    }
  });

  it("keeps the stage board polling, QR rendering, and lane labels intact", () => {
    assert(stage.includes("qrcode@1.5.4"), "stage page missing QR library");
    assert(stage.includes("setInterval(refresh, 2500)"), "stage page missing refresh poll");
    assert(stage.includes("Left Lane"), "stage page missing left lane label");
    assert(stage.includes("Right Lane"), "stage page missing right lane label");
    assert(stage.includes("guard"), "stage page missing guard robot");
    assert(stage.includes("courier"), "stage page missing courier robot");
    assert(stage.includes("chainJoined"), "stage page missing staked state");
  });

  it("wires the phone join page to wallet, chain, stake, and confirm flows", () => {
    for (const token of [
      "eth_requestAccounts",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "eth_sendTransaction",
      "/clanker500/config",
      "/clanker500/active",
      "/clanker500/round/${encodeURIComponent(state.roundId)}/claim-next-slot",
      "/clanker500/round/${encodeURIComponent(state.roundId)}/join-tx",
      "/clanker500/round/${encodeURIComponent(state.roundId)}/confirm-join",
    ]) {
      assert(join.includes(token), `join page missing ${token}`);
    }
  });

  it("keeps phone join controls and pilot handoff stable", () => {
    for (const id of ["connect", "stakeButton", "pilot", "status", "roundId", "slot", "stake", "wallet", "tx"]) {
      assert(join.includes(`id="${id}"`), `join page missing #${id}`);
    }
    assert(join.includes("<button id=\"stakeButton\" disabled>"), "stake button should start disabled");
    assert(join.includes("pilot.href = `/pilot.html?robot="), "join page missing pilot handoff");
    assert(join.includes("camera=local"), "join page missing local camera handoff");
    assert(join.includes("Stake + Join"), "join page missing stake command");
  });

  it("keeps Base Sepolia transaction fields sourced from the sidecar join transaction", () => {
    assert(join.includes("from: state.wallet"), "join tx should use connected wallet");
    assert(join.includes("to: tx.to"), "join tx should use sidecar escrow target");
    assert(join.includes("value: tx.value"), "join tx should use sidecar stake value");
    assert(join.includes("data: tx.data"), "join tx should use sidecar calldata");
    assert(join.includes("chainId: tx.chain.chainIdHex"), "join tx should use Base Sepolia chain id");
  });
});

function readPublic(name: string) {
  return readFileSync(join(publicDir, name), "utf8");
}
