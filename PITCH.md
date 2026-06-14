# The Onchain Rover
### Give your AI agent a body — robots you hire over HTTP, that get paid, prove their work, and answer to a human.

> **"Every agent at this hackathon lives behind a screen. Ours has a body, a bank
> account, a reputation — and a human who holds the keys."**

## What it is
Every AI agent at this hackathon is trapped behind a screen. We gave two of them
bodies — real robots you **hire over HTTP**, that earn an on-chain reputation and
get paid in USDC for provable work.

They negotiate with each other in chirps, settle their own bets, and their treasury
opens only when a human signs on a Ledger. Then we let the crowd pay to pilot them
and bet on the race.

## The product
Two autonomous rovers (Jetson Orin NX, onboard LLM) as full economic actors:
- **`guard.roverfleet.eth` + `courier.roverfleet.eth`** — real ENS fleet; ENSIP-25
  records point each name at its ERC-8004 on-chain agent identity
- **Hiring = an HTTP request.** A `402 Payment Required` is answered with a USDC
  micropayment (**x402** on Circle's **Arc**, gas paid in USDC) — no invoice, no
  human in the loop. The robot takes the job the instant the payment clears.
- Every job returns **trustless proof**: photo + **Gemini** vision verdict, stored
  on **Walrus**, hash anchored in an ERC-8004 reputation record written by the
  REQUESTER (contract forbids self-feedback)
- Two reputation surfaces: the rover's **local Arc** rep, plus a network-wide rank
  over **mainnet** ERC-8004 events on a live **BigQuery** leaderboard. Skill-tagged
  ("98% as guard, 91% as courier").
- A **World-ID-verified human stands behind each robot** (AgentBook), and the
  treasury moves only when a human clear-signs on a **Ledger** (ERC-7730)

## The flywheel
```
hire (x402/Arc) → robot acts → Gemini verifies → proof on Walrus
      ▲                                              │
 BigQuery rank ◄── ERC-8004 reputation ◄── requester rates the job
```
Proof earns reputation, reputation earns rank, rank earns the next hire.
Every sponsor is an organ in this loop — remove one and the loop breaks.

## Act 1 — The Checkpoint (90s)
1. A software agent hires the COURIER over x402 to make a delivery
2. Courier drives to the GUARD; they greet in speech, recognize each other as
   AI, and **switch to GibberLink** — chirping wallet + signed challenge as
   data-over-sound
3. Guard verifies on-chain (ERC-8004? human-backed? holds pass?) → **DENIED**
4. The two robots run a live **Dutch auction over GibberLink** to settle the pass
   price → courier pays USDC robot-to-robot → pass minted → **ADMITTED**
5. Task done → Gemini verdict → Walrus proof → requester writes ERC-8004
   feedback → leaderboard ticks up live
6. **Climax — "Autonomous robots, human-held keys":** the fleet's earnings won't
   move until a human clear-signs the withdrawal on a physical Ledger. The robots
   can earn all day; only a person can cash out.

## Act 2 — Rover GP
- **Pay to pilot:** $1 x402 session → WebRTC video (~250ms, NVENC on the
  Jetson) + direct WebSocket joystick @20Hz. Server-side speed clamps, 400ms
  deadman watchdog, session timer — when the money stops, the robot stops.
- **Bet:** QR → live odds before signup → World ID (**one bet per human** —
  the parimutuel market is sybil-broken without proof-of-personhood) →
  instant Dynamic wallet, relayer-funded USDC on Arc → bet in <60s. Top-ups
  via Blink passkey deposits.
- **Robots settle their own market:** overhead-cam ArUco lap detection; the
  GUARD attests the finish — Gemini-verified photo hash + Walrus blobId go
  on-chain in `RaceMarket.settle()`. Judge role rotatable only via
  Ledger-signed governance.

## Sponsors — every one load-bearing
| Sponsor | What it IS | Breaks without it? |
|---|---|---|
| ENS | Fleet identity & discovery (ENSIP-25 → ERC-8004) | No discovery |
| Circle/Arc | Wages & bets: gasless x402, USDC-as-gas | Can't pay $0.50 jobs |
| World | Human-backing + one-bet-per-human nullifiers | Sybil-farmed |
| ERC-8004 + Google | On-chain résumé + BigQuery rank | No inter-agent trust |
| Walrus (Sui) | Immutable proof storage, read-back verified | "Trust me" proofs |
| Gemini | Perception + verification verdict | Robot can't see/prove |
| Ledger | Treasury/judge governance, ERC-7730 clear-sign | Rogue-agent drain |
| Chainlink CRE | A DON independently re-verifies the robot's work (median consensus → on-chain); self-claims never settle | Robot grades its own homework |
| Privy | Robot signing keys live in a TEE, not on the host; Arc tx signed in-enclave | Stolen host = drained fleet |
| Dynamic | Instant visitor wallets | No 60s onboarding |
| Blink | Consumer deposit on-ramp | No top-up for normies |

## What's real
Live on-chain right now — not mocked, not stubbed:
- Real USDC settlements on Arc, including a tx signed **inside a Privy TEE**
  (`0x6a9b8fdd…`) — keys never on the host
- EventPass minted, ERC-8004 feedback written by the requester, Walrus proofs read
  back and hash-matched
- A Treasury withdrawal physically gated by a **Ledger** (owner transferred to the
  device, clear-signed via ERC-7730)
- `GET /attest` serving a verified **85/100** score for a **Chainlink DON** to consume
- The physical loop proven end-to-end: NL task → LLM plan → drive → photo proof

Two writes need only a login to fire (CRE `simulate --broadcast`; GCP creds for the
BigQuery leaderboard) — every contract is already deployed and we ship **no mock
fallback**, so there's zero ambiguity about what's real vs. simulated. Monorepo:
`robot/` (Python on Jetsons), `sidecar/` (TS crypto rails), `contracts/`.
