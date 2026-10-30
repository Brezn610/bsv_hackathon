// Judge script: one fresh signed BSV/USD price, then the tamper test against the deployed TreasuryGuard.
// Every rejected case runs as eth_call (checkPrice / a simulated submitPrice), so it costs nothing and shows the error the
// contract reverts with. Only the valid case sends a transaction, and it creates a real SPEND intent.
// It runs on the judge vault (deployments.json → judgeVaultId) with the deployer key, never on the agent's vault.
// x402 is paid by the agent key: only PAYER_PRIVATE_KEY is read from .env.agent.
//
//   node --env-file=.env src/judge.ts                 fetch a fresh price via x402 (0.001 aUSD) and run all cases
//   node --env-file=.env src/judge.ts --file r.json   use a saved response instead (it must still be fresh)
//   options: --dry (no transaction) --usd <dollars> (default 1) --vault <id> (default: judgeVaultId)
//            --live (use liveJudgeVaultId, the vault kept fresh for the one real hedge at live judging)
//            --post <account> (also buy that account's latest post, 0.01 aUSD: without --dry, a fresh original post
//            gets a RISK_OFF verdict and a REAL hedge intent, once per vault; anything else shows what checkEvent says)
//            --post-file <r.json> (a saved post instead of --post)
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
  Verdict,
} from './client/treasury-guard.ts';
import { createPayingFetch, readPaymentSettlement } from './x402.ts';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    vault: { type: 'string' },
    usd: { type: 'string', default: '1' },
    dry: { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    post: { type: 'string' },
    'post-file': { type: 'string' },
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

if (values.post && values['post-file']) throw new Error('Pass --post or --post-file, not both');
const deployment = loadDeployment(values.network, values.deployments ?? DEPLOYMENTS_URL);
const vaultId = BigInt(values.vault ?? (values.live ? deployment.liveJudgeVaultId : deployment.judgeVaultId) ?? 0);
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
// Checked before anything is paid for: a wrong key would only waste an x402 payment.
const config = await guard.getVaultConfig(vaultId);
if (config.agent.toLowerCase() !== guard.agent?.toLowerCase()) {
  throw new Error(`PRIVATE_KEY is not the agent of vault ${vaultId} (${config.agent}): run with --env-file=.env`);
}
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
console.log(`  data: ${fresh.data}`);
console.log(`  BSV = ${price} USD, 1h change ${change1h} %, measured ${updatedAt}`);
console.log(
  `  signed ${signatureAge(fresh, now)} s ago (max ${config.maxSignatureAge} s), signature checked off-chain ✓\n`
);

// A price close to the limit could expire between the checks and the transaction, and a price the vault already
// accepted reads Replay everywhere: both would show failures that say nothing about the tamper checks.
const HEADROOM = 60;
if (signatureAge(fresh, now) + HEADROOM > config.maxSignatureAge) {
  throw new Error(
    `The price is ${signatureAge(fresh, now)} s old, too close to the ${config.maxSignatureAge} s limit. Run without --file to buy one`
  );
}
if (BigInt(fresh.timestamp) <= (await guard.lastPrice(vaultId)).signedAt) {
  throw new Error('This vault already accepted this price (or a newer one). Run without --file to buy a new one');
}

interface IntentArgs {
  intentId: bigint;
  kind: number;
  direction: number;
  source: number;
  maxSats: bigint;
  maxBps: number;
  price: bigint;
  expiry: bigint;
}
const printIntent = (args: IntentArgs) =>
  console.log(
    `  IntentCreated #${args.intentId}: ${Kind[args.kind]} ${Direction[args.direction]} from ${Source[args.source]}, ` +
      `maxSats ${args.maxSats}, maxBps ${args.maxBps}, price ${formatPrice(args.price)}, ` +
      `expires ${new Date(Number(args.expiry) * 1000).toISOString()}`
  );

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
  const name = `Valid + fresh: SPEND ${formatUsd(usdAmount)} USD`;
  try {
    const { hash, receipt, intents } = await guard.submitPrice(vaultId, fresh, usdAmount);
    const spend = intents.find((event) => Kind[event.args.kind] === 'SPEND');
    results.push({
      name,
      expected: 'SPEND intent',
      got: spend ? `intent #${spend.args.intentId}` : 'no SPEND intent',
      pass: spend !== undefined,
    });
    console.log(`Valid case sent: ${explorerTx(hash)}`);
    intents.forEach(({ args }) => printIntent(args));
    console.log(`  budget today: ${formatUsd(remaining)} → ${formatUsd(remaining - usdAmount)} USD\n`);
    // Read at the receipt's block, so a lagging RPC node can't answer from before the transaction.
    await expectReject('Same response again', 'Replay', () => guard.checkPrice(vaultId, fresh, receipt.blockNumber));
  } catch (error) {
    if (!(error instanceof ContractRejection)) throw error;
    results.push({ name, expected: 'SPEND intent', got: error.errorName, pass: false });
  }
}

