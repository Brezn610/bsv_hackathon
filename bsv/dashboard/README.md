# Treasury Guard dashboard

Open `index.html` directly, or serve this folder with a static server (`python3 -m http.server -d dashboard 8765`
from `bsv/`). No build or dependencies are required.

Only data read from the configured watcher, Base Sepolia and WhatsOnChain is displayed. No demo transactions,
recorded examples, fixture responses, fallback balances or stored results are loaded. Disconnected sources show
unavailable or waiting states, not zero balances or successful tests. `config.js` holds public connection settings
only. The page never signs, never broadcasts and holds no key.

## Views

| View | What it shows | Sources |
| --- | --- | --- |
| Overview | The two chains side by side, the latest vault-5 payment as a timeline (each step tagged API3, Base, Watcher or BSV), live proofs and the watcher's decisions | all |
| API3 · Signed data | The latest signed BSV/USD price and its checks, dollars → `maxSats`, the tamper test, the crash guard (1 h change against the breaker), the news guard (whitelist read with `isPostRequest`), accepted prices of the last hour | Base Sepolia |
| BSV · Vault & payments | The vault script decoded into its two branches, the balance, every transaction that touched the script (fund, co-signed withdrawal, owner exit), fees, the agent's HTTP 402 payments | WhatsOnChain |
| Owner | Fund and exit through the owner action server, and the owner exits found on chain | owner server, WhatsOnChain |
| Transactions | One row per vault-5 SPEND intent across both chains | all |

**Tamper test.** The page takes the newest signed price TreasuryGuard accepted (the `submitPrice` calldata holds the
response exactly as the agent sent it) and asks `checkPrice` with a free `eth_call`: the untouched response, then four
copies with one change each (price halved, timestamp moved to now, request hash of CoinPaprika BTC/USD, one signature
byte changed). It checks them on a judge or demo vault that has the same Airnode, request and age rules and has not
seen this price, so the untouched one is valid while it is younger than 5 minutes; the runner (vault 8) signs a new one
about every 10 minutes. The panel shows how long the current price stays fresh. Anyone can paste their own signed
response (for example `api3/cache/judge-last-price.json` from `judge.ts`, or a file in `api3/test/fixtures/`).

**Vault history and fees.** WhatsOnChain `/script/<hash>/history` lists every transaction of the vault script. Each is
classified from its inputs: `<watcherSig> <agentSig> OP_1` is a co-signed withdrawal, `<ownerSig> OP_0` an owner
exit, an output to the script without a vault input a deposit. A fee is inputs minus outputs where every input is a
known vault coin. The agent's HTTP 402 payment is the next spend of each withdrawal's float output
(`/tx/<txid>/<n>/spent`).

## Video mode

Press **V** (or open `?video=1`). Type grows for a 1080p recording, the footer hides, and a caption bar names the
chapter. **→ / ←** (or PageDown / PageUp) move between nine chapters; each opens its view, scrolls to the panel and
highlights it. **1–9** jump, **C** hides the captions, **Esc** leaves. The chapters follow the judging briefing's 2:30
structure, and each shows its suggested start time:

| Start | Chapter | On screen |
| --- | --- | --- |
| 0:00 | The problem | Overview heading |
| 0:15 | Two chains, two jobs | The API3 and BSV lanes |
| 0:25 | The agent pays for data | Click **Run the agent**; the timeline fills in |
| 1:05 | A replay is refused | Click **Show a refusal**; HTTP 409 |
| 1:15 | Tamper test: one valid, four rejected | Click **Run the tamper test** while the price is fresh |
| 1:45 | Non-custodial | The vault script |
| 1:55 | The owner exits alone | Owner exits on mainnet |
| 2:05 | Why BSV | Fees per action |
| 2:20 | What comes next | Live proofs |

Before recording: start the watcher and the owner action server (see `bsv/README.md`), open the link the owner server
prints, check that the API3 runner has signed a price in the last few minutes, and pass a keyed Base Sepolia RPC with
`?rpc=` if the public one rate-limits (it answers HTTP 429 under load).

## Explain mode

Presentation only, for screen recordings. Off by default: open `?explain=1` or press **E** (E again turns it off).
Each click below opens a centred pop-up with a 6–12 s animation of what happens behind that step, a one-line
caption, **Replay** and **Close**:

| Click | Pop-up |
| --- | --- |
| A step of the payment timeline | Signed price · TreasuryGuard checks and the SPEND intent · watcher check · vault spend · HTTP 402 · settle |
| **Run the agent** | Signed price (the run keeps going underneath) |
| **Replay #N** | Replay refused (HTTP 409) |
| **Run the tamper test** | The panel's five cases, in its order, with the contract's errors |
| **Fund 5,000 sats** / **Yes, fund it** | The deposit and who can spend it |
| **Exit** (after typing EXIT) | The owner exits alone |
| The vault or the owner panel | Vault spend · owner exit |

A finished step of a live run gets an **Explain this step** chip instead of a pop-up, so a recording is never
interrupted. **Esc**, **Space**, **Enter** or a click outside closes the pop-up; while it is open it takes every key,
so Esc does not leave video mode. Reduced motion shows the final frame.

The pop-ups read only what the page already shows (the timeline, the API3 strip). Where the page has no value, the
pop-up uses intent 9 from 31 Oct and says so: "Recorded example" with its transaction id. Explain mode adds no
request, no key and no signing, and it never starts an action: the buttons above run exactly as without it, and the
pop-up opens after the page has handled the click.

## Parameters

| Parameter | Default | Purpose |
| --- | --- | --- |
| `?watcher=` | `http://127.0.0.1:4810` | watcher base URL |
| `?rpc=` | `https://sepolia.base.org` | Base Sepolia RPC |
| `?woc=` | WhatsOnChain mainnet API | BSV reads |
| `?ownerApi=` | `http://127.0.0.1:5820` | owner action server |
| `?theme=dark` / `light` | dark | colour theme |
| `?video=1` | off | video mode |
| `?explain=1` | off | explain mode (pop-ups for recordings) |

Watcher co-signing is separate from broadcast, and a Base settle is a record written by the agent, not cross-chain
verification. See [DESIGN.md](DESIGN.md) for the visual system and what was checked.
