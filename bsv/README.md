# Treasury Guard — BSV side

**Base Sepolia testnet decides, BSV mainnet moves the money.**

An AI agent gets a dollar budget, not a blank cheque. The API3 part (`../api3`) turns a signed
BSV/USD price into a SPEND intent on Base Sepolia. On BSV, the owner's sats sit in a vault output
that only **agent + watcher together** can spend, and that the **owner can always spend alone**.
The watcher reads the intent from Base and co-signs one withdrawal per intent, only if the actual
transaction pays the registered Agent Float no more than `maxSats` (fee included) and returns the
rest to the same vault script. The Agent Float then buys a paid API over HTTP 402 in sats. The
Agent Swap Rail (one-transaction sats → token swap-and-pay) is the DeFi part, behind a mandatory
safety wrapper.

> The invariant: an API3 intent alone cannot move money, and no BSV transaction can move money
> out of the vault unless it is authorised by that intent, or is the owner's own exit.

| Doc | What |
| --- | --- |
| [`docs/INTEGRATION.md`](docs/INTEGRATION.md) | The API3 ↔ BSV contract: vault binding, recipient policy, who does what, exact checks |
| [`docs/SAFETY_AND_TRUST.md`](docs/SAFETY_AND_TRUST.md) | Script, gates, watcher rules, what is trusted, what is not claimed |
| [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md) | Commands, in order, for the live demo |
| [`docs/evidence/RESULTS.md`](docs/evidence/RESULTS.md) | Transaction IDs, test results, what is live and what is mocked, final report |
| [`docs/SUBMISSION.md`](docs/SUBMISSION.md) | Paste-ready Devfolio text |
| [`docs/USAGE_AND_VALUE.md`](docs/USAGE_AND_VALUE.md) | The one-page usage and value note the track asks for |
| [`docs/verified-facts.md`](docs/verified-facts.md) | Rail baseline facts (Chinese), incl. the first mainnet swap-and-pay |

## Dashboard

`dashboard/` is a live view for judges and for the demo video: static files, no build step, no dependencies. Serve
it (`python3 -m http.server -d dashboard 8765`) and open `http://localhost:8765`.
It reads the watcher's `GET /health` and `GET /decisions`, Base Sepolia (`eth_call`, `eth_getLogs` in 200-block
pages, `eth_getTransactionByHash`) and WhatsOnChain. It never calls `/cosign` or `/broadcast`, never signs, and holds
no key. Views: **Overview** (both chains, the latest payment end to end, live proofs), **API3 · Signed data** (signed
price, dollars → sats limit, the tamper test, crash and news guards), **BSV · Vault & payments** (the vault script,
every coin in and out of the vault, fees, HTTP 402 payments), **Owner** and **Transactions**. Details and the
recording guide: [`dashboard/README.md`](dashboard/README.md).

**Run it live (real transactions).** With the owner's control server running, the page can:

- **Run the agent** (Overview): one full spend, step by step, with the team's existing commands: api3 `spend5.ts`
  (signed price → SPEND intent), `tg withdraw --intent N` (watcher co-signs), `tg buy` (the model decides, HTTP 402),
  api3 `tweet-cycle.ts --live --settle-only N` (settle record). The live run fills in from the chain as it happens.
  At most `AGENT_MAX_CYCLES` (default 3) per server start.
- **Show a refusal** (Overview): `tg withdraw` for an intent already used; the watcher refuses (409), nothing moves.
- **Fund the vault / Exit to owner** (Owner view): `tg fund` / `tg exit`; BSV Desktop asks the owner to approve.

On the watcher laptop, with the watcher (`npm run tg -- watcher-serve`) and BSV Desktop running, `bsv/node_modules`
and `api3` dependencies installed and `api3/.env.agent` in place:

```sh
CONFIRM_MAINNET=1 npm run owner-serve   # 127.0.0.1:5820; prints a link with a one-time owner token
```

The default port is 5820: on Windows with WSL mirrored networking the 48xx range can be reserved by Hyper-V.
If the BSV agent's keys live in another checkout, export `TG_ENV_FILE` and `TG_DATA_DIR` before starting it.

**Two laptops (the API3 agent key stays on its own laptop).** On the laptop that holds `api3/.env.agent`:

```sh
node bsv/scripts/api3-agent-serve.mjs          # 127.0.0.1:5830; prints a token
cloudflared tunnel --url http://localhost:5830  # prints an https URL
```

On the demo laptop, start the owner server with that URL and token; the cycle's first step (signed price → SPEND
intent) and last step (settle) then run on the API3 laptop, everything else here:

```sh
CONFIRM_MAINNET=1 API3_AGENT_URL=<tunnel URL> API3_AGENT_TOKEN=<token> npm run owner-serve
```

Do not run `tweet-cycle.ts --live` (or anything else signing with the vault-5 agent key) at the same time.

Open the printed link. The server listens on 127.0.0.1 only, accepts only the dashboard origins
(`OWNER_ORIGINS`, default `http://localhost:8765,http://127.0.0.1:8765`), requires the token on every request, runs one
action at a time and refuses mainnet actions unless started with `CONFIRM_MAINNET=1`. The owner exit returns every
vault coin; the agent cannot spend again until the vault is funded. Only responses from connected sources are shown; there are no bundled examples or fallback amounts.

