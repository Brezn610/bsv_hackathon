# API3 / AirnodeHub – Basics

Reference for the API3 part of our TUM Blockchain Hackathon project (BSV + API3). No secrets in this file. Real keys only go in `.env`, which is gitignored.

## Network
| | |
|---|---|
| Chain | Base Sepolia |
| Chain ID | 84532 |
| Public RPC | https://sepolia.base.org (rate-limited, use a free Alchemy/QuickNode key for the agent) |
| Explorer | https://sepolia.basescan.org |
| Gas token | Base Sepolia ETH (faucets from Coinbase or Alchemy) |

## aUSD (test dollar for x402 payments)
| | |
|---|---|
| Token | `0xbeA34973e5f67F18F656A2C6070C64326C791808` |
| Decimals | 6 (1 aUSD = 1000000) |
| Faucet | https://api3dao.github.io/airnodehub-hackathon/faucet/ (or call `mintFromFaucet`, minting needs ETH for gas) |
| Paying | x402 payer needs aUSD only, no ETH. The facilitator pays the gas. Starter caps at 1 aUSD per call |

## Nodary Airnode (starter data source)
| | |
|---|---|
| URL | https://airnode-nodary.fly.dev/ |
| Signer address | `0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0` (also in the `x-airnode` extension of a GET on the URL) |
| Request hash ETH/USD via POST / | `0x180eae9387bb66a72380e61ebe0a00d19f8414a716a37ebe1df124b66acfff66` |
| Limit | none, Nodary runs its own Airnode |
| Feeds | 155, incl. BTC/USD, ETH/USD, USDC/USD, USDT/USD. **No BSV/USD** (checked 29.10.) |

Other sources for a BSV price: CoinPaprika, CoinGecko, Blocksize on AirnodeHub. API3 runs those Airnodes, quotas are shared by all teams.

## Wallets (fresh burners from `cast wallet new`)
| Key | File | Does | Needs |
|---|---|---|---|
| Deployer | `.env` → `PRIVATE_KEY` | deploys, manual demo scripts | Base Sepolia ETH |
| Deployer address | `0x85652193A6f230fC382aF4dA10CBD5DeB589fD9F` | | |
| Agent address | `0x0310dCF1E329FE74fe881ae273E1E1d2784b4cf0` | | |
| Agent | `.env.agent` → `PRIVATE_KEY` **and** `PAYER_PRIVATE_KEY` | pays x402 and submits responses in its loop | ETH + aUSD |

- The starter's `submit-response` signs with `PRIVATE_KEY`, `PAYER_PRIVATE_KEY` is only for x402. So the agent env sets both to the agent key
- Two keys so the agent loop and manual scripts never collide on nonces
- Wrong-key tamper case: ad-hoc `cast wallet new` key or `vm.sign` in Forge tests, nothing stored
- x402 payer needs aUSD only (facilitator pays gas). ETH is for minting aUSD and own txs
- One Coinbase CDP faucet claim (up to 0.1 ETH/24h) to the Deployer, then `cast send` ~0.03 ETH to the Agent. 0.02–0.05 ETH per key is plenty
- Mint 10 aUSD with the Agent, Deployer keeps its 10 aUSD faucet quota as reserve

## Starter
https://github.com/api3dao/airnodehub-hackathon-starter · needs Foundry, Node ≥ 22.18, pnpm
```bash
git clone --recurse-submodules https://github.com/api3dao/airnodehub-hackathon-starter.git
cd airnodehub-hackathon-starter && pnpm install && forge test && pnpm test
```

In the team repo the starter lives in `api3/`: run `forge` and `pnpm` from inside `api3/`. Its `pnpm-workspace.yaml` blocks packages younger than 14 days (`minimumReleaseAge`). Keep `api3/` a standalone pnpm workspace.

Vendoring the libs (no submodules): after copying, remove every nested `.git` under `lib/` (`find api3/lib -name .git -exec rm -rf {} +`), delete `.gitmodules` and `foundry.lock`, move `.github/workflows` out.

| Command | What it does |
|---|---|
| `pnpm request-hash [feed] [--passthrough]` | prints the request hash |
| `pnpm fetch-response [feed]` | fetches and checks a signed response |
| `pnpm submit-response [feed]` | fetches, checks, submits to `CONSUMER_ADDRESS` |
| `pnpm submit-response --file r.json` | submits a file as is, no off-chain check (base for the judge script) |

