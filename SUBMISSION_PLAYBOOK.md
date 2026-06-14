# Submission Improvement Playbook — The Onchain Rover

A reusable workflow for getting every part of the ETHGlobal submission to "obvious
winner." Run the **loop** below on each asset; use the **rubric** to score; stop when
every asset clears the bar in the **pre-submit checklist**.

> **Core principle (learned from this project's own teardown):** the README is a
> better pitch than the pitch was. **Concrete on-chain receipts beat adjectives.**
> Lead every asset with what's *real and verifiable*, not with what's clever.

---

## The assets & who they're for

| Asset | Read by | Wins/loses on |
|---|---|---|
| `PITCH.md` | Judges skimming before/after demo | Hook in 3 lines, one quotable line, sponsor fit |
| `README.md` | Judges scoring solo in 5 min | Skimmability, "real not mocked" proof, repro |
| `Onchain_Rover_Deck.pptx` | The room during the pitch | Visual clarity, one idea per slide, demo wow |
| `DEMO_RUNBOOK.md` | You + co-presenter, live | Fitting 3:00, surviving live-robot failure |

---

## The improvement loop (run per asset)

1. **Reframe to receipts.** Find every adjective ("real", "live", "proven") and ask:
   is there a hash / address / tx / explorer link next to it? If not, add one or cut
   the adjective.
2. **Hook check.** Read only the first 3 lines / first slide. Does a tired judge get
   *what it is* and *why it's hard*? If not, rewrite the top.
3. **Jargon pass.** Circle every acronym. For each, is the human-readable benefit
   adjacent? (`x402` → "hiring = an HTTP request that pays"). Keep the term, add the
   plain-English.
4. **Sponsor fit.** For each sponsor, is there one sentence a *that-sponsor* judge can
   copy into their scorecard? Every live sponsor must appear (don't leave bounties on
   the table — CRE and Privy were missing from the pitch).
5. **One quotable line.** Each asset needs the line judges repeat to each other. Plant
   it where the eye lands, not at the end.
6. **Cut.** Remove anything that doesn't earn a point. Duplicated diagrams, second
   settle-beat, restated bullets.
7. **Verify.** Re-render the deck to images; re-read edits; confirm no factual
   conflicts *between* assets (names, prices, chains).

---

## Scoring rubric (1-5 each; ship at ≥4 across the board)

- **Hook** — grabs in 3 lines / 1 slide
- **Clarity** — a non-crypto judge follows it
- **Credibility** — claims backed by verifiable receipts; honest about gaps
- **Sponsor fit** — every live sponsor crisply claimable
- **Memorability** — one repeatable line
- **Concision** — nothing that doesn't earn a point
- **Consistency** — no contradictions across assets

---

## Cross-asset facts that MUST match everywhere

Pick one value for each and grep all four assets to enforce it:

- **ENS names:** `guard.roverfleet.eth` / `courier.roverfleet.eth` (parent
  `roverfleet.eth` + subnames — confirmed in `sidecar/src/register-ens.ts`).
  ⚠️ `.env.example` still says `ENS_PARENT=rover.eth` — fix or it misleads.
- **Act 1 negotiation:** the robots run a **Dutch auction over GibberLink**, *then*
  pay. (Not a flat "courier pays" — that contradicted the README.)
- **Two reputation surfaces:** local **Arc** reputation (the rover's own) vs.
  network-wide **mainnet** ERC-8004 rank (BigQuery leaderboard). Don't conflate.
- **Race:** "fruit-obstacle drag race." **Bet:** one bet per human via World ID.

---

## Per-asset checklists

### PITCH.md
- [ ] First 3 lines land the hook before any acronym
- [ ] Literal one-liner is the subtitle (line 2), not a paragraph
- [ ] Jargon bullets lead with the plain-English benefit
- [ ] Sponsor table includes **all** live sponsors (add Chainlink CRE, Privy)
- [ ] "What's real" ported from README with tx hashes; honest about credential-gated
- [ ] Quotable line ("Autonomous robots, human-held keys") is a label, not a footnote
- [ ] ENS names + Act 1 auction match README

### README.md
- [ ] One-line **sponsor map** + jump links directly under the tagline
- [ ] Every address/hash is **full + clickable** explorer link (no `0x…` truncation)
- [ ] Credential-gated section reframed as "we refused to mock it," code-is-done
- [ ] **"Run with no robot/GPU"** stub path surfaced in README (not just ROBOTICS.md)
- [ ] Meta block: 🎥 demo video, 👥 team, 📜 license, 🔍 "start here" entry points
- [ ] One architecture mermaid only; link the rest to ROBOTICS.md
- [ ] Dedicated x402 and Gemini bullets in "What's real"

### Onchain_Rover_Deck.pptx
- [ ] One idea per slide; titles are claims, not labels
- [ ] ENS names correct (`*.roverfleet.eth`)
- [ ] Speaker notes timed to the runbook beats
- [ ] Re-rendered to images and visually QA'd (no overflow/overlap)
- [ ] Backup: PDF export for the portal

### DEMO_RUNBOOK.md
- [ ] **Drag race is opt-in**, not default; mainline rebudgeted to **2:30** with slack
- [ ] Hard gate: "at 1:40, if Ledger beat hasn't started, skip to it"
- [ ] Every "X / Y" decision resolved (who pilots; who presses Ledger confirm)
- [ ] Fallbacks added: race-finish-not-detected (manual winner), guard-speaker-dead
  (on-screen transcript)
- [ ] Judge pilot is pre-started; hand over a *live* control, never a cold start
- [ ] Backup video test-played to end, at volume, on the demo laptop/tab
- [ ] Shill bet uses a **different** World ID than the one judges will use

---

## Pre-submit checklist (the final gate)

- [ ] All four assets score ≥4 on every rubric row
- [ ] Cross-asset facts verified consistent (run the grep)
- [ ] Demo video uploaded and linked in README + submission portal
- [ ] LICENSE file present
- [ ] Team names / ETHGlobal handles listed
- [ ] Every deployed contract address resolves on its explorer
- [ ] Deck exported to PDF as a portal-safe fallback
- [ ] One dry run of the full 3:00 demo completed under time
