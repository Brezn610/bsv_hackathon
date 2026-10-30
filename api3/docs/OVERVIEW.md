# Treasury Guard: the idea in simple words

## In one sentence
**We give companies a safe account for their AI agents: spending limits in dollars, protection against crashes and fake news, and the money always belongs to the company.**

Think of it as a **company credit card with a limit, but for an AI agent.**

## Who is the customer?
Companies and developers who run AI agents **that spend money on their own**. Example: a research agent that pays per call for data, articles or analysis. The company is our customer; the agent is their tool.

## What problem do they have?
As soon as an agent can pay by itself, the owner has three fears:
1. **"My agent spends too much."** The boss thinks in dollars ("max $5 a day"), but on BSV the agent pays in sats.
2. **"The budget loses value."** sats go up and down in price.
3. **"My agent falls for fakes."** A fake post or a fake price can trigger bad decisions. Real example: in January 2024 the hacked X account of the US SEC posted a fake Bitcoin-ETF approval and moved the market.

## What do we build?
An **account with rules** for the agent:
- The money sits in a **vault on BSV**. The agent can only spend with a second signature from a "watcher". **The owner can always take everything back alone.**
- The watcher only signs if a **contract on Base** has allowed it. The contract only allows something after it verified **signed data from API3**: a BSV/USD price, or a post from an official account.

**The three rules:**
| Rule | What happens | Trigger |
|---|---|---|
| 1. Dollar budget | The agent may spend e.g. $5/day; the contract converts it to sats at the verified price | every valid signed price |
| 2. Circuit breaker | If BSV crashes (e.g. −5 % in 1 h), the budget is moved into a stablecoin | signed price, no AI involved |
| 3. News guard | On an official post (e.g. @WhiteHouse), an analyst agent judges it; the agent may hedge **max 25 %** | signed post + analyst verdict |

## Who does what?
- **API3 (on Base Sepolia):** delivers signed data and decides **whether** the agent may do something. The contract checks:
  - the right signer;
  - the right request (BSV/USD, not ETH/USD);
  - fresh, not reused;
  - within the budget.
- **BSV (on mainnet):** **where the money lives and moves.** The vault, the payments, the swaps between sats and the stablecoin, and a receipt for every move on WhatsOnChain.

**Without API3:** no verified data → no permission → no money moves.
**Without BSV:** no account, no payment, no swap → permissions with nothing to move.

**Why two chains?** Checking API3 signatures is cheap only on an EVM chain. Paying fractions of a cent is cheap only on BSV. Each chain does what it's best at.

## How one cycle looks (every 10 minutes)
1. The agent buys a signed BSV/USD price from API3 (x402, $0.001).
2. The contract checks it and allows "you may spend X sats".
3. The watcher co-signs. The agent moves the sats to its wallet and pays a service.
4. If an official account posted: the agent pays the analyst agent in sats for a verdict. A hedge of max 25 % may follow.
5. If the price crashed: the circuit breaker moves the budget into the stablecoin.
6. Everything is logged: BaseScan + WhatsOnChain links.

## Important facts and honest points
- **Networks:** BSV mainnet (real sats, tiny amounts only) + Base Sepolia for API3. API3's paid data only works on Base Sepolia right now. No money crosses chains, so mixing mainnet and testnet is fine.
- **No bridge needed.** The stablecoin lives directly on BSV, and swaps are single BSV transactions. Other agents get paid directly on BSV.
- **The agent has two wallets:**
  - BSV: the real budget, our product.
  - Base: only API3 data costs, paid in aUSD (API3's free test dollar). About $1.60/day; we already have 10 aUSD.
- **Our stablecoin is a demo token.** It has no backing and can't be redeemed. In production it gets replaced by a real stablecoin on BSV. Working name "dUSD" (final name TBD); not "tUSD", because TrueUSD (TUSD) exists.
- **An API3 signature proves who said what and when, not that it's true.** That's why the news rule is capped at 25 %, and the uncapped rule uses only price data.
- **Trust points:** the watcher can block but never take; the stablecoin issuer is us (demo); the analyst's opinion is not verified, only signed and capped.

## How we could make money
- A small fee on every vault move co-signed by **our hosted watcher**. The protocol is open source, so people pay for convenience.
- A subscription per agent for fleet management (rules, budgets, audit trail).
- A cut of the analyst marketplace (analysts sell verdicts per call).
- No invented market sizes in the pitch.

## Vision (roadmap, not a claim)
AirnodeHub today only takes a test dollar. When it moves to real money, sub-cent data calls need a sub-cent payment rail, and BSV is built for that. Agents could then pay for everything, including data, from one sats budget. → Ask API3 what they plan before we say this.

## Questions to ask the mentors
- **API3:** What will AirnodeHub settle in after the hackathon? Does a dollar budget converted at a signed price count as a "meaningful on-chain action"?
- **BSV:** Is there a real stablecoin on BSV mainnet we can use? Does a watcher that can block but never take count as non-custodial?

## The plan
- **Fri until 24:00:**
  - contract with budget + circuit breaker, tamper test, deploy;
  - agent pays via 402 on BSV;
  - swap sats ⇄ stablecoin;
  - owner funds the vault from BSV Desktop.
- **Until Sat 06:00:** vault script + watcher, agent loop, news rule.
- **Sat 11:00:** feature freeze. **13:30:** submitted. **15:00–17:00:** live pitch, separately for each track.
