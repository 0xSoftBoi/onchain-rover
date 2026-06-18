# Clanker 5000 — native-Solana settlement core

This is the Solana/Anchor port of The Clanker 500's on-chain settlement layer.
It is the first landed slice of the EVM → Solana migration tracked in
[`../docs/SOLANA_PORT.md`](../docs/SOLANA_PORT.md).

One Anchor program, `clanker5000`, replaces the two EVM settlement contracts:

| EVM contract | Solana equivalent (instructions) |
|---|---|
| `chain/contracts/RaceEscrow.sol` | `initialize`, `open_race`, `join_race`, `lock_race`, `start_race`, `finish_race`, `settle_race`, `cancel_race`, `set_facilitator` |
| `contracts/RaceMarket.sol` | `open_market`, `place_bet`, `settle_market`, `claim`, `set_judge` |
| `contracts/ReputationRegistry.sol` (ERC-8004) | `register_agent`, `give_feedback` (per-agent + per-feedback PDAs, running count/sum, `NewFeedback` event, self-feedback rejected) |
| `contracts/EventPass.sol` | `init_event_pass`, `mint_pass` (PDA per id, minter-gated, price recorded; `holds` via off-chain getProgramAccounts) |
| `contracts/Treasury.sol` | `init_treasury`, `withdraw_treasury` (owner/Ledger-gated), `set_treasury_owner` (PDA USDC vault) |
| `contracts/AttestationConsumer.sol` (Chainlink CRE) | `init_attestation`, `set_forwarder`, `write_attestation` (per-job PDA, threshold 70, forwarder-gated; `isVerified` read) |

### Key design changes vs. the EVM contracts

- **USDC via SPL token CPI** instead of ERC-20. Stakes live in a per-race PDA
  vault (`[b"vault", race]`), authority held by a program PDA (`[b"vault_auth"]`).
- **Driver signs directly.** The EVM flow relayed an EIP-712 `RaceEntry`
  authorization through the facilitator (plus an ERC-2612 `permit`). On Solana
  the driver is a transaction signer, so `join_race` takes the driver's own
  signature and pulls the stake from their ATA — no relayed typed-data, no
  separate approve/permit. The facilitator still owns lifecycle transitions
  (open/lock/start/finish/settle/cancel).
- **One-human-one-bet** is enforced structurally: `place_bet` `init`s a
  `nullifier` PDA seeded by the World ID nullifier, so a reused nullifier
  collides on an already-initialized account and the transaction fails. One bet
  per wallet is enforced the same way with a `bet` PDA seeded by the bettor.
- **Parimutuel pools** use a fixed `[u64; MAX_RACERS]` array (deterministic
  account space) in place of the EVM `mapping`.

### Build & test

Requires the Solana toolchain + Anchor 0.30.1 (`solana`, `anchor`) and a local
validator — not installed in every environment.

```bash
cd solana
anchor build           # compiles the program + generates target/idl + types
anchor keys sync       # replace the placeholder program id with your keypair's
anchor test            # spins up a local validator and runs tests/clanker5000.ts
```

The Rust program type-checks/compiles with a plain `cargo check -p clanker5000`
(host target) without the Solana toolchain; `anchor build` is needed for the
BPF artifact, the IDL, and the TypeScript types the sidecar consumes.

### Wiring into the sidecar

The sidecar's local-chain client (`sidecar/src/chain.ts`) is the consumer.
See [`../docs/SOLANA_PORT.md`](../docs/SOLANA_PORT.md) for the `CHAIN_BACKEND`
dispatch plan and the generated-deployment (`contracts.solana.json`) shape.
