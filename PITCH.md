# The Onchain Rover — "Give your AI agent a body"

## The one-liner
Everyone is building software agents that pay, reason, and transact — all
trapped behind a screen. We built the first robots you can **hire over HTTP**:
a physical agent fleet with names, on-chain reputations, USDC wages, human
accountability, and cryptographic proof of every job. Then we let the crowd
pay to race them and bet on the outcome.

## The product
Two autonomous rovers (Jetson Orin NX, onboard LLM) as full economic actors:
- **`guard.rover.eth` + `courier.rover.eth`** — real ENS fleet; ENSIP-25
  records point each name at its ERC-8004 on-chain agent identity
- Hire them over **x402** — gasless USDC nanopayments on Arc; HTTP 402 IS the
  hiring protocol
- Every job returns **trustless proof**: photo + Gemini vision verdict, stored
  on Walrus, hash anchored in an ERC-8004 reputation record written by the
  REQUESTER (contract forbids self-feedback)
- Reputation **tagged by skill** ("98% as guard, 91% as courier"), ranked on a
  live BigQuery leaderboard over mainnet ERC-8004 events
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
4. Courier **pays the Guard USDC robot-to-robot** → pass minted → **ADMITTED**
5. Task done → Gemini verdict → Walrus proof → requester writes ERC-8004
   feedback → leaderboard ticks up live
6. **Climax:** withdrawing the fleet's earnings BLOCKS until a human approves
   the clear-signed intent on a Ledger. Autonomous robots, human-held keys.

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
| Dynamic | Instant visitor wallets | No 60s onboarding |
| Blink | Consumer deposit on-ramp | No top-up for normies |

## What's real
Physical loop already proven live (NL task → LLM plan → drive → photo proof).
Every address/ABI/package/endpoint verified against live chains before coding:
ERC-8004 giveFeedback byte-checked on Sepolia, Circle Gateway support for Arc
(eip155:5042002) confirmed via API, Walrus returning real blobIds, AgentBook
bytecode confirmed on World Chain. Monorepo: robot/ (Python on Jetsons),
sidecar/ (TS crypto rails), contracts/, frozen interface contract between them.
