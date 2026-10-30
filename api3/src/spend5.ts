// One fresh SPEND intent on vault 5 for the BSV watcher. Run in api3/:  node --env-file=.env.agent src/spend5.ts
import { createTreasuryGuardClient, usd } from './client/treasury-guard.ts';
import { createPayingFetch } from './x402.ts';

const key = process.env.PRIVATE_KEY as `0x${string}`;
const payer = (process.env.PAYER_PRIVATE_KEY ?? key) as `0x${string}`;
const guard = createTreasuryGuardClient({ rpcUrl: process.env.RPC_URL!, privateKey: key });
const price = await guard.fetchPrice(createPayingFetch(payer)); // ~0.001 aUSD via x402
const { hash, intents } = await guard.submitPrice(5n, price, usd(0.001)); // $0.001 → ~5,800 sats
console.log(`https://sepolia.basescan.org/tx/${hash}`);
for (const e of intents) console.log('intentId', e.args.intentId, 'kind', e.args.kind, 'maxSats', e.args.maxSats);
