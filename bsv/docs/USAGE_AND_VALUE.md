# Usage and value

One page, as the BSV track asks: the problem, who it is for, how they use it, and what it brings to BSV.

## The problem

AI agents now pay for paid APIs, data and compute on their own. Today that means one of two bad options:

- **Give the agent a wallet key.** It can spend everything, and it reads untrusted text all day. One prompt injection or bug, and the wallet is empty.
- **Ask a human every time.** That is safe, but then the agent is not autonomous, and micropayments stop making sense.

Owners also think in dollars, not in sats, and want a limit that holds even when the agent misbehaves.

## Who it is for

- **Agent builders**: teams running research, trading or support agents that buy data and API calls per request.
- **Agent platforms**: services that hold money for many agents and need a per-agent budget they can prove.
- **Merchants and API providers**: they want to get paid per request without accounts or card fees. Through swap-and-pay they can also ask for a specific token.

Many agent teams build on EVM chains today. Treasury Guard lets them keep their budget and control logic on an EVM chain (Base) and pay on BSV.

## How they use it

| Who | Does | With |
| --- | --- | --- |
| Owner | Sets a daily USD budget for the agent on Base; funds the BSV vault; can exit alone at any time | `TreasuryGuard.sol`, BSV Desktop, `tg fund` / `tg exit` |
| Agent | Buys a signed BSV/USD price, asks for a SPEND within the budget, proposes the BSV withdrawal; its model decides what to buy | API3 Airnode + x402, `tg withdraw`, Claude or DeepSeek |
| Watcher | Re-reads the intent on Base, checks the real transaction, co-signs once | `bsv/src/watcher` |
| Float wallet | Pays merchants over HTTP 402, under the guardian (allowlist, declared price, caps) | `@bsv/402-pay`, `WalletPermissionsManager` |
| Merchant | Gets paid per request; for tokens, gets the token directly via swap-and-pay | `@bsv/402-pay/server`, BTMS |

## Measured on mainnet (30 Oct 2026)

| | Value |
| --- | --- |
| Vault withdrawal fee | 42 sats (≈ $0.000007 at ~$17/BSV) |
| Owner exit fee | 40 sats |
| HTTP 402 payment | 1,000 sats price + 23 sats network fee; HTTP 200 in 857 ms |
| Intent read → co-signed withdrawal broadcast | 1,045 ms |
| Transactions for "swap sats to a token and pay a merchant" | 1 |

At these fees, the network cost of thousands of agent payments is still below the fixed fee of a single card payment.

## Value to BSV

- **New users from another chain.** Budgets are set in dollars on Base, which EVM agent teams already use. They can start paying on BSV without moving their control logic. Every agent becomes a BSV wallet with recurring, real transaction volume.
- **A non-custodial pattern others can reuse.** The vault is a plain BSV script: agent AND watcher, OR owner. It works with BSV Desktop and wallet-toolbox and needs no custodian or new opcode.
- **Demand for BSV-native payments.** HTTP 402 (BRC-121) gives merchants a reason to accept sats. Swap-and-pay lets token-only merchants take agent payments without the agent holding the token.

## Next steps (not built tonight)

- Fund the vault from USDC on Base through a bridge or a liquidity provider, so the money also comes from the other chain, not just the control.
- Run the watcher on its own host (it already runs as its own process), then k-of-n watchers run by different parties.
- Live, signed-rate swap-and-pay against third-party liquidity providers instead of the team-run maker.
- A BSV-backed pUSD (CDP) prototype exists and ran on mainnet, but it depends on a trusted watcher and is not part of the submission; see the root README, "Roadmap".
