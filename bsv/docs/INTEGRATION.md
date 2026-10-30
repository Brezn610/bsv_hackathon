# API3 ↔ BSV integration

**Base Sepolia testnet decides, BSV mainnet moves the money.** The Base contract never sees BSV
and does not enforce anything on BSV; the watcher does, from its own reading of Base.

## Fixed facts (read at runtime, not typed in)

| | Value | Source |
| --- | --- | --- |
| Chain | Base Sepolia, 84532 | `api3/deployments.json` |
| Contract | `0x8e38cc6B1Bd1f0D25357066cd0036f28fd1f7773` | same |
| Guarded vault | `vaultId = 5` | same |
| Never co-signed | judge 6, live judge 7, API3 runner 8, retired 1–4 | same (every `*VaultId` field other than `vaultId`, and `retiredVaults`) |
| Vault 5 config (read 30 Oct) | daily budget $1.000000, intent TTL 900 s, max signature age 300 s | `getVaultConfig(5)` |
| ABI | 7 entries copied from `api3/src/client/abi.ts` | `npm run sync:api3`; `test/api3-readonly.test.ts` fails on drift |

**Runtime boundary.** `api3/` is ESM TypeScript (pnpm, Node type stripping); `bsv/` is CommonJS
(npm, tsx). The watcher does not import the API3 client: it uses `viem` 2.57.3 (the version API3
pins) in `src/api3/intentReader.ts`, with the ABI copied from API3's generated `abi.ts` and the
addresses read from `api3/deployments.json` itself. No EVM key exists on the BSV side.

## The three boundary decisions

1. **Vault binding.** `(84532, 0x8e38…7773, vault 5)` ↔ one BSV vault locking script, one
   Agent Float locking script, BSV mainnet, recorded in `bsv/data/vault-binding.json`
   (version `tg-vault-vault-5-v1-2026-10-30`, then `…+float-wallet`, see below). The Base contract does not know this mapping; the
   watcher enforces it. A new binding needs `tg init --force` and is only allowed while unfunded.
   - Vault script: `63 21 0234a2…3fad ad 21 0288c0…2790 ac 67 21 02ec58…c242 ac 68`
     (`IF <agent> CHECKSIGVERIFY <watcher> CHECKSIG ELSE <owner> CHECKSIG ENDIF`)
   - Agent Float: `76a91419e272af3877858a136f6b5a9c67a390bb13b7e088ac` (in the agent wallet) for intent 2; from
     `…+float-wallet` on, `76a914000d3c59311f64d8806fb5bf5a1daaf0dd15b27988ac`, a dedicated float wallet whose only
     income is vault withdrawals, so its payments are traceable to them. The vault script did not change.
2. **Recipient policy.** A SPEND intent carries `maxSats` but no destination. The watcher allows
   exactly one recipient: the pre-registered Agent Float. Merchants are paid later, from the
   float, under the guardian. Base never certified a recipient, and we do not say it did.
3. **Who does what.** API3 owner/agent: signed price, `submitPrice`, `settle`. BSV side: watcher
   verification, BSV signing and broadcast, and the receipt (intentId, BSV txid, amount, fee).
   The EVM agent key is never requested.

## What the watcher checks (`src/watcher/policy.ts`)

On the intent, re-read with `getIntent` at **tip − 1 block** right before signing (an intent only
in the newest block is not seen yet; RPC errors, chain mismatch, unknown intent → deny):

- `chainId`, contract and `vaultId` equal the binding; vault not in the excluded list;
- `kind = 0` (SPEND), `direction = 0`, `maxSats > 0`, `settled = false`;
- `now + 60 s < expiry` (signing and broadcast margin);
- the journal has never seen this intent (`settled = false` is not replay protection).

On the transaction bytes (never on descriptions):

- version 1, lockTime 0, final sequences; every input is a bound vault UTXO, listed once, and
  unspent now according to WhatsOnChain (mempool included), at its known value;
- outputs: exactly one Agent Float output, at most one change output to the **same vault script**,
  exactly one zero-value `OP_RETURN` equal to the expected receipt, nothing else;
- `vaultIn − change ≤ maxSats` (the fee is paid by the vault and counted), fee ≤ 200 sats.

SWAP intents (`kind = 1`) are logged and never co-signed in P0.

## Receipt and `settle`

Every withdrawal carries `OP_FALSE OP_RETURN "TGv1 <chainId> <contract> <vaultId> <intentId>"`. It
is an audit label, not a proof of Base consensus. After broadcast, `tg withdraw` writes
`data/evidence/withdrawal-intent-N.json` with the BSV txid and `settleArg = 0x<64 hex>`. The API3
agent calls `settle(intentId, settleArg)`. `settle` records the **vault → float withdrawal**; the
later HTTP 402 merchant payment is a separate transaction and is recorded separately.
`settle` is a claim by the registered agent, not cross-chain verification.

## Creating a SPEND for the demo

`judge.ts` refuses vault 5. With the vault-5 agent key (`0x0310dCF1…4cf0`):

```ts
const guard = createTreasuryGuardClient({ rpcUrl, privateKey: agentKey });
const price = await guard.fetchPrice(createPayingFetch(agentKey));
const { intents, hash } = await guard.submitPrice(5n, price, usd(0.0005)); // ≈ 2,900 sats at ~$17/BSV
```

The vault holds 5,000 sats; `maxSats` must leave room for the 100-sat fee reserve. The intent is
valid for 900 s; run `tg withdraw --intent N` right after.