| Parameter | Default | Purpose |
| --- | --- | --- |
| `?watcher=` | `http://127.0.0.1:4810` | watcher base URL |
| `?rpc=` | `https://sepolia.base.org` | Base Sepolia RPC |
| `?theme=dark` / `light` | dark | colour theme |
| `?ownerApi=` | `http://127.0.0.1:5820` | owner action server |
| `?video=1` | off | video mode (also the V key) |

End-to-end validation of the owner actions is pending your real transaction test. The agent's HTTP 402 payment is shown as the next spend of each withdrawal's float output (WhatsOnChain `/tx/<txid>/<n>/spent`). Public deployment settings are in `dashboard/config.js`; verify them after merging.

## Run

Node.js ≥ 22. Offline tests spend nothing.

```sh
cd bsv
npm ci
npm test                 # 70 offline tests pass (mock chain, real keys/signatures/BEEF); 2 live tests skipped
LIVE_BASE=1 npm test     # + read-only checks against the deployed contract on Base Sepolia
npm run typecheck
npm run sync:api3        # after an API3 interface change: re-copy the ABI (a test fails on drift)
```

Tested versions (BSV stack pinned exactly; `@anthropic-ai/sdk` is `^1.3.0`): `@bsv/sdk` 3.2.1, `@bsv/wallet-toolbox` 2.14.9, `@bsv/overlay` 2.6.4,
`@bsv/btms` 1.2.6, `@bsv/402-pay` 0.3.3, `viem` 2.57.3, `express` 5.3.0.

| Test file | Covers |
| --- | --- |
| `vault-script.test.ts` | interpreter: agent+watcher OK, agent-only / watcher-only / swapped / stranger fail, owner alone OK; mock chain: owner exit through `createAction`/`signAction`, `abortAction` frees coins, cosigned spend accepted |
| `watcher-policy.test.ts` | approve in-bounds; deny overspend (fee counted), wrong recipient, extra payee, change to agent, fee cap, expired / in-margin, settled, SWAP, wrong chain / contract / vault (6, 7, retired), missing/forged receipt, RPC failure, non-vault input, reused UTXO; one intent = one tx across restarts; corrupted journal stops the watcher |
| `execute-swap.test.ts` | swap priced from a signed rate; refuse wrong asset, inflated amount, changed maker payment, price above signed rate, stale rate, swapped merchant key, forged invoice, expired invoice/offer, replay, fake ancestry, overlay offline, moved output 0; insufficient sats leaves the offer fillable |
| `http402.test.ts` | 402 without payment; 402-pay 0.3.3 needs `withHostOriginator`; paid answer, exact merchant credit; guardian approves only declared purchases |
| `integration-mock.test.ts` | intent → watcher → withdrawal → Agent Float → HTTP 402 → owner exits the remainder |
| `api3-readonly.test.ts` | ABI drift, binding from `api3/deployments.json`, live vault 5 reads, live intent #1 (retired vault 2) refused |
| `swap`, `issue`, `guardian` | the rail baseline (16 tests, unchanged) |

## Mainnet CLI

```sh
export TG_ENV_FILE=/path/to/rail/.env TG_DATA_DIR=/path/to/rail/data   # existing agent/merchant wallets; keys are never copied
npm run tg -- watcher-key        # watcher root key in bsv/.env.watcher (separate from the agent's env)
npm run tg -- init               # derive vault keys (BSV Desktop = owner) → data/vault-binding.json
npm run tg -- gate               # gate (1) on the exact script, offline
CONFIRM_MAINNET=1 npm run tg -- fund --sats 3000   # first deposit: owner-exit proof only
CONFIRM_MAINNET=1 npm run tg -- exit               # owner alone, through BSV Desktop
CONFIRM_MAINNET=1 npm run tg -- fund --sats 5000   # allowed only after the exit proof
CONFIRM_MAINNET=1 npm run tg -- withdraw --intent N
CONFIRM_MAINNET=1 npm run tg -- buy
npm run tg -- status
```

## Layout

```text
src/api3/      policyTypes (binding from api3/deployments.json), intentReader (viem, read-only), ABI copy
src/vault/     template (script, derived keys, signatures), proposeSpend, ownerExit
src/watcher/   policy (pure APPROVE/DENY), state (fsync+rename+checksum journal), service
src/agent/     float (fixed BRC-29 float key), buyResearch (402 client)
src/merchant/  paidApi (402 server), signedInvoice, invoice (rail)
src/swap/      executeSwap (mandatory wrapper), offer, fill (rail)
src/flow/      withdraw (agent side of one SPEND)
src/chain/     mockChain, serverWallet (rail), wocUtxos
src/guardian/ src/token/ src/registry/ src/wallet/   rail baseline
scripts/tg.ts  mainnet CLI; other scripts/ are the rail's mainnet scripts
```

## Provenance

`src/{chain,guardian,merchant/invoice.ts,registry,swap/offer.ts,swap/fill.ts,token,wallet/agentWallet.ts}`,
`test/{swap,issue,guardian}.test.ts`, the rail `scripts/` and `docs/verified-facts.md` come
from [Brezn610/BSV_pet](https://github.com/Brezn610/BSV_pet) branch
`claude/handover-docs-sjdxvf` @ `b9ce773` (imported unchanged in commit `8cbf4770c`). That is
pre-event prototype code. During the event it was only renamed from the earlier "AI pet" wording
to "agent" (`761385576`) and the event bus types were trimmed. Everything else under `bsv/` was written on 30 Oct 2026; see `git log -- bsv`.
`withHostOriginator` is copied from the BSV stack guide §10.4.
