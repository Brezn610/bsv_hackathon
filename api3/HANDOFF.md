# HANDOFF (api3/)

Read this first in a new chat.

- **Project:** Treasury Guard (approved by the team 30.10.). Design: `docs/TEAM-BRIEF.md`, simple version: `docs/OVERVIEW.md`, decisions and basics: `API3-NOTES.md`.
- **Works:** starter vendored (upstream `52933ae`). Hour-0 spike done (results in `API3-NOTES.md` → "Hour-0 spike results"): signed CoinPaprika BSV/USD + BTC/USD and TwitterAPI.io WhiteHouse fixtures cached in `test/fixtures/`, read on-chain in `test/Spike.t.sol`. `contracts/TreasuryGuard.sol` built (plan + Opus pre-check applied), `test/TreasuryGuard.t.sol` covers every tamper case with real fixtures. Interface: `API3-NOTES.md` → "TreasuryGuard interface (v1)". `forge test` 122/122. Opus post-build review applied.
- **Not deployed yet:** no project contract on Base Sepolia. `CONSUMER_ADDRESS` in `.env` is not a project contract yet.
- **Next:**
  1. ~~Hour-0 spike~~, ~~plan~~, ~~Opus pre-check~~, ~~build + tests~~ done. Retweets are rejected.
  2. ~~Opus post-build review~~ applied.
  3. Agree the interface with the BSV side (note: `vaultId` argument, not in the brief), then deploy script + deploy to Base Sepolia.
  4. Parallel chat owns `src/client/**`, `src/judge.ts`, `deployments.json`, `docs/INTERFACE.md`.
- **Last demo-ok:** none yet.
