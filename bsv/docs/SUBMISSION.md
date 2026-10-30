# Devfolio submission text

Paste-ready sections. Every claim links to something a judge can open.

---

## Project name

Treasury Guard

## Tagline

A non-custodial DeFi vault and payment rail for AI agents. Base Sepolia decides, BSV mainnet moves the money, and the owner can always exit alone.

## The problem it solves

AI agents are starting to pay for things themselves: APIs, data, compute. Handing an agent a wallet key is a blank cheque. A prompt injection or a bug can drain it. Owners think in dollars, not in sats, and they need a hard limit that the agent cannot talk its way around.

Treasury Guard gives the agent freedom to act, but not unlimited freedom to spend:

- The owner's sats sit in a **BSV vault script** that only **agent + watcher together** can spend, and that the **owner can always spend alone**.
- A **daily USD budget** lives in a contract on **Base Sepolia**. The contract turns a **signed API3 BSV/USD price** into a SPEND intent with a hard `maxSats`.
- An independent **watcher** reads that intent from Base and co-signs **one** BSV withdrawal per intent. It does this only if the actual transaction pays the registered Agent Float no more than `maxSats` (fee included) and returns the rest to the same vault.
- The agent spends its float on **HTTP 402 pay-per-request APIs**, behind a guardian (merchant allowlist, declared price, caps).
- For merchants that want a token, the **atomic swap-and-pay** rail converts sats to a token and pays the merchant in **one** transaction, priced from the signed rate.

The invariant: an API3 intent alone cannot move money, and no BSV transaction can move money out of the vault unless that intent authorises it or the owner is exiting.

### Why this is DeFi

The track asks for a DeFi product with a simple agent on top. Treasury Guard is three DeFi building blocks put together for agents:

| DeFi building block | In Treasury Guard |
| --- | --- |
| **Non-custodial vault** with programmable spending rules | A BSV script: agent + watcher together, or the owner alone. No custodian, no bridge, and the owner's exit is proven on mainnet |
| **Oracle-priced limit** | An API3 signed BSV/USD price turns a dollar budget into a hard sats limit (`maxSats`), checked on chain by `TreasuryGuard.sol` |
| **Atomic swap** | Swap-and-pay: sats are exchanged for a token and the token goes straight to the merchant, in one transaction, all or nothing |

The agent stays simple: its model decides whether a purchase serves its task, and the vault, the oracle and the watcher decide how much it may spend.

### A concrete user

A small team runs a research or trading agent whose control logic lives on Base. They give it **$1 a day**. When the agent needs data, it asks for budget with a signed price, the watcher releases exactly that much from the BSV vault, and the agent pays per call over HTTP 402. On mainnet a vault withdrawal cost 42–61 sats in fees and a 402 payment 23 sats (≈ $0.000004), and a co-signed withdrawal was broadcast about one second after the intent was read. If the agent is tricked, the worst case is that day's budget, and the owner can still take everything back alone.

## How it works (end to end, live on 30 Oct 2026)

