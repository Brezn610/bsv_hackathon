# Results

**End to end, live:** API3 signed price → SPEND intent on Base Sepolia → watcher checks and co-signs → BSV mainnet vault → Agent Float → the agent's model (DeepSeek) decides → guardian → HTTP 402 payment that spends exactly the withdrawn sats. Intents 2, 4 and 5 each completed `settle` on Base; intent 5 ran through the separate watcher process. The owner-only exit is live on mainnet too.

Revision: see `git log -- bsv` (branch `feat/bsv-treasury-guard`), checked 2026-10-30, Europe/Berlin.
Networks: **BSV mainnet** (money) | **Base Sepolia testnet** (decisions). Mock chain for offline tests.
"Mined" means seen in a block on WhatsOnChain. Every BSV mainnet transaction below was mined by 18:01 Berlin.

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
| Gate 2a: owner funds vault (exit proof) | [`cdcbf706…e81f`](https://whatsonchain.com/tx/cdcbf706af70c65ecc04b65c3b9ddfecc6626a9cda3088a5312afcebc541e81f) | 3,000 sats to the exact vault script, BSV Desktop; mined in block 973333 |
| Gate 2a: **owner-only exit** | [`db5ca41c…d41e`](https://whatsonchain.com/tx/db5ca41c82c4506f66614193b6c2ccf5b84f3d7afffcda4f1a588b09edf7d41e) | spends the vault UTXO via `<ownerSig> OP_0`; 2,960 sats back to BSV Desktop; fee 40 sats; 1.7 s; no agent, no watcher, no Base tx; mined in block 973333 |
| Gate 2b: owner funds vault (spend demo) | [`c1f97102…6ad4`](https://whatsonchain.com/tx/c1f971027a2f0015a19c5945a48adf1282d5b1bb9cf8ab3f4e16d7574e246ad4) | 5,000 sats; mined in block 973333 |
| HTTP 402 purchase by the agent wallet | [`43c8255e…9b77`](https://whatsonchain.com/tx/43c8255e63ab363f9d3641a601e74aee5ea95b5d53b747fcc86c40d71e959b77) | `@bsv/402-pay` 0.3.3 + `withHostOriginator`; HTTP 200; merchant +1,000 sats exactly; guardian approved the declared purchase; 857 ms from request to answer; local demo merchant, real mainnet payment. Paid from the agent's existing balance, **not** from the vault withdrawal; mined in block 973334 |
| **Vault withdrawal for Base intent 2** | [`ae35d469…dcf5`](https://whatsonchain.com/tx/ae35d46939d7fd7f79ff32aab1d6bdc906d28a18da93cce3950c013ccc91dcf5) | watcher re-read intent 2 at Base block 52281922 and APPROVED; spends vault UTXO `c1f97102…:0` (5,000) with agent + watcher signatures: 2,796 to the Agent Float, 2,162 change back to the same vault script, `OP_RETURN "TGv1 84532 0x8e38… 5 2"`; fee 42; vault outflow 2,838 ≤ maxSats 2,896; 1,045 ms from intent read to broadcast; the float took it in (agent balance 20,707); mined in block 973334. A second `withdraw --intent 2` was refused: "journal already holds this intent as broadcast" |
| **`settle(2, 0xae35d469…dcf5)` on Base Sepolia** | [`0xc1a8c9bb…e5b8`](https://sepolia.basescan.org/tx/0xc1a8c9bb236698e05a51293e337369ab9ea6284b97d863e0a66257c2844de5b8) | sent by the vault-5 agent `0x0310dCF1…4cf0`, block 52283537, status success; `Settled(intentId 2, bsvTxid 0xae35d469…dcf5)`. Independently re-read by the BSV side: `getIntent(2).settled = true`, `bsvTxid` equals the BSV withdrawal txid. A recorded claim by the agent, not a cross-chain proof |
| **Vault withdrawal for Base intent 4** (float wallet) | [`452a42b4…a31f`](https://whatsonchain.com/tx/452a42b4bf518451c9c4f48a270af892b5b2adb74b64ac8a76bbd5319285a31f) | intent 4 (`maxSats` 2,902; [created on Base](https://sepolia.basescan.org/tx/0xca48d1b12f24c7a093002e6ed465ec9ceb823b659b929aa3e1e26f57c6eaaca8)) re-read at Base block 52298837 and APPROVED; spends the vault change `ae35d469…:1` (2,162): 2,062 to the dedicated float wallet, 58 back to the same vault script, receipt `TGv1 84532 … 5 4`; fee 42; outflow 2,104 ≤ 2,902. (Intent 3 was created on vault 8, the API3 runner, and was ignored.) |
| **`settle(4, 0x452a42b4…a31f)` on Base Sepolia** | [`0x793e7f26…c980`](https://sepolia.basescan.org/tx/0x793e7f26270e8a688239a42128cfa4916842d27c6309f5beaf6bb9dca3ffc980) | sent by the vault-5 agent, block 52301453, status success; `Settled(4, 0x452a42b4…)`; re-read by the BSV side: `getIntent(4).settled = true`, `bsvTxid` equals the withdrawal txid |
| **Agent pays HTTP 402 with the withdrawn sats** | [`54082a71…b320`](https://whatsonchain.com/tx/54082a714816ce2e9b2a67c23c5e04da67c2f93b8df30136b7126b715802b320) | DeepSeek decided BUY ("the offer directly matches the task topic and its 1000-sat price is within both the float balance and the per-payment cap"); guardian (rules) approved; the only input is `452a42b4…:0`, the float output of the intent-4 withdrawal; 1,000 sats to the merchant, 1,039 change to the float, fee 23; HTTP 200 in 1,002 ms |
| Owner funds the vault with 30,000 sats (cap raised to 50,000 after the exit proof) | [`f4c561d1…165f`](https://whatsonchain.com/tx/f4c561d1405de54fa4559b9742cdcbae33d317c99c0da933aa73f8766aa7165f) | BSV Desktop |
| **Vault withdrawal for intent 5 through the separate watcher process** | [`85b74fb5…0002`](https://whatsonchain.com/tx/85b74fb5c959f7f239d854ac89d292b932cac4aa243801aa0e1815f8fe020002) | `tg watcher-serve` on 127.0.0.1:4810 answered 200 APPROVE (`docs/evidence/watcher-decisions-intent-5.json`); intent 5 (`maxSats` 5,881 = $0.001 at $17.0018550/BSV; [created on Base](https://sepolia.basescan.org/tx/0xd2811a220acbe675fb0baf05b4676d23b4b1fe02ff2fa98149d86bec73cf65df)) re-read at Base block 52337835; inputs `452a42b4…:1` (58) and `f4c561d1…:0` (30,000); 5,781 to the float wallet, 24,216 back to the vault, receipt `TGv1 84532 … 5 5`; fee 61; outflow 5,842 ≤ 5,881. The CLI did not load the watcher key |
| **`settle(5, 0x85b74fb5…0002)` on Base Sepolia** | [`0xe0a80a66…c33f`](https://sepolia.basescan.org/tx/0xe0a80a66b80bdb9138837cf9d079ade0495b6c4aaa9a49d1a01e3947a434c33f) | block 52339416; `Settled(5, 0x85b74fb5…)`; re-read by the BSV side: `getIntent(5).settled = true`, `bsvTxid` matches. BSV txs `85b74fb5`, `6cf0ff26` mined in block 973355 |
| Agent pays HTTP 402 from that withdrawal | [`6cf0ff26…6134`](https://whatsonchain.com/tx/6cf0ff26409e0173d663ad2893a4e3d24306defd9fa81a01882d64de3d2a6134) | DeepSeek BUY; guardian approved; only input `85b74fb5…:0`; 1,000 sats to the merchant, 4,758 change to the float; HTTP 200 |
| Refusals over HTTP, no money moved | — | `withdraw --intent 5` again → 409 "journal already holds this intent as broadcast"; `withdraw --intent 3` (vault 8, expired) → 422 |
| Atomic swap-and-pay | [`ee2a3896…8e8c`](https://whatsonchain.com/tx/ee2a38964df993af6cd48f5f51d1ce0c07c7bf454363735341288d7f71bf8e8c) | rail baseline, earlier on 30 Oct: 1,000 sats to the maker, 1 pUSD to the merchant, fee 66, one tx. Price was a fixed 1,000 sats; the signed-rate `executeSwap` wrapper is **offline only** |

## Gate (1), exact mainnet script, offline: PASS 12/12

Real key holders (agent server wallet, watcher key, BSV Desktop as owner); nothing broadcast to
mainnet. agent+watcher OK; agent-only, watcher-only, agent/watcher on the owner branch, owner on
the cosign branch: all fail; change goes back to the vault script; the policy approves; owner-only
exit OK; mock chain accepts both the cosigned spend and the owner exit. See `gate1.json`.

## Offline tests: 65/65 pass (`npm test`), plus 2 live Base reads that pass with `LIVE_BASE=1`

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
- The mainnet withdrawals for intents 2 and 4 ran with the in-process watcher (same CLI process, separate key file). Intent 5 ran through the separate watcher process (`tg watcher-serve`, HTTP on 127.0.0.1), on the same machine.
- Blocks: `cdcbf706`, `db5ca41c`, `c1f97102` in 973333; `43c8255e`, `ae35d469` in 973334 (checked 18:01 Berlin); `452a42b4`, `54082a71` in 973339 (checked 18:55 Berlin).
- The first HTTP 402 payment `43c8255e` came from the agent's existing balance. The second, `54082a71`, spends the intent-4 withdrawal output directly (dedicated float wallet).
- "One transaction instead of two" for swap-and-pay is a structural property; no fee saving is claimed.

## Final report (spec §11), 30 Oct 2026, 18:05 Berlin

**COMPLETED**
- `bsv/` workspace in the team repo; no change outside `bsv/` (PR #2).
- Vault script, owner-only exit, agent+watcher co-signing; gates (1) and (2) passed in order.
- Read-only API3 adapter for vault 5 (chain check, tip − 1 read, judge/retired vaults excluded).
- Watcher policy on the real transaction bytes, journal with fsync + rename + checksum.
- Live loop: signed price → intent 2 on Base → co-signed vault withdrawal on BSV mainnet → `settle(2)` on Base, verified from both sides.
- Live loop with the agent's model: intent 4 → withdrawal `452a42b4` into the float wallet → DeepSeek BUY → guardian → HTTP 402 `54082a71`, whose only input is the withdrawal's float output → `settle(4)` on Base, verified from both sides.
- Same loop through the separate watcher process (`tg watcher-serve`, HTTP): intent 5 → `85b74fb5` → HTTP 402 `6cf0ff26` → `settle(5)`; refusals over HTTP: 409 (intent 5 replayed), 422 (intent 3, vault 8).
- Sats HTTP 402 payment on mainnet; `executeSwap` safety wrapper with negative tests.
- INTEGRATION, SAFETY_AND_TRUST, DEMO_RUNBOOK, RESULTS, SUBMISSION docs.

**NOT_COMPLETED**
- The signed-rate swap (`executeSwap`) has not run on mainnet; the mainnet swap `ee2a3896` used a fixed price.
- The separate watcher process runs on the same machine as the agent, not on a separate host.
- No automatic intent subscription service: `tg withdraw --intent N` and `tg buy` are one repeatable CLI cycle, and the API3 owner calls `settle` by hand.
- Agent and watcher keys are on one machine run by one operator; the owner exit protects the owner, but the two spending keys are not yet held by independent parties.
- Demo video and organizer confirmation of the pre-event code rules.

**TESTED**: 65/65 offline tests, 2/2 live Base reads, `tsc` clean, gate (1) 12/12 on the exact mainnet script.

**LIVE VERIFIED**: every transaction in the tables above, checked on WhatsOnChain and Basescan; `getIntent(2)`, `getIntent(4)` and `getIntent(5)` read back after `settle`.

**BLOCKERS**: none for the BSV side. PR #1 (API3) must merge before PR #2 is retargeted to `main`.

**RISK**: one watcher (liveness only, the owner exit is proven); the vault holds 24,216 sats (change output `85b74fb5…:1`, checked 30 Oct 21:00), recoverable by the owner with `tg exit`; local `bsv/data/` (vault UTXO BEEF, journal) is not in git and should be backed up.

**NEXT ACTION**: merge PR #1 → retarget PR #2; record the video; submit with `docs/SUBMISSION.md`; optionally `tg exit` after judging.

**FILES**: `bsv/src/{vault,watcher,api3,agent,flow,swap/executeSwap.ts,merchant/{paidApi,signedInvoice}.ts,chain/wocUtxos.ts,wallet/originator.ts}`, `bsv/scripts/tg.ts`, `bsv/test/*.test.ts`, `bsv/docs/*`.

**COMMANDS**: `npm ci && npm test && npm run typecheck`; `LIVE_BASE=1 npm test`; `npm run tg -- watcher-key|float-key|rebind-float|init|gate|fund|exit|status|watcher-serve|withdraw|buy`.

**TX LINKS**: see the tables above.
