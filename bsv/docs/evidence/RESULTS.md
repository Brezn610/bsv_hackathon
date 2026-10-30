# Results

**End to end, live:** API3 signed price → SPEND intent 2 on Base Sepolia → watcher checks and co-signs → BSV mainnet vault → Agent Float withdrawal → `settle` on Base. The HTTP 402 payment and the owner-only exit are also live on mainnet.

Revision: see `git log -- bsv` (branch `feat/bsv-treasury-guard`), checked 2026-10-30, Europe/Berlin.
Networks: **BSV mainnet** (money) | **Base Sepolia testnet** (decisions). Mock chain for offline tests.
"0-conf" means broadcast and visible on WhatsOnChain, not yet seen in a block at the time of writing.

| Item | Value |
| --- | --- |
| API3 contract | `0x8e38cc6B1Bd1f0D25357066cd0036f28fd1f7773` (Base Sepolia 84532), Base vault ID 5 |
| Vault 5 on Base | budget $1/day, TTL 900 s; SPEND **intent 2** created by the API3 agent at ~17:37 Berlin ([Base tx](https://sepolia.basescan.org/tx/0x0aa95a723942c63e0463ea8730e4cb2baf8f76ac272b98915c31b8f0130afc90)): `maxSats` 2,896, expiry 16:52:17 UTC |
| Intents on the contract (read 30 Oct ~17:15) | only #1 (retired vault 2, 5,856,771 sats for $1): the watcher refuses it (live test) |
| BSV vault script | `63210234a2…3fad` (`docs/evidence/gate1.json`), binding `tg-vault-vault-5-v1-2026-10-30` |
| Agent Float script | `76a91419e272af3877858a136f6b5a9c67a390bb13b7e088ac` |

## Live on BSV mainnet

| Step | Txid | Detail |
| --- | --- | --- |
| Gate 2a: owner funds vault (exit proof) | [`cdcbf706…e81f`](https://whatsonchain.com/tx/cdcbf706af70c65ecc04b65c3b9ddfecc6626a9cda3088a5312afcebc541e81f) | 3,000 sats to the exact vault script, BSV Desktop |
| Gate 2a: **owner-only exit** | [`db5ca41c…d41e`](https://whatsonchain.com/tx/db5ca41c82c4506f66614193b6c2ccf5b84f3d7afffcda4f1a588b09edf7d41e) | spends the vault UTXO via `<ownerSig> OP_0`; 2,960 sats back to BSV Desktop; fee 40 sats; 1.7 s; no agent, no watcher, no Base tx |
| Gate 2b: owner funds vault (spend demo) | [`c1f97102…6ad4`](https://whatsonchain.com/tx/c1f971027a2f0015a19c5945a48adf1282d5b1bb9cf8ab3f4e16d7574e246ad4) | 5,000 sats; mined in block 973333 |
| HTTP 402 purchase by the agent wallet | [`43c8255e…9b77`](https://whatsonchain.com/tx/43c8255e63ab363f9d3641a601e74aee5ea95b5d53b747fcc86c40d71e959b77) | `@bsv/402-pay` 0.3.3 + `withHostOriginator`; HTTP 200; merchant +1,000 sats exactly; guardian approved the declared purchase; 857 ms from request to answer; local demo merchant, real mainnet payment. Paid from the agent's existing balance, **not** yet from a vault withdrawal |
| **Vault withdrawal for Base intent 2** | [`ae35d469…dcf5`](https://whatsonchain.com/tx/ae35d46939d7fd7f79ff32aab1d6bdc906d28a18da93cce3950c013ccc91dcf5) | watcher re-read intent 2 at Base block 52281922 and APPROVED; spends vault UTXO `c1f97102…:0` (5,000) with agent + watcher signatures: 2,796 to the Agent Float, 2,162 change back to the same vault script, `OP_RETURN "TGv1 84532 0x8e38… 5 2"`; fee 42; vault outflow 2,838 ≤ maxSats 2,896; 1,045 ms from intent read to broadcast; the float took it in (agent balance 20,707). A second `withdraw --intent 2` was refused: "journal already holds this intent as broadcast" |
| **`settle(2, 0xae35d469…dcf5)` on Base Sepolia** | [`0xc1a8c9bb…e5b8`](https://sepolia.basescan.org/tx/0xc1a8c9bb236698e05a51293e337369ab9ea6284b97d863e0a66257c2844de5b8) | sent by the vault-5 agent `0x0310dCF1…4cf0`, block 52283537, status success; `Settled(intentId 2, bsvTxid 0xae35d469…dcf5)`. Independently re-read by the BSV side: `getIntent(2).settled = true`, `bsvTxid` equals the BSV withdrawal txid. A recorded claim by the agent, not a cross-chain proof |
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
- Confirmations: funding `cdcbf706`, `c1f97102` (block 973333) and the owner exit `db5ca41c` had 1 confirmation at 17:27; the 402 payment and the withdrawal were 0-conf when recorded.
- The HTTP 402 payment `43c8255e` was made before the withdrawal, from the agent's existing balance; the withdrawn sats are now in the same agent wallet.
- "One transaction instead of two" for swap-and-pay is a structural property; no fee saving is claimed.
