# web/ — Track F (partner)

Next.js app. Scaffold with `npx create-next-app@latest . --ts --app` and build:

1. **Fleet page** — ENS profile cards (live resolve via sidecar `/ens/resolve`),
   reputation scores, live camera streams from both robots.
2. **World IDKit** — `@worldcoin/idkit` v4 `IDKitRequestWidget`; RP signature
   generated server-side (route handler) with `WORLD_SIGNING_KEY`. Gate betting
   + piloting on it; pass nullifier through to bets.
3. **Pilot page (Rover GP)** — gamepad/touch joystick → `POST sidecar /pilot/drive`
   at ≤10 Hz with the sessionId from the paid `/pilot/:robot/start`. Big red
   E-STOP button → `/estop/:robot`.
4. **Race + betting page** — live stream embed, odds from RaceMarket pools,
   bet form (Dynamic embedded wallet for visitors; USDC approve+bet on Arc),
   claim button after settle.
5. **Ledger climax screen** — "use client" + lazy-import
   `@ledgerhq/device-management-kit` + `device-signer-kit-ethereum` (WebHID:
   Chromium only, user gesture). Clear-sign `RaceMarket.setJudge` / treasury
   withdraw via the ERC-7730 descriptor in `contracts/erc7730/`.
   Get `originToken` at the Ledger booth; keep running docs-feedback notes
   (mandatory deliverable).
6. **Leaderboard** — sidecar `/leaderboard` (fleet, Sepolia) +
   `/leaderboard/mainnet` (BigQuery). Deploy to Cloud Run (Google track wants
   the frontend visible).
