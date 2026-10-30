# Treasury Guard

**A non-custodial DeFi vault and payment rail for AI agents. Base Sepolia decides, BSV mainnet moves the money, and the owner can always exit alone.**

TUM Blockchain & AI Hackathon 2026, BSV track ("DeFi Rails for Agentic Payments") and API3 track.

AI agents are starting to pay for APIs, data and compute themselves. Giving an agent a wallet key is a blank cheque: one prompt injection or bug, and the wallet is empty. Treasury Guard gives the agent freedom to act, but not unlimited freedom to spend:

1. The owner's sats sit in a **BSV vault script** that only **agent + watcher together** can spend, and that the **owner can always spend alone**.
2. A **daily USD budget** lives in `TreasuryGuard.sol` on **Base Sepolia**. The contract turns a **signed API3 BSV/USD price** into a SPEND intent with a hard `maxSats`.
3. An independent **watcher** reads the intent and co-signs **one** BSV withdrawal for it. It signs only if the real transaction pays the registered Agent Float no more than `maxSats`, fee included, and returns the rest to the vault.
4. The agent's model (Claude or DeepSeek) decides what to buy. A **guardian** in the float wallet enforces the merchant allowlist, the declared price and the caps. The agent then pays an **HTTP 402** API in sats.
5. DeFi rail: **atomic swap-and-pay** turns sats into a token and pays a token-only merchant in **one** BSV transaction.

> An API3 intent alone cannot move money. No BSV transaction can move money out of the vault unless that intent authorises it, or the owner is exiting.

```mermaid
flowchart LR
  P[API3 Airnode<br/>signed BSV/USD] -- x402 --> A[Agent]
  A -- submitPrice --> TG[TreasuryGuard.sol<br/>Base Sepolia testnet]
  TG -- getIntent --> W[Watcher]
  A -- proposed tx --> W
  W -- co-signature --> V[(BSV vault<br/>agent AND watcher<br/>OR owner)]
  V -- withdrawal --> F[Agent Float wallet]
  F -- HTTP 402 sats --> M[Paid API]
  A -- settle(intent, txid) --> TG
  O[Owner<br/>BSV Desktop] -. exits alone .-> V
```

## Why this is DeFi

The track asks for a DeFi product with a simple agent on top. Treasury Guard is three DeFi building blocks put together for agents:

| DeFi building block | In Treasury Guard |
| --- | --- |
| **Non-custodial vault** with programmable spending rules | A BSV script: agent + watcher together, or the owner alone. No custodian, no bridge, and the owner's exit is proven on mainnet |
| **Oracle-priced limit** | An API3 signed BSV/USD price turns a dollar budget into a hard sats limit (`maxSats`), checked on chain by `TreasuryGuard.sol` |
| **Atomic swap** | Swap-and-pay: sats are exchanged for a token and the token goes straight to the merchant, in one transaction, all or nothing |

The agent stays simple: its model decides whether a purchase serves its task, and the vault, the oracle and the watcher decide how much it may spend.

## A concrete user

A small team runs a research or trading agent whose control logic lives on Base. They give it **$1 a day**. When the agent needs data, it asks for budget with a signed price, the watcher releases exactly that much from the BSV vault, and the agent pays per call over HTTP 402. On mainnet a vault withdrawal cost 42–61 sats in fees and a 402 payment 23 sats (≈ $0.000004), and a co-signed withdrawal was broadcast about one second after the intent was read. If the agent is tricked, the worst case is that day's budget, and the owner can still take everything back alone.

## Live, end to end (30 Oct 2026)

