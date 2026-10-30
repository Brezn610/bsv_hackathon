# HANDOFF (api3/)

Read this first in a new chat.

- **Project:** Treasury Guard (approved by the team 30.10.). Design: `docs/TEAM-BRIEF.md`, simple version: `docs/OVERVIEW.md`, decisions and basics: `API3-NOTES.md`.
- **Works:** starter vendored (upstream `52933ae`). Hour-0 spike done (results in `API3-NOTES.md` → "Hour-0 spike results"): signed CoinPaprika BSV/USD + BTC/USD and TwitterAPI.io WhiteHouse fixtures cached in `test/fixtures/`, read on-chain in `test/Spike.t.sol`. `contracts/TreasuryGuard.sol` built (plan + Opus pre-check applied), `test/TreasuryGuard.t.sol` covers every tamper case with real fixtures. Interface: `API3-NOTES.md` → "TreasuryGuard interface (v1)". `forge test` 122/122. Opus post-build review applied.
- **TS client + judge script + docs/INTERFACE.md** done by the parallel chat (c798f6a44, dc6bb54be), judge: `node --env-file=.env.agent src/judge.ts [--dry]`.
- **Deploy script:** `script/DeployTreasuryGuard.s.sol` (vault: $1/day, -5 %/+1 %, cooldown 1 h, posts WhiteHouse + federalreserve [+ `DEMO_POST_REQUEST_HASH`], optional `JUDGE_VAULT=true`), dry run on anvil ok.
- **Deployed (Base Sepolia, verified):** TreasuryGuard `0x8e38cc6B1Bd1f0D25357066cd0036f28fd1f7773`, block 52226250, vault 1 = agent (`0x0310…4cf0`, $1/day), vault 2 = judges (deployer, $100/day, no funds). Details in `API3-NOTES.md` → "Deployments". `CONSUMER_ADDRESS` in `.env` is still the starter's, unused.
- **Next:**
  1. ~~Hour-0 spike~~, ~~plan~~, ~~Opus pre-check~~, ~~build + tests~~ done. Retweets are rejected.
  2. ~~Opus post-build review~~ applied.
  3. Agree the interface with the BSV side (note: `vaultId` argument, not in the brief), ~~deploy~~ done. Team demo X handle pending → new vault with its hash (agent/watcher then switch vaultId). Next: first live valid submit (judge script on vault 2) → "last demo-ok".
  4. Parallel chat owns `src/client/**`, `src/judge.ts`, `deployments.json`, `docs/INTERFACE.md`.
- **Last demo-ok:** none yet.
