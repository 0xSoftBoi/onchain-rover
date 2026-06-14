# Chainlink CRE — decentralized work verification

The DON independently verifies the robot's work and writes the consensus verdict
on-chain. Downstream settlement (EventPass mint / x402 release / ERC-8004) reads
`AttestationConsumer.isVerified(job)` — the robot's self-claim never settles.

```
robot GET /attest ──► DON nodes (each fetch) ──► median consensus ──► writeReport ──► AttestationConsumer (Sepolia)
   score 0-100            independent reads          agreed score           real tx           isVerified(job) gate
```

## What's already built (in this repo)
- `robot/api.py` → `GET /attest?job=&task=` — the verifiable data source (Gemini
  confidence on the Walrus-anchored proof, cached per job for clean consensus)
- `contracts/AttestationConsumer.sol` — the `onReport` receiver (built ✓)
- `sidecar/src/deploy-consumer.ts` — Sepolia deploy
- `cre-workflow/main.ts` + `config.json` — the workflow
- `sidecar` `/cre/config` + `/cre/latest`, wall panel "ORACLE VERIFICATION"

## Steps you run (need: a Chainlink account + Sepolia ETH)

1. **Install the CLI** (external installer — run it yourself):
   ```
   curl -sSL https://cre.chain.link/install.sh | bash
   ```

2. **Sepolia ETH** for `ENS_OWNER_KEY` (0xAD73…): https://faucets.chain.link

3. **Deploy the consumer:**
   ```
   cd sidecar && npx tsx src/deploy-consumer.ts
   ```
   Copy the printed `ATTESTATION_CONSUMER=0x…` into:
   - `cre-workflow/config.json` → `consumerAddress`
   - repo `.env` → `ATTESTATION_CONSUMER=0x…` and `CRE_JOB=demo-1` (so the wall reads it)

4. **Scaffold + drop in the workflow:**
   ```
   cre login                       # interactive (your Chainlink account)
   cre init                        # choose TypeScript; creates a project
   # copy cre-workflow/main.ts + config.json into the generated workflow dir
   bun install                     # @chainlink/cre-sdk + viem
   ```
   Verify SDK signatures in `main.ts` against the installed `@chainlink/cre-sdk`
   (the API moves between releases; see warnings inline).

5. **Point config at the live robot** — `apiUrl` already targets
   `http://172.16.1.29:8000/attest?job=demo-1&...`. Make sure the robot API is up.

6. **Run it — real Sepolia state change (no deploy approval needed):**
   ```
   cre workflow simulate <name> --target staging-settings --broadcast
   ```
   This fetches /attest from the DON, reaches consensus, and `writeReport`s to
   the consumer → the wall's "ORACLE VERIFICATION" panel shows the DON median
   score + the `writeReport` tx, and the chip lights when verified (≥70).

## Prize note
The CRE track requires "a state change on a blockchain using a Chainlink
service." `writeReport` → `AttestationConsumer` is exactly that.
