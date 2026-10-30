# Results

Revision: see `git log -- bsv` (branch `feat/bsv-treasury-guard`), checked 2026-10-30, Europe/Berlin.
Networks: **BSV mainnet** (money) | **Base Sepolia testnet** (decisions). Mock chain for offline tests.
"0-conf" means broadcast and visible on WhatsOnChain, not yet seen in a block at the time of writing.

| Item | Value |
| --- | --- |
| API3 contract | `0x8e38cc6B1Bd1f0D25357066cd0036f28fd1f7773` (Base Sepolia 84532), Base vault ID 5 |
| Vault 5 on Base (read 30 Oct ~17:00) | budget $1/day, $1 remaining, TTL 900 s, **no price and no intent yet** |
| Intents on the contract (read 30 Oct ~17:15) | only #1 (retired vault 2, 5,856,771 sats for $1): the watcher refuses it (live test) |
| BSV vault script | `63210234a2…3fad` (`docs/evidence/gate1.json`), binding `tg-vault-vault-5-v1-2026-10-30` |
| Agent Float script | `76a91419e272af3877858a136f6b5a9c67a390bb13b7e088ac` |

## Live on BSV mainnet

| Step | Txid | Detail |
| --- | --- | --- |
| Gate 2a: owner funds vault (exit proof) | [`cdcbf706…e81f`](https://whatsonchain.com/tx/cdcbf706af70c65ecc04b65c3b9ddfecc6626a9cda3088a5312afcebc541e81f) | 3,000 sats to the exact vault script, BSV Desktop |
| Gate 2a: **owner-only exit** | [`db5ca41c…d41e`](https://whatsonchain.com/tx/db5ca41c82c4506f66614193b6c2ccf5b84f3d7afffcda4f1a588b09edf7d41e) | spends the vault UTXO via `<ownerSig> OP_0`; 2,960 sats back to BSV Desktop; fee 40 sats; 1.7 s; no agent, no watcher, no Base tx |
| Gate 2b: owner funds vault (spend demo) | [`c1f97102…6ad4`](https://whatsonchain.com/tx/c1f971027a2f0015a19c5945a48adf1282d5b1bb9cf8ab3f4e16d7574e246ad4) | 5,000 sats, unspent at the time of writing |
| HTTP 402 purchase by the agent wallet | [`43c8255e…9b77`](https://whatsonchain.com/tx/43c8255e63ab363f9d3641a601e74aee5ea95b5d53b747fcc86c40d71e959b77) | `@bsv/402-pay` 0.3.3 + `withHostOriginator`; HTTP 200; merchant +1,000 sats exactly; guardian approved the declared purchase; 857 ms from request to answer; local demo merchant, real mainnet payment. Paid from the agent's existing balance, **not** yet from a vault withdrawal |
| Vault withdrawal for a Base SPEND | **NOT RUN yet**: waiting for a fresh SPEND intent on vault 5 from the API3 owner | |
| `settle(intentId, 0x…)` on Base | **NOT RUN** (needs the withdrawal) | |
| Atomic swap-and-pay | [`ee2a3896…8e8c`](https://whatsonchain.com/tx/ee2a38964df993af6cd48f5f51d1ce0c07c7bf454363735341288d7f71bf8e8c) | rail baseline, earlier on 30 Oct: 1,000 sats to the maker, 1 pUSD to the merchant, fee 66, one tx. Price was a fixed 1,000 sats; the signed-rate `executeSwap` wrapper is **offline only** |

## Gate (1), exact mainnet script, offline: PASS 12/12

Real key holders (agent server wallet, watcher key, BSV Desktop as owner); nothing broadcast to
mainnet. agent+watcher OK; agent-only, watcher-only, agent/watcher on the owner branch, owner on
the cosign branch: all fail; change goes back to the vault script; the policy approves; owner-only
exit OK; mock chain accepts both the cosigned spend and the owner exit. See `gate1.json`.

## Offline tests: 56/56 pass (`npm test`), plus 2 live Base reads (`LIVE_BASE=1`)

Negative proofs, all before the watcher signs: overspend (fee counted), wrong recipient, extra
payee, change to agent, fee cap, expired and inside-margin, settled, SWAP, wrong chain, contract
or vault (6, 7, retired), missing or forged receipt, RPC failure, non-vault input, UTXO reuse,
duplicate intent across a restart, corrupted journal. Swap wrapper: wrong asset, inflated amount,
changed maker payment, price above the signed rate, stale rate, swapped merchant key, forged
invoice, expired invoice and offer, replay, fake ancestry, overlay offline, moved output 0,
insufficient sats.

## Mocks, trust, not verified

- Mocked: the SPEND intent in `integration-mock.test.ts` and `watcher-policy.test.ts` (shape and
  values as `getIntent` returns them); the swap's signed rate ($20.00 fixture) in `execute-swap.test.ts`.
- The paid API is a local demo merchant serving a deterministic note, not external data.
- Watcher and agent ran in one CLI process with separate keys (see SAFETY_AND_TRUST.md).
- No confirmations claimed: all mainnet txs above were 0-conf when recorded.
- "One transaction instead of two" for swap-and-pay is a structural property; no fee saving is claimed.
