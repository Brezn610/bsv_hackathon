# Team context: Treasury Guard (TUM Blockchain & AI Hackathon, BSV + API3 tracks)

You are helping a member of our hackathon team. Read this whole brief first. It is our current plan (Fri 30 Oct 2026) and **replaces the earlier "PayPerRead" and "SignalSwap" ideas** and was approved by the team on 30 Oct. Before writing any code, ask me which part of the system I own and confirm the interface I depend on.

> Naming: the demo stablecoin's working name is **dUSD** (final name TBD). Don't call it "tUSD": TrueUSD (TUSD) is a real stablecoin.

## Event facts
- TUM Blockchain & AI Hackathon, Munich, 30–31 Oct 2026. Theme: agentic payments.
- **Hard deadline: Sat 31 Oct, 15:00 on Devfolio.** Team target: submitted by 13:30. Feature freeze Sat 11:00. After that only bug fixes, README, scripts and video.
- Live judging: Sat 15:00–17:00, separately in front of the BSV judges and the API3 judges. The demo must also work live.
- Submission (all teams): one demo video **≤ 2.5 minutes** for both tracks, a Devfolio description, and a **public** repo with a README (setup + run).
- No building before the event.
- Repo `eujinnl/bsv_hackathon` (public). The API3 part lives only in the top-level folder `api3/` (branch `api3`) with one owner. Don't edit `api3/` unless you own it, and the API3 owner doesn't edit anything outside it.
- **Networks: BSV MAINNET (tiny real amounts) + Base Sepolia for the API3 part.** API3 stays on Base Sepolia because x402 payments in aUSD only exist there; the contract only verifies data and creates intents, no value crosses chains. In production the contract would move to Base mainnet. Mainnet means real money: tiny amounts only, test every custom script on BSV testnet first, and a script bug can lock funds forever.

## The idea in one sentence
**AI agents pay in sats, but their owners think in dollars and fear volatility and runaway spending. Treasury Guard is a non-custodial treasury vault and swap rail on BSV: the agent can only spend, hedge or swap when authenticated API3 data verified on-chain says so, and the owner can always exit.**

## What the product does (3 jobs)
1. **Dollar budget, paid in sats.** The owner sets a daily budget in USD (e.g. $5/day). Every time the agent needs sats, it submits a **signed BSV/USD price**. The contract converts the remaining USD budget into a sats limit and creates a spend intent. Without a verified price, nobody can say how many sats $5 is. With a forged price, the agent could overspend.
2. **Circuit breaker.** The same signed price includes the 1h change. If BSV drops more than the owner's threshold (e.g. −5 % in 1h), the contract switches to `RISK_OFF` and allows a hedge of the agent's sats float into dUSD (stablecoin on BSV). It rotates back only when the signed price recovers and a cooldown has passed. No LLM is involved in this path.
3. **Authenticated news guard.** If a whitelisted official account (e.g. @WhiteHouse) posts, the agent pays an **Analyst agent** on BSV for a verdict (risk-off / risk-on / ignore). With the signed post + signed price, the contract allows a hedge **capped at 25 %**. The LLM can never move more than that.

