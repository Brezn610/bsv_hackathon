# Demo runbook

Prereqs: Node ≥ 22, `cd bsv && npm ci`. BSV Desktop open and unlocked (in WSL2: mirrored
networking, fact 31). For mainnet steps: `export TG_ENV_FILE=…/rail/.env TG_DATA_DIR=…/rail/data`.

## 0. Offline proof (no money, ~10 s)

```sh
npm test                    # 64 offline tests (2 live ones skipped)
LIVE_BASE=1 npx tsx --test test/api3-readonly.test.ts   # live reads of vault 5; intent #1 (vault 2) refused
```

## 1. Base Sepolia testnet decides (API3 owner)

API3 agent buys a fresh signed BSV/USD price and calls `submitPrice(5, price, usd(0.0005))`
(snippet in INTEGRATION.md). Show the `IntentCreated` event on sepolia.basescan.org. Note the
`intentId`. TTL is 900 s.

## 2. BSV mainnet moves the money (BSV side)

```sh
npm run tg -- watcher-serve                            # terminal 1: the watcher, its own process on 127.0.0.1:4810
curl -s http://127.0.0.1:4810/health                   # binding, keys (public), excluded vaults, clock skew
npm run tg -- status                                   # terminal 2: vault UTXO unspent on chain
CONFIRM_MAINNET=1 npm run tg -- withdraw --intent N    # watcher re-reads intent N, checks the tx, cosigns; broadcast; float takes it in
```

Prints the WhatsOnChain link and `settle(N, 0x…)`. Hand that to the API3 owner, who calls
`settle` and shows the `Settled` event.

## 3. The float buys something

```sh
CONFIRM_MAINNET=1 npm run tg -- buy     # local paid API; real BSV mainnet payment over HTTP 402, guardian-approved
```

## 4. Refusals (show live, no money)

- `withdraw --intent N` again → `Watcher refused: journal already holds this intent as broadcast`.
  Over HTTP the watcher answers 409 for that, 422 for a policy refusal (e.g. intent 3, vault 8), 403 for a forged agent
  signature; `curl -s http://127.0.0.1:4810/decisions` lists every decision.
- `npx tsx --test test/watcher-policy.test.ts` → overspend, wrong recipient, change leakage,
  expired, judge vaults 6/7, SWAP: all DENY before any signature.

## 5. Owner exit

Already proven on mainnet before the spend (RESULTS.md). To recover the remaining change:
`CONFIRM_MAINNET=1 npm run tg -- exit` (BSV Desktop alone).

## 6. DeFi: atomic swap-and-pay

Mainnet proof from the rail: `ee2a38964df993af6cd48f5f51d1ce0c07c7bf454363735341288d7f71bf8e8c`
(one transaction: 1,000 sats to the maker at output 0, 1 pUSD to the merchant at output 1). It
was priced at a fixed 1,000 sats, before the signed-rate quote existed. The signed-rate wrapper
`executeSwap` is shown offline: `npx tsx --test test/execute-swap.test.ts`.

## Video outline (≤ 2:30)

0:00 problem → 0:20 API3 signed price → SPEND intent (Basescan) → 0:45 watcher checks the
real tx, vault pays float (WhatsOnChain) → 1:15 float pays the 402 API → 1:45 refusals plus the owner-exit
tx → 2:10 numbers (tx count, fees, latency) and trust assumptions.