Deploy to Base Sepolia:
```bash
REQUEST_HASH=$(pnpm --silent request-hash) forge script script/DeployNodaryPriceLogger.s.sol --rpc-url $RPC_URL --broadcast
```

## The three checks
1. **Signer** against the address stored in the contract, never the `airnode` field of the response
2. **Request** against the hash stored or built in the contract, never the `requestHash` of the response
3. **Time** `timestamp` = when signed, `updatedAt` = when observed. A fresh signature can carry an old value
4. Plus: same response must not trigger the action twice

Signature = EIP-191 over `keccak256(abi.encodePacked(requestHash, timestamp, data))`. Send `data` as the bytes of the original string, never re-serialize it. POST / and passthrough give different hashes. If the contract builds the hash, use POST /.

## Tamper test (pass/fail, must be in the video)
Errors of `TreasuryGuard.sol` (the starter's `NotSignedByAirnode`/`ResponseTooOld` are not used). Check order: request → signer → signature age → replay, so a cached fixture still shows its own error.

| Case | How | Expected revert | Forge test |
|---|---|---|---|
| Valid + fresh | fresh BSV/USD price, `usdAmount` ≤ budget | SPEND intent created | `test_valid_freshPriceCreatesSpendIntent` |
| Edited value | change a digit in `data` | `SignerMismatch(recovered)` | `test_tamper_editedValue` |
| Too old | submit > 5 min after signing | `StaleSignature` | `test_tamper_tooOld` |
| Other request | CoinPaprika BTC/USD response (same signer) | `WrongRequest(0xcadca27a…)` | `test_tamper_wrongRequest_btcInsteadOfBsv` |
| Wrong key | re-sign with an ad-hoc key | `SignerMismatch(that key's address)` | `test_tamper_wrongKey` |
| Replay | same response twice | `Replay` | `test_tamper_replay` |
| Budget | `usdAmount` > remaining today | `BudgetExceeded(remaining)` | `test_tamper_budgetExceeded` |
| Old post, fresh signature | @federalreserve fixture (post 16.6 h old) | `StalePost` | `test_tamper_stalePost_oldPostFreshSignature` |
| Retweet | WhiteHouse fixture ("RT @CENTCOM") | `NotOriginalPost` | `test_realRetweetIsNotOriginalPost` |

Re-sign with another key:
```bash
digest=$(cast keccak $(cast abi-encode --packed 'f(bytes32,uint256,bytes)' <requestHash> <timestamp> $(cast from-utf8 '<data>')))
cast wallet sign --private-key <ad-hoc key from cast wallet new> $digest
```

## Judging (API3)
40% real use case · 30% signed data matters · 20% execution · 10% novelty · +10 agent bonus (repeated autonomous cycles, x402, spending limits, failure handling, caching/backoff)

## Submission items (API3)
- Contract address + network
- Script so judges can submit their own responses
- Video: 1 valid + 4 rejected responses
- Text: who relies on the data, what goes wrong if forged, what data we could not find on AirnodeHub

## Open decisions (team)
- What exactly does the contract change, and why only with signed data?
- Max age for signature and for the observed value, and why
- Replay protection: newer-than-last vs. settle-once
- Cherry-picking window for prices
- Data source (Nodary vs. other listings)
- One fixed request hash vs. one per item, built in the contract
- Agent cycle: schedule, limits per cycle/day, error handling

## Setup status (checked 29.10., starter vendored into api3/ on 30.10.)
- Starter in `api3/` = upstream `api3dao/airnodehub-hackathon-starter` @ `52933ae` ("Remove USDC payments", 27.10.: aUSD is now the only asset the Airnodes accept). Libs vendored (forge-std, openzeppelin-contracts, solady), no submodules. 30.10.: `forge test` 77/77, `pnpm test` 13/13
- Foundry 1.8.6, linked into `~/.local/bin` (works in non-interactive shells too). pnpm 11.5.2 via corepack shim in `~/.local/bin`
- Starter smoke test passed: `forge test` 77/77, `pnpm test` 13/13
- Deployer ~0.0004 ETH, Agent ~0.0002 ETH + 10 aUSD (Base Sepolia). Gas is tiny: deploy ≈ 0.00001 ETH, submit ≈ 0.0000006 ETH
- `.env`: deployer key, Alchemy RPC (Base Sepolia, chain 84532), Etherscan key (own key "hackathon"). `.env.agent`: agent key twice + RPC
- More test ETH: Coinbase CDP portal → ☰ → Onchain Tools → Faucet (0.0001 ETH per click, max 0.1/day). The docs link `/products/faucet` gives "Page not found"

## Repo and branch
- Team repo `eujinnl/bsv_hackathon` (BSV ts-stack monorepo), cloned to `~/Developer/bsv_hackathon`, my branch `api3` (pushed)
- Everything API3 lives in the top-level folder `api3/` only. Not in `apps/` or `packages/` (those are the root pnpm workspace)
- Copy into `api3/`: starter (libs vendored), `CLAUDE.md`, `API3-NOTES.md`, `.env.example`, `.env.agent.example`. Create `.env` / `.env.agent` locally, never commit (root `.gitignore` already ignores `.env*`)
- Commit often, only my folder: `git add api3 && git commit -m "api3: ..." && git push`
- Pull teammates' work regularly: `git pull origin main`
- Before the Sat 12:00 feature freeze: pull request `api3` → `main` on GitHub, merge with the team
- Agreement: nobody else edits `api3/`, I edit nothing outside it
- Root `CLAUDE.md` / `AGENTS.md` belong to the BSV monorepo and do not apply in `api3/`

## Local chain: anvil
- `anvil` = local Ethereum chain from Foundry at `http://127.0.0.1:8545`, 10 prefunded test accounts, instant blocks, no faucet, reset on every restart
- Workflow: build and test on anvil (free, instant, repeat as often as needed) → deploy once to Base Sepolia for demo, judges, Basescan
- Signed AirnodeHub responses work on anvil too (signatures are chain-agnostic). x402 payments always go to Base Sepolia (aUSD only exists there)
- anvil's clock only moves with mined blocks and can drift from real time. Tune the freshness window on Base Sepolia, use `vm.warp` in Forge tests
- anvil's default keys are public. Never use them on a real network
- Starter flow on anvil: `REQUEST_HASH=$(pnpm --silent request-hash) forge script script/DeployNodaryPriceLogger.s.sol --rpc-url http://127.0.0.1:8545 --broadcast`, then `pnpm submit-response` (with `RPC_URL`/`CONSUMER_ADDRESS` pointing at anvil)

## Working with Claude Code
- Run Claude Code inside `api3/`: `cd ~/Developer/bsv_hackathon/api3 && claude` (terminal, Claude app or T3 Code all work the same). Not in the second-brain vault
- Terminal windows: 1) Claude, 2) `anvil` running, 3) my own commands (`forge test`, git)
- One main chat for the contract (`src/`, `test/`). A second chat in parallel only for other files (judge script, README, agent), tell it which files it may touch. Max 2–3 chats
- Parallel chats share the same files, anvil, ports and wallets. Deploys/tests with the deployer key, the agent only with its own key (nonce collisions otherwise)
- T3 Code worktree threads: isolated copy under `.t3-worktrees/` on its own branch, merged later. `.env` files are missing there (gitignored), `pnpm install` per worktree, only committed files are copied, conflicts only get postponed
- New chat with a short summary when a chat gets long or goes in circles. Commit after every working step

