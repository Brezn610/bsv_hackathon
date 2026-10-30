# HANDOFF (api3/)

Read this first in a new chat.

- **Project:** Treasury Guard (approved by the team 30.10.). Design: `docs/TEAM-BRIEF.md`, simple version: `docs/OVERVIEW.md`, decisions and basics: `API3-NOTES.md`.
- **Works:** the official starter is vendored into `api3/` (upstream `52933ae`): `forge test` 77/77, `pnpm test` 13/13. No project code yet.
- **Not deployed yet:** no project contract on Base Sepolia. `CONSUMER_ADDRESS` in `.env` is not a project contract yet.
- **Next:**
  1. Hour-0 spike:
     - CoinPaprika `getTickersById` (`bsv-bitcoin-sv`): can `quotes.USD.price` and `quotes.USD.percent_change_1h` be projected, and are negative decimals readable on-chain?
     - TwitterAPI.io `userLastTweets`: exact JSON path, index 0 = newest (not pinned), retweet flag, id as a string?
  2. Write the plan for `TreasuryGuard.sol` and get it approved.
  3. Opus pre-check of the plan.
  4. Build with tests for all tamper cases.
- **Last demo-ok:** none yet.
