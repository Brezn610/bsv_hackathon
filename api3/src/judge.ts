// Judge script: one fresh signed BSV/USD price, then the tamper test against the deployed TreasuryGuard.
// Every rejected case runs as eth_call (checkPrice / a simulated submitPrice), so it costs nothing and shows the error the
// contract reverts with. Only the valid case sends a transaction, and it creates a real SPEND intent.
// It runs on the judge vault (deployments.json → judgeVaultId) with the deployer key, never on the agent's vault.
// x402 is paid by the agent key: only PAYER_PRIVATE_KEY is read from .env.agent.
//
//   node --env-file=.env src/judge.ts                 fetch a fresh price via x402 (0.001 aUSD) and run all cases
//   node --env-file=.env src/judge.ts --file r.json   use a saved response instead (it must still be fresh)
//   options: --dry (no transaction) --usd <dollars> (default 1) --vault <id> (default: judgeVaultId)
//            --post <account> (also buy that account's latest post, 0.01 aUSD, and show what checkEvent says)
//            --network <name> --deployments <path> (default baseSepolia, deployments.json)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { type Hex, isHex } from 'viem';
import { type SignedResponse, verifySignedResponse } from './airnode-v2.ts';
import { DEPLOYMENTS_URL, loadDeployment } from './client/deployments.ts';
import { parsePriceData } from './client/feeds.ts';
import { editDigit, resignWithLocalKey, signatureAge } from './client/tamper.ts';
import {
  ContractRejection,
  createTreasuryGuardClient,
  Direction,
  formatPrice,
  formatUsd,
  Kind,
  Source,
  usd,
} from './client/treasury-guard.ts';
import { createPayingFetch, readPaymentSettlement } from './x402.ts';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    vault: { type: 'string' },
    usd: { type: 'string', default: '1' },
    dry: { type: 'boolean', default: false },
    post: { type: 'string' },
    network: { type: 'string', default: 'baseSepolia' },
    deployments: { type: 'string' },
  },
});

const readHexEnv = (name: string, env: Record<string, string | undefined> = process.env, file = '.env'): Hex => {
  const value = env[name];
  if (!value || !isHex(value)) throw new Error(`Set ${name} (0x-prefixed) in ${file}`);
  return value;
};
const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) throw new Error('Set RPC_URL in .env');
const readPayerKey = () =>
  process.env.PAYER_PRIVATE_KEY
    ? readHexEnv('PAYER_PRIVATE_KEY')
    : readHexEnv('PAYER_PRIVATE_KEY', parseEnv(readFileSync('.env.agent', 'utf8')), '.env.agent');

const readFixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8')) as SignedResponse;

const deployment = loadDeployment(values.network, values.deployments ?? DEPLOYMENTS_URL);
const vaultId = BigInt(values.vault ?? deployment.judgeVaultId ?? 0);
if (vaultId === 0n) throw new Error('No vault: pass --vault <id> or set judgeVaultId in deployments.json');
if (deployment.vaultId !== null && vaultId === BigInt(deployment.vaultId)) {
  throw new Error(
    `Vault ${vaultId} is the agent's: the judge would use up its budget and last price. Use the judge vault`
  );
}
const guard = createTreasuryGuardClient({ rpcUrl, privateKey: readHexEnv('PRIVATE_KEY'), deployment });
const explorerTx = (hash: string) => (deployment.explorer ? `${deployment.explorer}/tx/${hash}` : hash);

const payingFetch = (): typeof fetch => {
  const paying = createPayingFetch(readPayerKey());
  return async (input, init) => {
    const response = await paying(input, init);
    const settlement = readPaymentSettlement(response);
    if (settlement?.success) console.log(`  x402 paid in aUSD: ${explorerTx(settlement.transaction)}`);
    return response;
  };
};

// ---- the fresh price every case starts from
console.log(`TreasuryGuard ${guard.address} on ${values.network}, vault ${vaultId}, agent ${guard.agent}\n`);
let fresh: SignedResponse;
if (values.file) {
  fresh = JSON.parse(readFileSync(values.file, 'utf8')) as SignedResponse;
  console.log(`Price from ${values.file}`);
  await verifySignedResponse(fresh, deployment.feeds.bsvUsd.airnode, deployment.feeds.bsvUsd.requestHash);
} else {
  console.log('Fetching a signed BSV/USD price from the CoinPaprika Airnode...');
  fresh = await guard.fetchPrice(payingFetch());
  // Saved so a run can be repeated or shown again without paying, as long as it is still fresh.
  mkdirSync('cache', { recursive: true });
  writeFileSync('cache/judge-last-price.json', JSON.stringify(fresh, null, 2));
  console.log('  saved to cache/judge-last-price.json (gitignored)');
}
const { price, change1h, updatedAt } = parsePriceData(fresh.data);
const now = Number((await guard.publicClient.getBlock()).timestamp);
const config = await guard.getVaultConfig(vaultId);
if (config.agent.toLowerCase() !== guard.agent?.toLowerCase()) {
  throw new Error(`PRIVATE_KEY is not the agent of vault ${vaultId} (${config.agent}): run with --env-file=.env`);
}
console.log(`  data: ${fresh.data}`);
console.log(`  BSV = ${price} USD, 1h change ${change1h} %, measured ${updatedAt}`);
console.log(
  `  signed ${signatureAge(fresh, now)} s ago (max ${config.maxSignatureAge} s), signature checked off-chain ✓\n`
);

