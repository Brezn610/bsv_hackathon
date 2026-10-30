# Treasury Guard dashboard

Open `index.html` directly, or serve this folder with a static server. No build or dependencies are required.

Only data read from the configured watcher, Base Sepolia and WhatsOnChain is displayed. No demo transactions, recorded examples, fixture responses, fallback balances or stored results are loaded. Disconnected sources show unavailable/waiting states, not zero balances or successful tests. Historical transactions may appear only if returned by the actual configured chain.

`config.js` contains public connection settings. Verify the contract, vault and script configuration after merging before your live test. Optional `watcher`, `rpc`, `woc`, and `theme` query parameters configure endpoints and appearance. Do not put secret credentials in URLs. The former recorded mode is removed.

The agent's HTTP 402 payment is read as the next spend of each withdrawal's float output (WhatsOnChain `/tx/<txid>/<n>/spent`); output 0 of that transaction is the amount paid, and any other transaction shape is shown without an amount. Owner exit and end-to-end testing remain pending. The dashboard cannot sign, broadcast or move funds. Watcher co-signing is separate from broadcast, and Base settlement is not cross-chain verification.

The audience is judges at the TUM hackathon, watching a live projector demo.

The wide column holds watcher decisions and a thin-line payment path. A narrow account margin holds vault balance, daily budget and amounts paid to the agent. The transaction ledger spans both columns. On phones, decisions and the ledger precede account context. Signed-price details, validation and connection information expand on demand. Tabs retain arrow-key navigation and tables retain keyboard scrolling.

The visual system uses local humanist sans and monospace font stacks, five type sizes, neutral surfaces and one teal accent. Green and red identify approval/refusal decisions. Sources remain quiet text, with cached and unavailable states explicitly labelled. Only newly arriving decisions animate, for 200 ms; reduced motion disables the highlight.

See [DESIGN-REVIEW.md](DESIGN-REVIEW.md) for the source audit, checks and browser-verification limitations.
