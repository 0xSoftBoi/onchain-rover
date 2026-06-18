# Clanker 5000 — native-Solana migration

This document tracks the rewrite of The Clanker 500 from its EVM stack
(Solidity + Hardhat + viem, on Arc / Sepolia / World Chain) to a **native
Solana** implementation, branded **Clanker 5000** after ClawPump
(*"Eternal AI Agents on Solana"*, https://clawpump.tech).

It is the source of truth for what has landed, what is scaffolded, and what is
still planned — so there is zero ambiguity about real vs. aspirational.

> **On the ClawPump docs.** `clawpump.tech` and `clawpump.tech/docs` are
> client-side-rendered single-page apps; the server returns only the page
> title/tagline and no machine-readable spec (no endpoints, program IDs,
> account layouts, or SDK). We therefore could **not** integrate ClawPump's
> own on-chain program/API directly — doing so would require inventing
> identifiers. The token-launch ("pump") surface below is specified as a
> generic SPL/PDA design and is flagged as **needs ClawPump spec** until a
> readable interface (program ID + IDL, or an SDK/repo) is provided.

## Status legend

- ✅ **landed** — real code in the repo, compiles.
- 🟡 **scaffolded** — design + interface fixed; implementation in progress.
- ⛔ **planned** — mapped below, not yet started.
- 🔌 **needs ClawPump spec** — blocked on a readable ClawPump interface.

## Settlement core

| EVM | Solana | Status |
|---|---|---|
| `chain/contracts/RaceEscrow.sol` | `solana/programs/clanker5000` — `initialize` / `open_race` / `join_race` / `lock_race` / `start_race` / `finish_race` / `settle_race` / `cancel_race` / `set_facilitator` | ✅ landed |
| `contracts/RaceMarket.sol` | same program — `open_market` / `place_bet` / `settle_market` / `claim` / `set_judge` | ✅ landed |
| `chain/contracts/MockRaceToken.sol` (ERC-20 + permit) | SPL Mint (USDC, 6dp). A local mint stands in for devnet USDC. No `permit`: the driver signs the join tx directly. | ✅ landed (mint created in tests) |
| EIP-712 `RaceEntry` + ERC-2612 `permit` relay | Driver is a tx signer; stake pulled from the driver's ATA in `join_race`. Facilitator keeps lifecycle authority. | ✅ landed (design change, see `solana/README.md`) |

### Behavioral parity notes

- Stake escrow: per-race PDA token vault (`[b"vault", race]`) with a program
  PDA authority (`[b"vault_auth"]`); `settle_race` pays the winner `2 × stake`,
  `cancel_race` refunds both staked drivers.
- Parimutuel payout: `payout = stake × total_pool / winning_pool`, computed in
  `u128` then cast — same formula as `RaceMarket.claim`.
- One-human-one-bet: a `nullifier` PDA seeded by the World ID nullifier; reuse
  fails on `init`. One-bet-per-wallet: a `bet` PDA seeded by the bettor.

## Off-chain client (sidecar)

The sidecar local-chain client `sidecar/src/chain.ts` (viem) is the consumer of
the settlement core. The Solana backend slots in behind a `CHAIN_BACKEND`
switch so the existing EVM demo keeps working untouched.

| Piece | Plan | Status |
|---|---|---|
| `chain.ts` (viem) | `sidecar/src/solana-chain.ts` mirrors its 13 exported functions (`openRoundOnChain`, `joinRoundOnChain`, `lock/start/finish/settle/cancelRoundOnChain`, `buildRaceEntryRequest`, `localChainConfig`, `publicLocalChainConfig`, `localChainHealth`, `localTreasuryInfo`, `fundLocalWallet`) using `@coral-xyz/anchor`. | ✅ landed (typechecks) |
| `generated/contracts.local.json` | `sidecar/src/generated/contracts.solana.example.json` template; copy to `contracts.solana.json` after deploy. Read by `solana-config.ts`. | ✅ landed (template) |
| `buildRaceEntryRequest` (typed data for the phone to sign) | On Solana the phone wallet signs the `join_race` transaction itself; `buildRaceEntryRequest` now returns the serialized `join_race` instruction (programId/keys/base64 data) for the wallet to sign — no EIP-712, no permit. | ✅ landed |
| Dispatch | `chain-backend.ts` dispatches to EVM or Solana by `CHAIN_BACKEND` (default `evm`, Solana lazy-imported); the 4 `import * as chain from "./chain.js"` call sites now import `./chain-backend.js`. | ✅ landed |

> **Resolved:** `normalizeWallet` (rounds.ts) is now backend-aware — under
> `CHAIN_BACKEND=solana` it validates base58 Solana pubkeys and preserves case
> instead of requiring/lowercasing an `0x` EVM address. This unblocks creating
> and joining a round with Solana wallets end-to-end.

### Integration steps (sidecar)

1. `cd solana && anchor build` → produces `target/idl/clanker5000.json` and
   `target/types/clanker5000.ts`.
2. Copy/symlink the IDL + types into `sidecar/src/generated/`.
3. Implement `sidecar/src/solana-chain.ts` against the IDL (the lifecycle calls
   are demonstrated in `solana/tests/clanker5000.ts`).
4. Add `chain-backend.ts` dispatch and flip the 4 importers.
5. Set `CHAIN_BACKEND=solana`, `SOLANA_RPC_URL`, `SOLANA_PROGRAM_ID`,
   `SOLANA_USDC_MINT`, `FACILITATOR_SECRET_KEY` in `.env`.

## Sponsor integrations (EVM → Solana map)

These are the remaining pieces of a full rewrite. Several EVM-specific sponsor
integrations have no 1:1 Solana analog and need a product decision.

| EVM integration | Solana target | Status / notes |
|---|---|---|
| ENS (`roverfleet.eth`, subnames, ENSIP-25) | **SNS** (Bonfida `.sol`) — `sidecar/src/sns.ts` resolves `guard/courier.roverfleet.sol` owner + agent-context TXT record live | ✅ resolution landed; registration planned |
| ERC-8004 `ReputationRegistry` | Anchor reputation in the `clanker5000` program — `register_agent` / `give_feedback`, per-agent + per-feedback PDAs, running count/sum, `NewFeedback` event; self-feedback rejected | ✅ landed |
| EventPass (ERC-721 mint on Arc) | Program-native pass record in `clanker5000` — `init_event_pass` / `mint_pass` (PDA per id, minter-gated, price recorded); `holds(who)` is an off-chain `getProgramAccounts` query (`eventPassHolds` in `solana-chain.ts`). A Metaplex NFT wrapper is the optional production upgrade. | ✅ landed |
| `Treasury.sol` + Ledger ERC-7730 clear-sign | PDA treasury in `clanker5000` — `init_treasury` / `withdraw_treasury` (owner-gated) / `set_treasury_owner`. The sidecar never holds the owner key: `buildTreasuryWithdraw` returns the instruction for a physical Ledger Solana clear-sign. (Squads multisig is the optional upgrade.) | ✅ landed |
| x402 + Circle/Arc (USDC-as-gas wages) | x402 has Solana support via SPL USDC; gas is SOL (no USDC-as-gas) | ⛔ planned — fee model differs |
| World ID betting gate | Keep World ID proof off-chain; store the nullifier in the `nullifier` PDA (already wired in `place_bet`) | ✅ on-chain nullifier landed; off-chain verifier reuse planned |
| Chainlink CRE `AttestationConsumer` (Sepolia) | Attestation consumer in `clanker5000` — `init_attestation` / `set_forwarder` / `write_attestation` (per-job PDA keyed by job hash, threshold 70, forwarder-gated with a zero-key sim escape hatch); `getAttestation`/`isVerified` reads in `solana-chain.ts`. A Switchboard/Chainlink-Solana DON writes the verdict. | ✅ landed |
| Privy TEE custody | Privy Solana wallets (TEE signing of Solana txs) | ⛔ planned |
| Walrus proof storage | Unchanged — Walrus is chain-agnostic; only the on-chain hash anchor moves to the Solana program (`proof_hash` in `finish_race` / `settle_market`) | ✅ anchor field landed |
| BigQuery ERC-8004 leaderboard | Re-pointed: `agentRanking` / `fleetReputation` in `solana-chain.ts` rank agents directly from the clanker5000 reputation accounts (count + avg via `getProgramAccounts`). A BigQuery indexer over `NewFeedback` logs remains an option for the broader ecosystem view. | ✅ landed (on-chain); ecosystem indexer optional |
| ClawPump token launch ("pump") | Generic SPL mint + bonding-curve/launch PDA | 🔌 needs ClawPump spec |

## Why not a single big-bang rewrite

The EVM stack is live and demoable. This migration lands the **settlement core**
first (highest value, fully self-contained) behind a backend switch, then ports
sponsor integrations incrementally, so `main` always has a working demo. Each
row above moves to ✅ as it lands.