if (signatureAge(fresh, now) > config.maxSignatureAge) {
  throw new Error(
    'The price is no longer fresh, so every case would read StaleSignature. Run without --file to buy one'
  );
}

// ---- the cases
interface Result {
  name: string;
  expected: string;
  got: string;
  pass: boolean | undefined;
}
const results: Result[] = [];

const outcome = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return 'accepted';
  } catch (error) {
    if (error instanceof ContractRejection) return error.errorName;
    throw error;
  }
};
const expectReject = async (name: string, expected: string, run: () => Promise<unknown>) => {
  const got = await outcome(run);
  results.push({ name, expected, got, pass: got === expected });
};
const skip = (name: string, expected: string, why: string) =>
  results.push({ name, expected, got: `skipped: ${why}`, pass: undefined });

const edited = editDigit(fresh);
const short = (value: number) => value.toFixed(2);
await expectReject(
  `Edited price ${short(price)} → ${short(parsePriceData(edited.data).price)}, same signature`,
  'SignerMismatch',
  () => guard.checkPrice(vaultId, edited)
);
const { response: localSigned, signer: localSigner } = await resignWithLocalKey(fresh);
await expectReject(`Re-signed by a local key ${localSigner.slice(0, 10)}…`, 'SignerMismatch', () =>
  guard.checkPrice(vaultId, localSigned)
);
await expectReject('Other request (BTC/USD instead of BSV/USD)', 'WrongRequest', () =>
  guard.checkPrice(vaultId, readFixture('coinpaprika-btc-usd.json'))
);
const old = readFixture('coinpaprika-bsv-usd.json');
if (signatureAge(old, now) > config.maxSignatureAge) {
  await expectReject(`Too old (real signature, ${signatureAge(old, now)} s)`, 'StaleSignature', () =>
    guard.checkPrice(vaultId, old)
  );
} else skip('Too old', 'StaleSignature', 'the cached price is still fresh on this chain');

const remaining = await guard.remainingUsdToday(vaultId);
await expectReject(`Over budget (${formatUsd(remaining + 1n)} USD > remaining today)`, 'BudgetExceeded', () =>
  guard.simulateSubmitPrice(vaultId, fresh, remaining + 1n)
);

const usdAmount = usd(Number(values.usd));
if (values.dry) {
  await expectReject('Valid + fresh (eth_call only, --dry)', 'accepted', () => guard.checkPrice(vaultId, fresh));
  skip('Same response again', 'Replay', '--dry sends no transaction');
} else {
  const before = remaining;
  const { hash, intents } = await guard.submitPrice(vaultId, fresh, usdAmount);
  const spend = intents.find((event) => Kind[event.args.kind] === 'SPEND');
  results.push({
    name: `Valid + fresh: SPEND ${formatUsd(usdAmount)} USD`,
    expected: 'SPEND intent',
    got: spend ? `intent #${spend.args.intentId}` : 'no SPEND intent',
    pass: spend !== undefined,
  });
  console.log(`Valid case sent: ${explorerTx(hash)}`);
  for (const { args } of intents) {
    console.log(
      `  IntentCreated #${args.intentId}: ${Kind[args.kind]} ${Direction[args.direction]} from ${Source[args.source]}, ` +
        `maxSats ${args.maxSats}, maxBps ${args.maxBps}, price ${formatPrice(args.price)}, ` +
        `expires ${new Date(Number(args.expiry) * 1000).toISOString()}`
    );
  }
  console.log(`  budget today: ${formatUsd(before)} → ${formatUsd(await guard.remainingUsdToday(vaultId))} USD\n`);
  await expectReject('Same response again', 'Replay', () => guard.checkPrice(vaultId, fresh));
}

// A stale post can't be forced live (it depends on when the account last posted); the Forge tests cover it with
// vm.warp. Here the latest real post is checked and whatever the contract says is shown.
if (values.post) {
  console.log(`Fetching the latest post of @${values.post} from the TwitterAPI.io Airnode...`);
  const post = await guard.fetchPost(values.post, payingFetch());
  console.log(`  data: ${post.data}`);
  const got = await outcome(() => guard.checkEvent(vaultId, post, fresh));
  results.push({ name: `Latest @${values.post} post (info)`, expected: 'any', got, pass: undefined });
}

// ---- report
console.log('\nTamper test');
for (const { name, expected, got, pass } of results) {
  const mark = pass === undefined ? '  -  ' : pass ? 'PASS ' : 'FAIL ';
  console.log(`${mark} ${name.padEnd(52)} expected ${expected.padEnd(15)} got ${got}`);
}
const failed = results.filter(({ pass }) => pass === false).length;
console.log(failed ? `\n${failed} case(s) FAILED` : '\nAll cases passed');
process.exitCode = failed ? 1 : 0;
