# HANDOFF (api3/)

Read this first in a new chat.

- **Project:** Treasury Guard (approved by the team 30.10.). Design: `docs/TEAM-BRIEF.md`, simple version: `docs/OVERVIEW.md`, decisions and basics: `API3-NOTES.md`.
- **Works:** starter vendored (upstream `52933ae`). Hour-0 spike done (results in `API3-NOTES.md` → "Hour-0 spike results"): signed CoinPaprika BSV/USD + BTC/USD and TwitterAPI.io WhiteHouse fixtures cached in `test/fixtures/`, read on-chain in `test/Spike.t.sol`. `forge test` 82/82, `pnpm test` 13/13. No TreasuryGuard code yet.
- **Not deployed yet:** no project contract on Base Sepolia. `CONSUMER_ADDRESS` in `.env` is not a project contract yet.
- **Next:**
  1. ~~Hour-0 spike~~ done. Open team question: do retweets count as a post (`tweets[0]` is often a retweet)?
  2. Write the plan for `TreasuryGuard.sol` and get it approved.
  3. Opus pre-check of the plan.
  4. Build with tests for all tamper cases.
- **Last demo-ok:** none yet.