| Step | Network | Proof |
| --- | --- | --- |
| Owner funds the vault, then exits **alone** (safety gate before anything else) | BSV mainnet | [cdcbf706…](https://whatsonchain.com/tx/cdcbf706af70c65ecc04b65c3b9ddfecc6626a9cda3088a5312afcebc541e81f) → [db5ca41c…](https://whatsonchain.com/tx/db5ca41c82c4506f66614193b6c2ccf5b84f3d7afffcda4f1a588b09edf7d41e) |
| Owner funds the vault with 5,000 sats | BSV mainnet | [c1f97102…](https://whatsonchain.com/tx/c1f971027a2f0015a19c5945a48adf1282d5b1bb9cf8ab3f4e16d7574e246ad4) |
| Agent buys a signed BSV/USD price (API3 Airnode, CoinPaprika, paid via x402) and creates SPEND intent 2: `maxSats` 2,896 | Base Sepolia | [0x0aa95a72…](https://sepolia.basescan.org/tx/0x0aa95a723942c63e0463ea8730e4cb2baf8f76ac272b98915c31b8f0130afc90) |
| Watcher re-reads intent 2, checks the raw transaction and co-signs. 2,796 sats go to the Agent Float, 2,162 return to the vault, OP_RETURN receipt, fee 42 | BSV mainnet | [ae35d469…](https://whatsonchain.com/tx/ae35d46939d7fd7f79ff32aab1d6bdc906d28a18da93cce3950c013ccc91dcf5) |
| Agent records the BSV txid with `settle(2, txid)`. Read back: `settled = true` | Base Sepolia | [0xc1a8c9bb…](https://sepolia.basescan.org/tx/0xc1a8c9bb236698e05a51293e337369ab9ea6284b97d863e0a66257c2844de5b8) |
| Agent pays an HTTP 402 API (1,000 sats, HTTP 200 in 857 ms) | BSV mainnet | [43c8255e…](https://whatsonchain.com/tx/43c8255e63ab363f9d3641a601e74aee5ea95b5d53b747fcc86c40d71e959b77) |
| Intent 4 → withdrawal into the dedicated float wallet (2,062 sats) → agent's model (DeepSeek) decides BUY → guardian → HTTP 402 that spends exactly that withdrawal output | Base Sepolia + BSV mainnet | [`452a42b4…a31f`](https://whatsonchain.com/tx/452a42b4bf518451c9c4f48a270af892b5b2adb74b64ac8a76bbd5319285a31f) → [`54082a71…b320`](https://whatsonchain.com/tx/54082a714816ce2e9b2a67c23c5e04da67c2f93b8df30136b7126b715802b320) → [settle(4)](https://sepolia.basescan.org/tx/0x793e7f26270e8a688239a42128cfa4916842d27c6309f5beaf6bb9dca3ffc980) |
| Intent 5 through the **separate watcher process** (HTTP): withdrawal 5,781 sats → DeepSeek BUY → HTTP 402 from that output; replaying intent 5 → 409, intent 3 (vault 8) → 422 | Base Sepolia + BSV mainnet | [`85b74fb5…0002`](https://whatsonchain.com/tx/85b74fb5c959f7f239d854ac89d292b932cac4aa243801aa0e1815f8fe020002) → [`6cf0ff26…6134`](https://whatsonchain.com/tx/6cf0ff26409e0173d663ad2893a4e3d24306defd9fa81a01882d64de3d2a6134) → [settle(5)](https://sepolia.basescan.org/tx/0xe0a80a66b80bdb9138837cf9d079ade0495b6c4aaa9a49d1a01e3947a434c33f) |
| The agent pays a **teammate's independent Analyst service** (signed @federalreserve post + risk verdict) over HTTP 402: DeepSeek BUY → guardian → 100 sats from the float | BSV mainnet | [`2eebf6bc…0028`](https://whatsonchain.com/tx/2eebf6bc06bc1f2d9a0f365d6a5577e6843c94b0958aa5cd184fb3d9ad850028) |
| Atomic swap-and-pay: 1,000 sats to the maker and 1 pUSD to the merchant, in one tx | BSV mainnet | [ee2a3896…](https://whatsonchain.com/tx/ee2a38964df993af6cd48f5f51d1ce0c07c7bf454363735341288d7f71bf8e8c) |

A second withdrawal for intent 2 was refused live: `journal already holds this intent as broadcast`.

## Tech stack

- **BSV:** `@bsv/sdk` 3.2.1 (custom vault script, `Spend` interpreter, BEEF/SPV), `@bsv/wallet-toolbox` 2.14.9 (server wallets, `WalletPermissionsManager` guardian), BSV Desktop as the owner's BRC-100 wallet, BRC-42 derived keys, `@bsv/402-pay` 0.3.3 (BRC-121), `@bsv/btms` 1.2.6 + public `tm_btms` overlay, `SIGHASH_SINGLE | ANYONECANPAY` maker offers, Arcade/ARC broadcast, WhatsOnChain.
- **API3 / EVM:** `TreasuryGuard.sol` on Base Sepolia (verified), API3 AirnodeHub signed data (CoinPaprika BSV/USD, TwitterAPI.io), x402 payments in aUSD, Foundry, viem.
- **Agent model:** the purchase decision is made by an LLM: Claude (Anthropic SDK, structured output) or DeepSeek (JSON mode), under a deterministic guardian.
- **Tests:** 65 offline tests on the BSV side (mock chain with real keys and signatures), plus live read-only checks against the deployed contract. The API3 side has 122 forge tests and 24 TS tests.

## Security and safety gates

1. **Offline, exact mainnet script, real key holders:** agent+watcher spends; agent-only and watcher-only fail; owner-only exits; change returns to the same vault script. 12/12 pass.
2. **Mainnet, owner-approved:** a 3,000-sat deposit, then the owner-only exit **first**. Only after that came the 5,000-sat deposit for the agent+watcher demo.
3. **The watcher fails closed** on overspend (fee counted), wrong recipient, extra payee, change to the agent, fee cap, expired, settled, SWAP, judge/retired vaults, wrong chain or contract, missing or forged receipt, RPC errors, and reused UTXOs or intents (also after a restart). Its journal is written with fsync, rename and a checksum before any signature leaves the watcher.

## Trust assumptions and what we do not claim

- Base does not verify BSV. `settle` is a record written by the agent, not a cross-chain proof. Enforcement lives in the BSV script and the watcher.
- The watcher can block but cannot take funds; if it goes offline, the owner exits alone (proven on mainnet).
- API3 signatures prove origin, integrity and time, not economic correctness.
- pUSD is an unbacked demo token, not a stablecoin. There is no CDP, liquidation, peg or bridge.
- The watcher runs as its own local process (HTTP on 127.0.0.1, its own key and journal); intents 2 and 4 used the earlier in-process mode, intent 5 the separate process. A separate host is the production step.
- The signed-rate version of the swap wrapper (`executeSwap`) is tested offline; the mainnet swap used a fixed price.
- Part of the swap rail (BTMS issue/split, maker offer, fill, guardian) was prototyped before the event in [Brezn610/BSV_pet](https://github.com/Brezn610/BSV_pet). Provenance is in `bsv/README.md`.

## Roadmap

- **Bring the money across, not only the control:** fund the vault from USDC on Base through a bridge or a liquidity provider (for example a chain-key bridge), so a Base team can fund its agents without touching BSV first.
- **Independent watchers:** run the watcher on its own host today, then k-of-n watchers run by different parties.
- **Live, signed-rate swaps** with third-party liquidity providers; `executeSwap` already enforces the API3 rate, tested offline.
- **Experimental: BSV-backed pUSD (CDP prototype, not part of this submission).** A teammate built a DAI-style stablecoin on BSV: lock BSV, mint pUSD up to 66% of its value, liquidate at 75%. It ran on mainnet ([issue](https://whatsonchain.com/tx/a0416e6aeff43172e8831c4ca0029ec5344991e1921480b9c872eae428896118), [lock](https://whatsonchain.com/tx/4d97d5486b09f4152e8fc40372d8b2110e7bed767d90f3752d027ae7f36003e5), [mint](https://whatsonchain.com/tx/704fb804577eda292e20e89022a5d01c60eaadbb80a3c734f3c996a31d7a8aca), [liquidation at a public 60% demo threshold](https://whatsonchain.com/tx/bd35aea0f246a738aa5f5e20c1602281ba9011e09bd0cbcda5a04b3e6f2146f1); code: [Brezn610/BSV_pet `yigit/cdp`](https://github.com/Brezn610/BSV_pet/tree/yigit/cdp), `rail/docs/stablecoin.md`). It is left out because it **depends on a trusted watcher**: BSV script cannot see the debt or the price and has no covenants, so every path of its collateral needs the watcher, and the team held the watcher and liquidator keys. That is custody, and this track requires non-custodial funds. It shows what BSV would need (covenants) for trust-minimised lending.

## Links

- Code: https://github.com/eujinnl/bsv_hackathon (`api3/` and `bsv/`; BSV side in PR #2)
- Contract: https://sepolia.basescan.org/address/0x8e38cc6B1Bd1f0D25357066cd0036f28fd1f7773
- Evidence: `bsv/docs/evidence/RESULTS.md`
- Demo video: _add link_
