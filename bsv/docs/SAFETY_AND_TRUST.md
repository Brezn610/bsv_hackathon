# Safety and trust

## The vault script

```text
OP_IF   <agentKey> OP_CHECKSIGVERIFY <watcherKey> OP_CHECKSIG
OP_ELSE <ownerKey> OP_CHECKSIG
OP_ENDIF
unlock (normal): <watcherSig> <agentSig> OP_1      unlock (owner): <ownerSig> OP_0
```

- Every key is a BRC-42 derived key (`[2, 'treasury guard vault']`, keyID `vault-5-v1`,
  counterparty self), never an identity key. Owner = BSV Desktop (the user's wallet); agent =
  the agent's wallet-toolbox server wallet; watcher = a separate root key in `bsv/.env.watcher`.
- Signatures are `SIGHASH_ALL | FORKID`, made by `wallet.createSignature` over the preimage hash
  (the same path PushDrop uses). A cosignature is valid for one exact transaction.
- The owner branch needs no agent, no watcher and no Base transaction. It is not 2-of-3, and there is no timelock.

## Gates (spec amendment A3, mainnet only)

| Gate | Status |
| --- | --- |
| (1) Offline, exact mainnet script, real key holders: interpreter + mock chain | **PASS**, 12/12, 30 Oct 17:18 Berlin (`docs/evidence/gate1.json`) |
| (2a) Fund ≤ 5,000 sats, owner-only exit first | **PASS**: 3,000 sats funded, then exited by BSV Desktop alone (see RESULTS.md) |
| (2b) Fund once more for the agent+watcher demo | funded 5,000 sats after (2a) |

`tg` enforces the order: `fund` refuses without a passing gate (1) for the same script, the first
deposit is marked `exit-proof`, a second deposit needs the owner-exit evidence, and `withdraw`
needs it too. Every mainnet step needs `CONFIRM_MAINNET=1`, and each one was approved by the owner.

## Watcher

- Pure policy on the real transaction (see INTEGRATION.md for the list). Fail closed on any
  RPC, UTXO-lookup or parsing error.
- Journal `data/watcher-journal.json`: written (temporary file, fsync, rename) as `reserved`
  before signing and `signed` before the signature is returned; checksum over the body; a
  corrupted journal stops the watcher. An intent in any recorded state is never signed again.
  A vault UTXO claimed by one intent is never offered to another.
- **Crash after signing, before broadcast:** the watcher does not sign an alternative. The
  operator looks up the recorded `proposalId` (the txid with empty unlocking scripts) on chain
  and either re-broadcasts that exact transaction or leaves the intent unused. The owner can
  always exit.
- The watcher can block (refuse to sign) but cannot take funds: it cannot spend without the agent.
- **Disclosed limitation:** in the demo the watcher runs inside the same `tg` CLI process as the
  agent. Its key lives in a separate file the agent's environment never loads, and the agent only
  receives signatures for transactions the policy approved. Running it as its own process
  or host is the production step.

## Spend firewall vs vault budget

The Base daily USD budget limits how many sats move **vault → Agent Float**. After that, the float
is an ordinary wallet. Merchant payments are guarded by the rail's guardian
(`WalletPermissionsManager`: declared intent, merchant allowlist, per-payment cap, daily budget,
and for swaps a transaction-level plan check). They are **not** enforced by Base.

## Atomic swap-and-pay (`executeSwap`)

`fillOffer` signs whatever it is given, so every live fill goes through `executeSwap`. It checks
the signed invoice (trusted merchant identity), the offer signature and expiry, the price against
the signed BSV/USD rate (`ceil(usdMicro·10¹⁰ / price8)` + slippage, bigint), the provenance on
the token overlay, BTMS admission of the merchant output, and replay. It also checks the
outputs actually signed. Note: `ls_btms` also answers "found" for spent outputs (fact 37), so
provenance proves origin, not unspentness; a spent offer fails as a double spend.

## Trusted components

- One watcher (liveness: if it is down, the owner exits alone).
- One API3 price signer and data source (CoinPaprika via AirnodeHub). The signature proves origin,
  integrity and time, not economic correctness.
- The Base Sepolia RPC (`sepolia.base.org`), WhatsOnChain (UTXO status), Arcade/ARC broadcaster,
  BSV Desktop.
- The registered Base agent that writes `settle`.
- One team-run LP and a team-issued demo token (pUSD) with a single public `tm_btms` host.

## Not claimed

No CDP, liquidation, peg or bridge. No trustless cross-chain proof: Base does not verify BSV, and
`settle` is a claim. pUSD is an unbacked demo token, not a stablecoin, and is not redeemable.
There is no autonomous risk-off execution: SWAP intents are not executed. Not production-hardened.
A broadcast transaction is reported as 0-conf until it is seen in a block.
