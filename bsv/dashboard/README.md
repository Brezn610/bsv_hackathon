# Treasury Guard dashboard

Open `index.html` directly, or serve this folder with a static server. No build or dependencies are required.

Only data read from the configured watcher, Base Sepolia and WhatsOnChain is displayed. No demo transactions, recorded examples, fixture responses, fallback balances or stored results are loaded. Disconnected sources show unavailable/waiting states, not zero balances or successful tests. Historical transactions may appear only if returned by the actual configured chain.

`config.js` contains public connection settings. Verify the contract, vault and script configuration after merging before your live test. Optional `watcher`, `rpc`, `woc`, and `theme` query parameters configure endpoints and appearance. Do not put secret credentials in URLs. The former recorded mode is removed.

HTTP 402 purchases need a real receipt source and are shown as not connected. Owner exit and end-to-end testing remain pending. The dashboard cannot sign, broadcast or move funds. Watcher co-signing is separate from broadcast, and Base settlement is not cross-chain verification.
