# Devfolio submission text

Paste-ready sections. Every claim links to something a judge can open.

---

## Project name

Treasury Guard

## Tagline

A dollar budget for AI agents that pay in sats. Base Sepolia decides, BSV mainnet moves the money, and the owner can always exit alone.

## The problem it solves

AI agents are starting to pay for things themselves: APIs, data, compute. Handing an agent a wallet key is a blank cheque. A prompt injection or a bug can drain it. Owners think in dollars, not in sats, and they need a hard limit that the agent cannot talk its way around.

Treasury Guard gives the agent freedom to act, but not unlimited freedom to spend:

- The owner's sats sit in a **BSV vault script** that only **agent + watcher together** can spend, and that the **owner can always spend alone**.
- A **daily USD budget** lives in a contract on **Base Sepolia**. The contract turns a **signed API3 BSV/USD price** into a SPEND intent with a hard `maxSats`.
- An independent **watcher** reads that intent from Base and co-signs **one** BSV withdrawal per intent. It does this only if the actual transaction pays the registered Agent Float no more than `maxSats` (fee included) and returns the rest to the same vault.
- The agent spends its float on **HTTP 402 pay-per-request APIs**, behind a guardian (merchant allowlist, declared price, caps).
- For merchants that want a token, the **atomic swap-and-pay** rail converts sats to a token and pays the merchant in **one** transaction, priced from the signed rate.

The invariant: an API3 intent alone cannot move money, and no BSV transaction can move money out of the vault unless that intent authorises it or the owner is exiting.

## How it works (end to end, live on 30 Oct 2026)

| Step | Network | Proof |
| --- | --- | --- |
| Owner funds the vault, then exits **alone** (safety gate before anything else) | BSV mainnet | [cdcbf706…](https://whatsonchain.com/tx/cdcbf706af70c65ecc04b65c3b9ddfecc6626a9cda3088a5312afcebc541e81f) → [db5ca41c…](https://whatsonchain.com/tx/db5ca41c82c4506f66614193b6c2ccf5b84f3d7afffcda4f1a588b09edf7d41e) |
| Owner funds the vault with 5,000 sats | BSV mainnet | [c1f97102…](https://whatsonchain.com/tx/c1f971027a2f0015a19c5945a48adf1282d5b1bb9cf8ab3f4e16d7574e246ad4) |
| Agent buys a signed BSV/USD price (API3 Airnode, CoinPaprika, paid via x402) and creates SPEND intent 2: `maxSats` 2,896 | Base Sepolia | [0x0aa95a72…](https://sepolia.basescan.org/tx/0x0aa95a723942c63e0463ea8730e4cb2baf8f76ac272b98915c31b8f0130afc90) |
| Watcher re-reads intent 2, checks the raw transaction and co-signs. 2,796 sats go to the Agent Float, 2,162 return to the vault, OP_RETURN receipt, fee 42 | BSV mainnet | [ae35d469…](https://whatsonchain.com/tx/ae35d46939d7fd7f79ff32aab1d6bdc906d28a18da93cce3950c013ccc91dcf5) |
| Agent records the BSV txid with `settle(2, txid)`. Read back: `settled = true` | Base Sepolia | [0xc1a8c9bb…](https://sepolia.basescan.org/tx/0xc1a8c9bb236698e05a51293e337369ab9ea6284b97d863e0a66257c2844de5b8) |
| Agent pays an HTTP 402 API (1,000 sats, HTTP 200 in 857 ms) | BSV mainnet | [43c8255e…](https://whatsonchain.com/tx/43c8255e63ab363f9d3641a601e74aee5ea95b5d53b747fcc86c40d71e959b77) |
| Atomic swap-and-pay: 1,000 sats to the maker and 1 pUSD to the merchant, in one tx | BSV mainnet | [ee2a3896…](https://whatsonchain.com/tx/ee2a38964df993af6cd48f5f51d1ce0c07c7bf454363735341288d7f71bf8e8c) |

A second withdrawal for intent 2 was refused live: `journal already holds this intent as broadcast`.

## Tech stack

- **BSV:** `@bsv/sdk` 3.2.1 (custom vault script, `Spend` interpreter, BEEF/SPV), `@bsv/wallet-toolbox` 2.14.9 (server wallets, `WalletPermissionsManager` guardian), BSV Desktop as the owner's BRC-100 wallet, BRC-42 derived keys, `@bsv/402-pay` 0.3.3 (BRC-121), `@bsv/btms` 1.2.6 + public `tm_btms` overlay, `SIGHASH_SINGLE | ANYONECANPAY` maker offers, Arcade/ARC broadcast, WhatsOnChain.
- **API3 / EVM:** `TreasuryGuard.sol` on Base Sepolia (verified), API3 AirnodeHub signed data (CoinPaprika BSV/USD, TwitterAPI.io), x402 payments in aUSD, Foundry, viem.
- **Tests:** 54 offline tests on the BSV side (mock chain with real keys and signatures), plus live read-only checks against the deployed contract. The API3 side has 122 forge tests and 24 TS tests.

## Security and safety gates

1. **Offline, exact mainnet script, real key holders:** agent+watcher spends; agent-only and watcher-only fail; owner-only exits; change returns to the same vault script. 12/12 pass.
2. **Mainnet, owner-approved:** a 3,000-sat deposit, then the owner-only exit **first**. Only after that came the 5,000-sat deposit for the agent+watcher demo.
3. **The watcher fails closed** on overspend (fee counted), wrong recipient, extra payee, change to the agent, fee cap, expired, settled, SWAP, judge/retired vaults, wrong chain or contract, missing or forged receipt, RPC errors, and reused UTXOs or intents (also after a restart). Its journal is written with fsync, rename and a checksum before any signature leaves the watcher.

## Trust assumptions and what we do not claim

- Base does not verify BSV. `settle` is a record written by the agent, not a cross-chain proof. Enforcement lives in the BSV script and the watcher.
- The watcher can block but cannot take funds; if it goes offline, the owner exits alone (proven on mainnet).
- API3 signatures prove origin, integrity and time, not economic correctness.
- pUSD is an unbacked demo token, not a stablecoin. There is no CDP, liquidation, peg or bridge.
- In the demo, watcher and agent run in one process with separate keys; production would separate them.
- The signed-rate version of the swap wrapper (`executeSwap`) is tested offline; the mainnet swap used a fixed price.
- Part of the swap rail (BTMS issue/split, maker offer, fill, guardian) was prototyped before the event in [Brezn610/BSV_pet](https://github.com/Brezn610/BSV_pet). Provenance is in `bsv/README.md`.

## Links

- Code: https://github.com/eujinnl/bsv_hackathon (`api3/` and `bsv/`; BSV side in PR #2)
- Contract: https://sepolia.basescan.org/address/0x8e38cc6B1Bd1f0D25357066cd0036f28fd1f7773
- Evidence: `bsv/docs/evidence/RESULTS.md`
- Demo video: _add link_
