# Treasury Guard: interface for the BSV side

How the agent and the watcher use the API3 part. Nothing here needs Solidity or Foundry: import the TS client from
`api3/src/client/` and read addresses from `api3/deployments.json`. Exact signatures, errors and check order:
`API3-NOTES.md` → "TreasuryGuard interface (v1)". Changing the interface after deploy is a big change: talk to the API3
owner first.

## Where things are
| | |
|---|---|
| Chain | Base Sepolia (84532), explorer https://sepolia.basescan.org |
| Contract + demo vault | `deployments.json` → `baseSepolia.treasuryGuard`, `baseSepolia.vaultId` (`null` until deployed) |
| Feeds the contract trusts | `deployments.json` → `feeds` (Airnode signer + request hash per feed) |
| ABI | `src/client/abi.ts` (typed, generated from the forge build) |
| Client | `src/client/treasury-guard.ts` |

## Units
- USD: 6 decimals (`usd(1)` = `1000000n`). Price: USD per BSV, 8 decimals. Sats: 1e-8 BSV.
- `change1h` and all bps: hundredths of a percent (`-300` = -3.00 %).

## Agent (holds the vault's agent key, pays x402 in aUSD)
```ts
import { createTreasuryGuardClient, usd, Verdict } from '../api3/src/client/treasury-guard.ts';
import { createPayingFetch } from '../api3/src/x402.ts';

const guard = createTreasuryGuardClient({ rpcUrl, privateKey: agentKey });
const vaultId = BigInt(guard.deployment.vaultId!);
const paying = createPayingFetch(agentKey);

const price = await guard.fetchPrice(paying);                    // signed BSV/USD, checked off-chain
const { intents, hash } = await guard.submitPrice(vaultId, price, usd(0.5)); // SPEND from today's budget
// intents: every IntentCreated of this tx (a SPEND, and maybe a breaker/re-entry SWAP)

const post = await guard.fetchPost('WhiteHouse', paying);        // newest post of a whitelisted account
await guard.submitEvent(vaultId, post, price, Verdict.RISK_OFF); // hedge ≤ 25 %, only from NORMAL

await guard.settle(intentId, bsvTxid);                           // record the BSV tx that carried out an intent
```
- Every write is simulated first. A rejected response throws `ContractRejection` with `errorName`
  (`SignerMismatch`, `WrongRequest`, `StaleSignature`, `Replay`, `StalePost`, `NotOriginalPost`, `BudgetExceeded`,
  `Cooldown`, ...) and costs no gas. Log it and skip the cycle; never retry in a tight loop.
- `usd(0)` submits a price without spending: it only feeds the breaker.
- Budget: debited when the intent is created, never refunded (also not on expiry), reset once per UTC day.
- A price must be newer than the last accepted one, and at most `maxSignatureAge` old (see `getVaultConfig`).
- Retweets are rejected (`NotOriginalPost`). A post can be used once per vault (`Replay`).

## Watcher (no key needed, read-only)
```ts
const guard = createTreasuryGuardClient({ rpcUrl });
const past = await guard.getIntentEvents(vaultId);               // catch up from the deploy block
const stop = guard.watchIntents(async (intentId) => {
  const intent = await guard.getIntent(intentId);
  // co-sign only a BSV tx that matches the intent, and only before intent.expiry
});
```

`getIntent(intentId)` returns:

| Field | Meaning |
|---|---|
| `vaultId` | which vault |
| `kind` | 0 SPEND, 1 SWAP |
| `direction` | 0 NONE (SPEND), 1 SATS_TO_DUSD (hedge), 2 DUSD_TO_SATS (re-entry) |
| `source` | 0 BUDGET, 1 BREAKER, 2 REENTRY, 3 EVENT |
| `maxSats` | SPEND: most sats the tx may pay out (`usdAmount / price`) |
| `maxBps` | SWAP: most share of the vault to swap (DUSD_TO_SATS: of its dUSD); 0 for SPEND |
| `minOut`, `maxOut` | SWAP: allowed price band, signed price ∓ slippage (USD per BSV, 8 decimals) |
| `expiry` | unix seconds; the watcher must not co-sign after it |
| `price`, `priceSignedAt` | the signed BSV/USD price the intent is based on |
| `settled`, `bsvTxid` | set by `settle` |

Other views: `remainingUsdToday(vaultId)`, `regime(vaultId)` (`'NORMAL' | 'RISK_OFF' | 'GUARDED'`), `lastPrice(vaultId)`,
`getVaultConfig(vaultId)`.

## Events
`IntentCreated(intentId, vaultId, kind, direction, maxSats, maxBps, minOut, maxOut, expiry, price, priceSignedAt, source)`,
`RegimeChanged(vaultId, regime)`, `Settled(intentId, bsvTxid)`, `PriceVerified(...)`, `PostVerified(...)`,
`VaultCreated(...)`.

## Judge script (API3 standalone, no BSV needed)
`node --env-file=.env.agent src/judge.ts` buys one fresh BSV/USD price (0.001 aUSD), runs every rejected case as a free
`eth_call` (edited digit, local key, BTC/USD request, too old, over budget), sends one valid SPEND, then shows `Replay`.
`--dry` sends nothing, `--post WhiteHouse` also checks the latest post.