// A stale post can't be forced live (it depends on when the account last posted); the Forge tests cover it with
// vm.warp. Here the latest real post is checked and whatever the contract says is shown.
let post: SignedResponse | undefined;
if (values.post || values['post-file']) {
  if (values['post-file']) {
    post = JSON.parse(readFileSync(values['post-file'], 'utf8')) as SignedResponse;
    console.log(`Post from ${values['post-file']}`);
  } else {
    console.log(`Fetching the latest post of @${values.post} from the TwitterAPI.io Airnode...`);
    // An account without any post answers 400 "no value at /data/tweets/0/id": shown as info, not a crash.
    post = await guard.fetchPost(values.post!, payingFetch()).catch((error: Error) => {
      results.push({
        name: `Latest @${values.post} post (info)`,
        expected: 'any',
        got: error.message,
        pass: undefined,
      });
      return undefined;
    });
  }
}
if (post) {
  console.log(`  data: ${post.data}`);
  const got = await outcome(() => guard.checkEvent(vaultId, post, fresh));
  if (got !== 'accepted' || values.dry) {
    // An old post or a retweet is a normal answer, not a failure: it depends on what the account last posted.
    results.push({ name: `Latest post (info${values.dry ? ', --dry' : ''})`, expected: 'any', got, pass: undefined });
  } else if ((await guard.regime(vaultId)) !== 'NORMAL') {
    // Only a NORMAL vault hedges on a post. Sending it anyway would use up the post for no hedge.
    const regime = await guard.regime(vaultId);
    results.push({
      name: 'Fresh original post (vault already hedged)',
      expected: 'any',
      got: `not sent: vault is ${regime}, use --live or a fresh judge vault`,
      pass: undefined,
    });
  } else {
    const name = 'Fresh original post + RISK_OFF verdict';
    try {
      const { hash, receipt, intents } = await guard.submitEvent(vaultId, post, fresh, Verdict.RISK_OFF);
      const hedge = intents.find((event) => Kind[event.args.kind] === 'SWAP');
      results.push({
        name,
        expected: 'hedge intent',
        got: hedge ? `intent #${hedge.args.intentId}, ${hedge.args.maxBps / 100} % of the vault` : 'no hedge intent',
        pass: hedge !== undefined,
      });
      console.log(`Event sent: ${explorerTx(hash)}`);
      intents.forEach(({ args }) => printIntent(args));
      console.log(`  regime: NORMAL → ${await guard.regime(vaultId, receipt.blockNumber)}\n`);
      await expectReject('Same post again', 'Replay', () =>
        guard.checkEvent(vaultId, post, fresh, receipt.blockNumber)
      );
    } catch (error) {
      // e.g. Cooldown: checkEvent leaves out that verdict-dependent check by design.
      if (!(error instanceof ContractRejection)) throw error;
      results.push({ name, expected: 'hedge intent', got: error.errorName, pass: false });
    }
  }
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