| Step | Network | Transaction |
| --- | --- | --- |
| Owner funds the vault, then **exits alone** (safety gate before anything else) | BSV mainnet | [cdcbf706…](https://whatsonchain.com/tx/cdcbf706af70c65ecc04b65c3b9ddfecc6626a9cda3088a5312afcebc541e81f) → [db5ca41c…](https://whatsonchain.com/tx/db5ca41c82c4506f66614193b6c2ccf5b84f3d7afffcda4f1a588b09edf7d41e) |
| Owner funds the vault with 5,000 sats | BSV mainnet | [c1f97102…](https://whatsonchain.com/tx/c1f971027a2f0015a19c5945a48adf1282d5b1bb9cf8ab3f4e16d7574e246ad4) |
| Signed BSV/USD → SPEND **intent 2** (`maxSats` 2,896) | Base Sepolia | [0x0aa95a72…](https://sepolia.basescan.org/tx/0x0aa95a723942c63e0463ea8730e4cb2baf8f76ac272b98915c31b8f0130afc90) |
| Watcher checks the raw tx and co-signs: 2,796 sats → Agent Float, 2,162 back to the vault, fee 42 | BSV mainnet | [ae35d469…](https://whatsonchain.com/tx/ae35d46939d7fd7f79ff32aab1d6bdc906d28a18da93cce3950c013ccc91dcf5) |
| `settle(2, txid)`, read back as `settled = true` | Base Sepolia | [0xc1a8c9bb…](https://sepolia.basescan.org/tx/0xc1a8c9bb236698e05a51293e337369ab9ea6284b97d863e0a66257c2844de5b8) |
| Agent pays an HTTP 402 API: 1,000 sats, HTTP 200 in 857 ms | BSV mainnet | [43c8255e…](https://whatsonchain.com/tx/43c8255e63ab363f9d3641a601e74aee5ea95b5d53b747fcc86c40d71e959b77) |
| Intent 4 → withdrawal into the dedicated float wallet (2,062 sats) → agent's model (DeepSeek) decides BUY → guardian → HTTP 402 that spends exactly that withdrawal output | Base Sepolia + BSV mainnet | [`452a42b4…a31f`](https://whatsonchain.com/tx/452a42b4bf518451c9c4f48a270af892b5b2adb74b64ac8a76bbd5319285a31f) → [`54082a71…b320`](https://whatsonchain.com/tx/54082a714816ce2e9b2a67c23c5e04da67c2f93b8df30136b7126b715802b320) → [settle(4)](https://sepolia.basescan.org/tx/0x793e7f26270e8a688239a42128cfa4916842d27c6309f5beaf6bb9dca3ffc980) |
| Intent 5 through the **separate watcher process** (HTTP): withdrawal 5,781 sats → DeepSeek BUY → HTTP 402 from that output; replaying intent 5 → 409, intent 3 (vault 8) → 422 | Base Sepolia + BSV mainnet | [`85b74fb5…0002`](https://whatsonchain.com/tx/85b74fb5c959f7f239d854ac89d292b932cac4aa243801aa0e1815f8fe020002) → [`6cf0ff26…6134`](https://whatsonchain.com/tx/6cf0ff26409e0173d663ad2893a4e3d24306defd9fa81a01882d64de3d2a6134) → [settle(5)](https://sepolia.basescan.org/tx/0xe0a80a66b80bdb9138837cf9d079ade0495b6c4aaa9a49d1a01e3947a434c33f) |
| The agent pays a **teammate's independent Analyst service** (signed @federalreserve post + risk verdict) over HTTP 402: DeepSeek BUY → guardian → 100 sats from the float | BSV mainnet | [`2eebf6bc…0028`](https://whatsonchain.com/tx/2eebf6bc06bc1f2d9a0f365d6a5577e6843c94b0958aa5cd184fb3d9ad850028) |
| Atomic swap-and-pay: 1,000 sats to the maker, 1 pUSD to the merchant, one tx | BSV mainnet | [ee2a3896…](https://whatsonchain.com/tx/ee2a38964df993af6cd48f5f51d1ce0c07c7bf454363735341288d7f71bf8e8c) |

A second withdrawal for intent 2 was refused live (`journal already holds this intent as broadcast`). The full record, including what is live and what is mocked, is in [`bsv/docs/evidence/RESULTS.md`](bsv/docs/evidence/RESULTS.md).

## Usage and value

**Who it is for.** Teams that run AI agents and want them to buy things on their own (paid APIs, data feeds, compute), and agent platforms that hold money for many agents. Many of them build on EVM chains today.

**How they use it.**
1. The owner creates a vault on Base (daily USD budget, agent key) and funds a BSV vault from their own wallet (BSV Desktop).
2. The agent asks for budget with a signed price. The watcher releases sats to the agent's float wallet only within that budget.
3. The agent spends the float on HTTP 402 APIs, or through swap-and-pay for merchants that want a token. The guardian checks every payment.
4. The owner can take everything back at any time with one transaction, without asking anyone.

**Why BSV.** Agents pay in tiny amounts and often. On BSV the vault withdrawal paid a 42-sat network fee and the 402 payment a 23-sat fee, both under $0.00001 at ~$17/BSV. A payment was answered in under one second. Scripts let the vault rules live in the coin itself, so no custodian is needed.

**What it brings to BSV.** Budgets are set in dollars on an EVM chain that agent teams already use, so an EVM agent team can start paying on BSV without moving its control logic. Every such agent becomes a BSV user with real transaction volume. The DeFi rail lets a merchant ask for a token while the agent holds only sats. More: [`bsv/docs/USAGE_AND_VALUE.md`](bsv/docs/USAGE_AND_VALUE.md).

## Run it

| Part | Where | Commands |
| --- | --- | --- |
| BSV side: vault, watcher, Agent Float, HTTP 402, swap-and-pay | [`bsv/`](bsv/README.md) | `cd bsv && npm ci && npm test && npm run typecheck` (64 offline tests), `LIVE_BASE=1 npm test` (adds live Base reads) |
| API3 side: contract, client, judge script | [`api3/`](api3/README.md) | `cd api3 && pnpm install && forge test && pnpm test`; live judge: `node --env-file=.env src/judge.ts --dry` |

The mainnet runbook (the `tg` CLI) is in [`bsv/docs/DEMO_RUNBOOK.md`](bsv/docs/DEMO_RUNBOOK.md). The design and checks are in [`bsv/docs/INTEGRATION.md`](bsv/docs/INTEGRATION.md) and [`bsv/docs/SAFETY_AND_TRUST.md`](bsv/docs/SAFETY_AND_TRUST.md).

## Trust assumptions, and what we do not claim

- Base does not verify BSV. `settle` is a record written by the agent, not a cross-chain proof. Enforcement lives in the BSV script and the watcher.
- The watcher can block but cannot take funds. If it goes offline, the owner exits alone (proven on mainnet).
- API3 signatures prove origin, integrity and time, not economic correctness.
- pUSD is an unbacked demo token, not a stablecoin. There is no CDP, liquidation, peg or bridge.
- The watcher runs as its own local process with its own key; intents 2 and 4 used the earlier in-process mode, intent 5 the separate process, and a separate host is the production step. The signed-rate swap wrapper is tested offline only.

## Roadmap

- **Bring the money across, not only the control:** fund the vault from USDC on Base through a bridge or a liquidity provider (for example a chain-key bridge), so a Base team can fund its agents without touching BSV first.
- **Independent watchers:** run the watcher on its own host today, then k-of-n watchers run by different parties.
- **Live, signed-rate swaps** with third-party liquidity providers; `executeSwap` already enforces the API3 rate, tested offline.
- **Experimental: BSV-backed pUSD (CDP prototype, not part of this submission).** A teammate built a DAI-style stablecoin on BSV: lock BSV, mint pUSD up to 66% of its value, liquidate at 75%. It ran on mainnet ([issue](https://whatsonchain.com/tx/a0416e6aeff43172e8831c4ca0029ec5344991e1921480b9c872eae428896118), [lock](https://whatsonchain.com/tx/4d97d5486b09f4152e8fc40372d8b2110e7bed767d90f3752d027ae7f36003e5), [mint](https://whatsonchain.com/tx/704fb804577eda292e20e89022a5d01c60eaadbb80a3c734f3c996a31d7a8aca), [liquidation at a public 60% demo threshold](https://whatsonchain.com/tx/bd35aea0f246a738aa5f5e20c1602281ba9011e09bd0cbcda5a04b3e6f2146f1); code: [Brezn610/BSV_pet `yigit/cdp`](https://github.com/Brezn610/BSV_pet/tree/yigit/cdp), `rail/docs/stablecoin.md`). It is left out because it **depends on a trusted watcher**: BSV script cannot see the debt or the price and has no covenants, so every path of its collateral needs the watcher, and the team held the watcher and liquidator keys. That is custody, and this track requires non-custodial funds. It shows what BSV would need (covenants) for trust-minimised lending.

## Repository layout

This repository is a fork of [bsv-blockchain/ts-stack](https://github.com/bsv-blockchain/ts-stack). The hackathon work is in two folders:

| Folder | What | Owner |
| --- | --- | --- |
| [`api3/`](api3/README.md) | `TreasuryGuard.sol`, API3 signed data, x402, TypeScript client, judge script | API3 side |
| [`bsv/`](bsv/README.md) | Vault script, watcher, Agent Float, guardian, HTTP 402, swap-and-pay, mainnet CLI | BSV side |

Everything else is the upstream ts-stack monorepo, unchanged. Its README is [`README.ts-stack.md`](README.ts-stack.md). Part of the swap rail was prototyped before the event in [Brezn610/BSV_pet](https://github.com/Brezn610/BSV_pet); provenance is in [`bsv/README.md`](bsv/README.md#provenance).