Important framing: an API3 signature proves **who said what, and when** (and that the data wasn't changed). It does NOT prove the content is true. We never claim it does.

## System flow
```
 OWNER (BSV Desktop) ── funds ──▶ VAULT on BSV mainnet
                                  script: (agent AND watcher) OR owner   ← owner can always exit alone
                                       │
 TRADING/TREASURY AGENT (loop every 10 min)
   ① buys the signed BSV/USD price via x402 (CoinPaprika Airnode, $0.001 in aUSD)
   ② (if a whitelisted account posted) buys the signed post via x402 (TwitterAPI.io Airnode, $0.01)
      and pays the ANALYST AGENT in sats on BSV via HTTP 402 → signed verdict
   ③ submits to TREASURYGUARD.sol on Base Sepolia → contract verifies + creates an INTENT
        SPEND  : move ≤ (usdAmount / signed price) sats from vault to the agent's float wallet
        SWAP   : hedge sats→dUSD or re-enter dUSD→sats, size ≤ cap, rate within the signed price band
   ④ WATCHER reads the intent on Base and co-signs ONLY a BSV tx that matches it
   ⑤ SWAP: the agent fills an open LP offer (pre-signed SIGHASH_SINGLE|ANYONECANPAY) → atomic swap
   ⑥ the agent pays services from its float wallet in sats (HTTP 402); the BSV tx carries an
      OP_RETURN with intentId + Base tx hash; the agent calls settle(intentId, bsvTxid) on Base
```

## Why both parts are indispensable
- **Without API3, nothing moves.** No verified price → no intent → the watcher doesn't co-sign → the vault can only be exited by the owner. The dollar budget can't even be computed without a trusted BSV/USD price.
- **Without BSV, nothing settles.** There is no sats float, no stablecoin, no swap, no agent payment. The contract only authorizes, it cannot pay.
- **Why two chains:** verifying API3 signatures needs keccak + ecrecover, which is cheap only on an EVM chain. Sub-cent payments and settlement are cheap only on BSV. Each chain does what it's best at.
- **Base contract = the shared, public source of truth** for the agent, watchers, LPs and auditors: every move can be checked against signed evidence.

## API3 part: `TreasuryGuard.sol` (Base Sepolia, `api3/`, Foundry)
**Owner config per vault:**
- daily USD budget;
- Airnode signers and allowed request hashes: BSV/USD price, plus one per whitelisted account;
- max signature age (5 min) and max post age (30 min);
- breaker threshold, re-entry threshold, cooldown;
- tier-B cap (25 %), slippage band.

**`submitPrice(priceResponse, usdAmount)`, one entry point for jobs 1 + 2**
- Checks: signer = expected Airnode; `requestHash` = BSV/USD request; signature age ≤ max; `timestamp > lastPriceTimestamp` (replay protection, newer-than-last).
- **Budget rule, must be implemented exactly like this:**
  - `usdAmount ≤ remainingUsdToday`, and `remainingUsdToday -= usdAmount` **at intent creation**.
  - Intent `SPEND{maxSats = usdAmount / price, expiry 15 min}`.
  - The budget is never reset by a new price, otherwise every fresh price would mean unlimited spending.
  - Unused intents are not refunded (conservative and simple; the agent requests small chunks).
  - The daily window resets once per day.
- **Breaker:**
  - If `percent_change_1h ≤ threshold` and the regime is `NORMAL` and the cooldown has passed → regime `RISK_OFF` + `SWAP` intent (sats→dUSD, band = price ± slippage).
  - Re-entry (dUSD→sats) only if the regime is `RISK_OFF`, the signed change is ≥ the re-entry threshold, and the cooldown has passed.

**`submitEvent(tweetResponse, priceResponse, verdict, analystSig)`, job 3**
- Same checks for both responses.
- Post age is derived from the tweet id (Snowflake: `((id >> 22) + 1288834974657) / 1000` s, `postTime ≤ now + 60`). The id must arrive as a JSON string.
- Replay key: the tweet id, per vault.
- Effect: regime `GUARDED` + `SWAP` intent capped at 25 % (`maxBps`).
- P2: ecrecover the Analyst's signature over `(tweetId, verdict, vault, nonce)`. Fallback: store only the verdict hash.

**Errors (distinct, shown in the tamper demo):** `SignerMismatch`, `WrongRequest`, `StaleSignature`, `StalePost`, `Replay`, `BudgetExceeded`, `Cooldown`.

**Events and views:**
- Events:
  - `IntentCreated(intentId, vault, kind, direction, maxSats, maxBps, minOut, maxOut, expiry, price, priceSignedAt, source)`
  - `RegimeChanged(vault, regime)`
  - `Settled(intentId, bsvTxid)`
- Views: `getIntent(intentId)`, `remainingUsdToday(vault)`, `regime(vault)`.

**Tamper test (live, valid case = budget top-up, no loosened thresholds):**
- 1 valid fresh price → SPEND intent created.
- Then rejected:
  - one digit of the price edited → `SignerMismatch`;
  - too old → `StaleSignature`;
  - ETH/USD response instead of BSV/USD → `WrongRequest`;
  - signed by a local key → `SignerMismatch`.
- Extras: the same response again → `Replay`; an old post with a fresh signature → `StalePost`.

**Also in `api3/`:** a judge script (fetch → submit → decoded revert reason), a small TS client, and `deployments.json` that the BSV side imports.

## BSV part (TypeScript, ts-stack, BSV mainnet; develop and test scripts on testnet first)
- **Vault:** custom locking script `IF <agent> CHECKSIGVERIFY <watcher> CHECKSIG ELSE <owner> CHECKSIG ENDIF`. The owner funds it from BSV Desktop (WalletClient `createAction`, the standard-wallet requirement). Fallback: a standard 2-of-3 multisig.
- **Watcher:** stateless and holds no funds. It reads intents from Base over RPC and co-signs only a tx that matches:
  - SPEND: ≤ maxSats to the agent float wallet;
  - SWAP: size ≤ maxBps of the vault and rate inside minOut/maxOut;
  - in both cases: not expired, and the intent not used before.

  It can only block, never take. Anyone can run one (m-of-n on the roadmap).
- **LPs:** post pre-signed dUSD offers (`SIGHASH_SINGLE|ANYONECANPAY`, short expiry; the LP cancels by spending its input). Anyone can be an LP, and an LP can't veto after posting.
- **dUSD:** demo stablecoin; the issuer is a stated trust point. P2: PushDrop token. Fallback: a simple issuer-signed output.
- **Agent float wallet:** a normal wallet the agent uses to pay services via HTTP 402 (`@bsv/payment-express-middleware`, BRC-121).
- **Analyst agent:** a pay-per-call service (402, sats) that returns a signed verdict.
- **Settlement txs** carry an OP_RETURN with intentId + Base tx hash.
- **Log page:** cycles, regime, remaining USD budget, BaseScan + WhatsOnChain links.

## Agent loop
- Runs every 10 min, with a cache:
  1. Buy the signed price.
  2. Request a SPEND intent if the float is low.
  3. Check whitelisted accounts for new posts; for a new post, pay the analyst and call `submitEvent`.
  4. For any SWAP intent: fill an LP offer, get the watcher's co-signature, broadcast, `settle`.
- **Limits:** daily aUSD cap for data, USD budget on-chain, per-cycle cap.
- **Failures:** a revert, expired intent or quota error is logged and the cycle is skipped. Backoff, never tight retries. Non-firing cycles ("no new post, no action") are logged too: they show the repeated autonomous cycles judges look for.

## Real vs demo (say this openly)
- **Real:** Base Sepolia contract, Airnode signatures, x402 payments, BSV mainnet transactions (tiny amounts), agent payments.
- **Demo:**
  - dUSD is not redeemable.
  - One team-run LP and one watcher (open source, anyone can run one).
  - A labeled team demo X account next to the official accounts. A real @WhiteHouse cycle is pre-recorded.
  - The circuit breaker firing is shown from a recorded real event. We never loosen thresholds to force it.

## Priorities and cut lines (~22 h)
**Hour-0 spike, first 2 h:**
- CoinPaprika `getTickersById` with id `bsv-bitcoin-sv`: can `quotes.USD.price` and `quotes.USD.percent_change_1h` be projected? Are negative decimals readable on-chain (ProjectedJson `readInt`)?
- TwitterAPI.io `userLastTweets`: the exact JSON path; is index 0 the newest post and not a pinned one; is there a retweet flag; does the id come as a string?
- Do Wallet Toolbox + payment middleware work (testnet for development, then mainnet)?
- Does a custom unlocking template work?

**Plan:**
- **P0, by Fri 24:00:**
  - API3: `submitPrice` (budget + breaker), tamper tests, judge script, deploy and verify.
  - BSV: agent 402 payment, LP-offer atomic swap, owner funding via BSV Desktop.
- **P1, by Sat 06:00:** vault script + watcher co-sign, x402 agent loop, `submitEvent`.
- **P2:** PushDrop dUSD, analyst ecrecover, a second price source (CoinGecko) as a cross-check.

**Cut lines:**
- Vault script not working by Sat 06:00 → 2-of-3 multisig.
- Swap not working by Sat 02:00 → sats-only + OP_RETURN settlement.
- Tier B not done → ship price-only.

## Interface between the BSV side and the API3 side (agree before deploy!)
The events and views listed above, `deployments.json` and the TS client in `api3/`. No BSV logic in Solidity, no BSV code in `api3/`.

## Working rules for everyone
- BSV mainnet holds real money: tiny amounts only, separate wallets per role, test on testnet before mainnet. Never print, log or commit private keys or RPC keys. `.env*` files are gitignored.
- Code, comments, docs and everything team-facing in English.
- Commit small and often, only your own files. `git pull --rebase` before push, never force-push, never `git add -A` at the repo root.
- Keep a working demo at all times. Risky changes only on top of a green state.