## Links
[Challenge](https://api3dao.github.io/airnodehub-hackathon/docs/) · [Integrations](https://api3dao.github.io/airnodehub-hackathon/docs/integrations) · [From API to contract](https://api3dao.github.io/airnodehub-hackathon/docs/from-api-to-contract) · [AirnodeHub](https://airnodehub.api3.org/) · [Docs](https://airnodehub-docs.api3.org/) · MCP `https://airnodehub.api3.org/mcp` · Support: API3 topic in the hackathon Telegram group

## Hour-0 spike results (30.10., script `src/spike.ts`, test `test/Spike.t.sol`)
Fixtures bought once with the agent key via x402 in aUSD and cached in `test/fixtures/` (the script refuses to re-fetch). All signatures verified off-chain (`verifySignedResponse`) and on-chain (`AirnodeV2Attestation.verify` with signer + hash written into the test).

| | CoinPaprika | TwitterAPI.io |
|---|---|---|
| Airnode URL (POST /) | `https://airnode-coinpaprika.fly.dev/` | `https://airnode-twitterapi.fly.dev/` |
| Signer | `0xB8b7816a39A0bF55eF2ae9A282A1502ce35ff732` | `0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB` |
| Price per call | 0.001 USD | 0.01 USD |

**CoinPaprika `getTickersById`**
- Parameter is `coin_id` (not `id`). We send `{coin_id: "bsv-bitcoin-sv", quotes: "USD"}` explicitly; any parameter change changes the hash.
- Projection works: `{change1h: /quotes/USD/percent_change_1h, price: /quotes/USD/price, updatedAt: /last_updated}`
- Data: `{"change1h":-0.15000000596046448,"price":17.046251500133348,"updatedAt":"2026-10-30T13:03:16Z"}`
  - Values are JSON **numbers**; `change1h` is float32-printed (many digits). `updatedAt` is an ISO string (minute refresh) → `readTimestamp`.
  - `readInt(data, "change1h", 2)` = `-15` (cuts toward zero), negative decimals work. `readInt` also reads `"-1.23"` as a string.
  - Risk: exponent notation (`-1e-7`) reverts in `ProjectedJson`. JS prints |x| < 1e-6 that way; very unlikely for a %, but the contract will revert, the agent skips the cycle.
- **Request hash BSV/USD: `0x18b782163c79529c7bbe757343b930284f3aef690e45560f0aa771b629399480`** (deriveRequestHash == response.requestHash)
- Request hash BTC/USD (same projection, same signer, fixture for the WrongRequest case): `0xcadca27a1c6328b3abbe1a10feeeec01f5e49ef4ad7de3e54797265df80850d8`. Verifying it against the BSV/USD hash recovers an unrelated address → `NotSignedByAirnode`. A distinct `WrongRequest` error therefore needs a pre-check `response.requestHash == stored hash` (still recover against the stored hash).

**TwitterAPI.io `userLastTweets`** (`{userName: "WhiteHouse"}`, replies excluded by default)
- Raw shape: `{status, code, msg, data: {pin_tweet, tweets: [20 items]}, has_next_page, next_cursor}`.
- `data.tweets[0]` is the **newest** post. The pinned post is separate (`data.pin_tweet`, null for WhiteHouse), not in `tweets`.
- **No retweet boolean.** A retweet has `retweeted_tweet: {...}` (null otherwise) and text `RT @user: ...`. `tweets[0]` at fetch time was a retweet (RT @CENTCOM); ~13 of the 20 were retweets. The retweet's `id`/`createdAt` are the WhiteHouse retweet's own, the author is WhiteHouse.
- `id` is a JSON **string** (`"2116153357064888354"`) → `readUint(data, "id", 0)` reads it. Snowflake `((id >> 22) + 1288834974657) / 1000` = 1793365251 = `createdAt` "Fri Oct 30 13:00:51 +0000 2026" (Twitter format, not ISO, so Snowflake is the way).
- Projection used: `{id: /data/tweets/0/id, text: /data/tweets/0/text}` → `{"id":"2116153357064888354","text":"RT @CENTCOM: ..."}`. Retweet check on-chain: `LibString.startsWith(text, "RT @")`. Projecting `retweeted_tweet` would carry ~3.8 KB; projecting `/retweeted_tweet/id` gives a 400 when it is null.
- **Request hash WhiteHouse (with that projection): `0x783a61a36250c7dfdf26d9ea96ca3cc5894a286c9f4b4139798345cb4d9395e9`**
- Decided 30.10.: retweets are rejected (`NotOriginalPost`). Signed-at minus post time was ~3 min here.
- @federalreserve (`0xceecf6d2b5c25f57242052a0a59ca73222bf017e41a7ec13418fe1207b7b9ec6`, same projection): newest post 16.6 h old at signing → real `StalePost` fixture.

x402 payments (Base Sepolia, agent key): [BSV/USD](https://sepolia.basescan.org/tx/0x71b12c9ead04e0891898547b6a1206e4c77dfb6aac73eaa31c716e64a2b1e4c7) · [BTC/USD](https://sepolia.basescan.org/tx/0x3f4c886be0237229c8d381a14b30fd5c699dded5bd283c85af7eac896663998d) · [WhiteHouse raw](https://sepolia.basescan.org/tx/0xc3df16c290178a7f50b40f4405535835604a93adf702ef9f4ad54f11a6322e8d) · [WhiteHouse projected](https://sepolia.basescan.org/tx/0x1abcf93642393d2ac66cc21413436aa8c42165525e622dafdb804c1b097e0a8a)

## Deployments (Base Sepolia, chain 84532)
Active: vault 5 (agent), vault 6 (judge, video hedge), vault 7 (judge, live-judging hedge). Vaults 1–4 are retired; one-line reasons in `deployments.json` → `baseSepolia.retiredVaults`. The table keeps their txs as the deployment record.
| | |
|---|---|
| TreasuryGuard | [`0x8e38cc6B1Bd1f0D25357066cd0036f28fd1f7773`](https://sepolia.basescan.org/address/0x8e38cc6b1bd1f0d25357066cd0036f28fd1f7773) (verified, code `76bb027a3`) |
| Deploy tx | [`0xfc0219e4…c7ed884`](https://sepolia.basescan.org/tx/0xfc0219e499276dc10e6bdfd3f8005158ebaa14f02957dc86fd355c440c7ed884), block 52226250 |
| Vault 1 (agent loop, retired) | agent `0x0310dCF1E329FE74fe881ae273E1E1d2784b4cf0`, $1/day, tx [`0x71d629e1…cd78856e`](https://sepolia.basescan.org/tx/0x71d629e187f872adaeb6343761fb76d9fdf0448d8fc286df29541208cd78856e), block 52226260 |
| Vault 2 (judges, retired) | agent = deployer `0x85652193A6f230fC382aF4dA10CBD5DeB589fD9F`, $100/day counter, holds no funds, tx [`0xa43a4f7e…265f5a4c`](https://sepolia.basescan.org/tx/0xa43a4f7e8f4e68c33b9462baac09d1e0a726ce441100744470f72481265f5a4c), block 52226271 |
| Vault 3 (agent loop, demo account, retired) | agent `0x0310dCF1E329FE74fe881ae273E1E1d2784b4cf0`, $1/day, config copied 1:1 from vault 1 on-chain, posts WhiteHouse + federalreserve + **@TreasuryGuardDe** (`0x2e867a28c43c9781e1e8c9d139c9be65dca7b111033071859af3104c971839d3`), owner = deployer, tx [`0x53bbd928…41d17c`](https://sepolia.basescan.org/tx/0x53bbd9283eaa5d7b19498d3793971487310bdf1d7038a88cbb7c870d7041d17c), block 52231374, script `script/CreateDemoVault.s.sol` |
| Vault 4 (judges, demo account, retired) | config copied 1:1 from vault 2 (agent = deployer, $100/day counter, no funds), posts WhiteHouse + federalreserve + @TreasuryGuardDe, tx [`0xa3d5c1ef…935c40`](https://sepolia.basescan.org/tx/0xa3d5c1ef6b11c984fc90f8672e12419ffe4c31a01b8feff3e0b35296ce935c40), block 52236550, `SOURCE_VAULT=2 script/CreateDemoVault.s.sol`. Replaces vault 2 as `judgeVaultId`. A real RISK_OFF `submitEvent` moves it to GUARDED: a second positive hedge only after re-entry (+1 % after the cooldown); `checkEvent` works any number of times |
| **Vault 5 (agent loop)** | config(3) 1:1 (agent `0x0310…4cf0`, $1/day), posts WhiteHouse + federalreserve + TreasuryGuardDe + **@956_kakashi** (`0x2aa759a5578bd4b6f7e18cb12821e2aa4d5d27ef609c1332e961accc56985a12`), tx [`0x8500b5dd…`](https://sepolia.basescan.org/tx/0x8500b5dd6ceed76c867b2029a58e6f460b302b1a5663f4d7437bf824247c2e5a), block 52248781, `cast send createVault` with the config read on-chain |
| **Vault 6 (judges, video hedge)** | config(4) 1:1 (agent = deployer, $100/day counter, no funds), same four posts, tx [`0x3b32dc30…`](https://sepolia.basescan.org/tx/0x3b32dc30f9701ef9e3fac4a3c7fa956a2b677b09ab78f415465b956ac91cd893), block 52248793 |
| **Vault 7 (judges, live hedge)** | config(6) 1:1, same four posts, tx [`0xd5b27df1…`](https://sepolia.basescan.org/tx/0xd5b27df10225e0999253126dd306684c4f1f57beb15dfcad10a79ded95f1b757), block 52252483. Verified: config(7) == config(6), all four posts whitelisted, NORMAL, $100 budget. Kept unused for the one real hedge at live judging: `judge.ts --vault 7 --post 956_kakashi` |

Judge: `node --env-file=.env src/judge.ts [--dry] [--post WhiteHouse]`. Signs with the deployer key (agent of the judge vaults 2 and 4), pays x402 with the agent key (reads only `PAYER_PRIVATE_KEY` from `.env.agent`), defaults to `judgeVaultId`, refuses vault 1. Live run 30.10. on vault 2: 7/7 PASS, valid SPEND intent #1 = [`0x8426f241…`](https://sepolia.basescan.org/tx/0x8426f2416e45e2f44cceaaea392dcc84d8c991913d4a833b52f6f628953c574a) ($1 → 5,856,771 sats at $17.07425473), x402 [`0x628034c4…`](https://sepolia.basescan.org/tx/0x628034c475e4d84c1a89cfd9ab63b545895b8b8e93bf1ff0d1fb4114bfb9fb93).

All vaults: CoinPaprika BSV/USD (`0x18b78216…399480`), posts WhiteHouse + federalreserve, sig age 300 s, data age 600 s, post age 1800 s, cooldown 3600 s, intent TTL 900 s, breaker −5 % / re-entry +1 %, breaker hedge 50 %, event hedge 25 %, slippage 1 %. The BSV watcher must only co-sign intents of **vault 5** (vaults 1/3 superseded). Judge vault: **6** (2/4 superseded). Demo account switched 30.10. from @TreasuryGuardDe (new account, TwitterAPI.io returned `tweets: []` for 30+ min) to **@956_kakashi** (older account, post visible after ~13 s). Verified: config(5) == config(3), config(6) == config(4), all four post hashes whitelisted in 5 and 6. Demo account handle: `TreasuryGuardDe` (X allows max 15 chars; the display name "TreasuryGuardDemo" is not the handle). Fetch it with exactly `userName: "TreasuryGuardDe"`, any other spelling is another request hash → `WrongRequest`.

## TreasuryGuard interface (v1, 30.10., shared with the client/judge chat)
ABI: `out/TreasuryGuard.sol/TreasuryGuard.json`. Units: USD 6 decimals, price 8 decimals (USD per BSV), `change1h` and all bps in hundredths of a percent (int), sats 1e-8 BSV.

A signed response is passed as a tuple `SignedResponse(bytes32 requestHash, uint256 timestamp, bytes data, bytes signature)`, `data` = UTF-8 bytes of the exact signed string, `timestamp` = the Airnode's string as uint. `requestHash` in the tuple is only compared with stored hashes, recovery always uses the stored one. The Airnode address is never passed.

Write (only the vault's agent, else `NotAgent`):
- `createVault(VaultConfig config, bytes32[] postRequestHashes) → vaultId` (anyone; caller becomes owner; immutable). `VaultConfig(owner, agent, priceAirnode, priceRequestHash, postAirnode, dailyBudgetUsd, maxSignatureAge, maxDataAge, maxPostAge, cooldown, intentTtl, breakerBps, reentryBps, breakerHedgeBps, eventHedgeBps, slippageBps)`, `owner` is ignored.
- `submitPrice(uint256 vaultId, SignedResponse price, uint256 usdAmount) → spendIntentId` (0 if `usdAmount` = 0). May also create a breaker/re-entry SWAP intent (read `IntentCreated` events).
- `submitEvent(uint256 vaultId, SignedResponse post, SignedResponse price, uint8 verdict, bytes analystSig) → hedgeIntentId` (0 = recorded only). `verdict`: 0 IGNORE, 1 RISK_OFF, 2 RISK_ON.
- `settle(uint256 intentId, bytes32 bsvTxid)` once per intent.

Read / judge path (anyone, eth_call, same errors as the writes):
- `checkPrice(vaultId, SignedResponse) → Price(price, change1h, updatedAt, signedAt)`
- `checkEvent(vaultId, SignedResponse post, SignedResponse price) → (postId, postTime, Price)`
- `getIntent(intentId) → Intent(vaultId, kind, direction, source, maxSats, maxBps, minOut, maxOut, expiry, price, priceSignedAt, settled, bsvTxid)`, `remainingUsdToday(vaultId)`, `regime(vaultId)`, `lastPrice(vaultId)`, `getVaultConfig(vaultId)`, `isPostRequest(vaultId, hash)`, `isPostUsed(vaultId, postId)`, `vaultCount()`, `intentCount()`
- Enums: Regime 0 NORMAL, 1 RISK_OFF, 2 GUARDED · Kind 0 SPEND, 1 SWAP · Direction 0 NONE, 1 SATS_TO_DUSD, 2 DUSD_TO_SATS · Source 0 BUDGET, 1 BREAKER, 2 REENTRY, 3 EVENT
- SWAP band: `minOut`/`maxOut` = signed price ∓ slippage (USD per BSV, 8 decimals). SWAP size = `maxBps` of the vault (DUSD_TO_SATS: of its dUSD). SPEND: `maxSats`, `maxBps` 0.

Events: `VaultCreated(vaultId, owner, agent)`, `PriceVerified(vaultId, price, change1h, updatedAt, signedAt, requestHash)`, `PostVerified(vaultId, postId, postTime, signedAt, requestHash, verdict, analystSigHash)`, `IntentCreated(intentId, vaultId, kind, direction, maxSats, maxBps, minOut, maxOut, expiry, price, priceSignedAt, source)`, `RegimeChanged(vaultId, regime)`, `Settled(intentId, bsvTxid)`.

Errors: `WrongRequest(bytes32)`, `SignerMismatch(address)`, `StaleSignature()` (signature age, future > 60 s, or measured-at too old), `Replay()`, `StalePost()`, `NotOriginalPost()`, `BudgetExceeded(uint256 remaining)`, `Cooldown()`, `NotAgent()`, `InvalidAmount()`, `InvalidConfig()`, `AlreadySettled()`.
Check order price: WrongRequest → SignerMismatch → StaleSignature → Replay → (BudgetExceeded). Post: WrongRequest → SignerMismatch → StaleSignature → Replay → StalePost → NotOriginalPost → price checks (no replay) → Cooldown. The post `id` must be a JSON string of digits (a bare number reverts `ProjectedJson.UnexpectedValue("id")`).

Behaviour: budget debited at intent creation, never reset by a price, no refund on expiry, UTC daily reset. Breaker: NORMAL/GUARDED → RISK_OFF on `change1h ≤ breakerBps`; RISK_OFF/GUARDED → NORMAL on `change1h ≥ reentryBps` (decision 30.10.: the brief names only NORMAL/RISK_OFF here; GUARDED is added so a crash after a post still hedges fully, and so GUARDED has a way out, which the brief does not define); both only after `cooldown` since the last regime change (skipped silently in `submitPrice`). A RISK_OFF verdict hedges only from NORMAL (→ GUARDED), reverts `Cooldown` inside the cooldown. Changing this interface after deploy = big change, agree with the team first.

## Team decisions
- 30.10.: Opus post-build review applied: post id must be a JSON string, Replay before StalePost, GUARDED joins breaker and re-entry (see interface). Runtime size 16.3 KB (< 24 KB).
- 30.10.: ~~BSV testnet~~ → **BSV side runs on BSV MAINNET** (tiny real amounts; scripts tested on testnet first). API3 stays on Base Sepolia (x402/aUSD only exists there); no value crosses chains, the contract only verifies data and creates intents
- 30.10.: "PayPerRead" and "SignalSwap" superseded. **Decided: "Treasury Guard"** (approved by the team 30.10.; design in `docs/TEAM-BRIEF.md`, simple version in `docs/OVERVIEW.md`). Agent treasury vault on BSV `(agent AND watcher) OR owner`. `TreasuryGuard.sol` on Base Sepolia turns signed data into intents the watcher co-signs:
  - `submitPrice(priceResp, usdAmount)`: signed BSV/USD (CoinPaprika `bsv-bitcoin-sv`, x402). Checks: signer, request hash, signature age, `timestamp > lastPriceTimestamp`. Creates SPEND intent `maxSats = usdAmount / price`. **Budget rule: `remainingUsdToday -= usdAmount` at intent creation, never reset by a new price, no refund on expiry, daily reset only.** Same call runs the circuit breaker on `percent_change_1h` (regime NORMAL → RISK_OFF + hedge SWAP intent, re-entry with cooldown)
  - `submitEvent(tweetResp, priceResp, verdict, analystSig)`: signed post of a whitelisted account (TwitterAPI.io), post age from tweet-id Snowflake, replay per tweet id, hedge capped at 25 %
  - Tamper test valid case = live SPEND intent from a fresh price (no loosened thresholds)
- Hour-0 spike: project `quotes.USD.price` + `quotes.USD.percent_change_1h`, read negative decimals on-chain; real `userLastTweets` shape (path, index 0 newest/not pinned, retweet flag, id as string)
