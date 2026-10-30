// Tweet-triggered cycle on the team's agent vault (deployments.json → vaultId, 5): a new post of a whitelisted account
// is submitted with a RISK_OFF verdict, a verified post is followed by a small SPEND intent, and the BSV receipt of that
// SPEND is found on WhatsOnChain and settled on Base. The only interface to the BSV side is on-chain: the
// IntentCreated event here, and the TGv1 OP_RETURN of the co-signed withdrawal on BSV.
//
//   node --env-file=.env.agent src/tweet-cycle.ts                     dry run: eth_call only, sends nothing
//   caffeinate -is node --env-file=.env.agent src/tweet-cycle.ts --live --minutes 20
//                                    poll every --interval s (default 60) for --minutes; only posts newer than the start
//   node --env-file=.env.agent src/tweet-cycle.ts --live --once       manual trigger: act on the latest post now
//   node --env-file=.env.agent src/tweet-cycle.ts --live --settle-only <N>   find the receipt of SPEND N and settle it
//   options: --account <name> (default 956_kakashi) --max-ausd <aUSD per run> (default 1) --spend-usd (default 0.001)
//            --verdict risk_off|ignore (default risk_off). IGNORE verifies the post on-chain (PostVerified) but never
//            hedges or changes the regime: a repeatable rehearsal of the whole cycle that keeps the one-shot hedge.
//
// RISK_OFF hedges once per vault: the first verified post moves vault 5 from NORMAL to GUARDED for good, later posts
// only verify. Each poll buys the post (0.01 aUSD), a new post also a price (0.001 aUSD), paid by the agent key. This is
// a deliberate exception to "no polling loops": keep the window short. Run no other process that signs with this key
// (spend5.ts, judge.ts --vault 5) while it runs.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { erc20Abi, type Hex, isHex } from 'viem';
import type { SignedResponse } from './airnode-v2.ts';
import { DEPLOYMENTS_URL, loadDeployment } from './client/deployments.ts';
import { parseTweetData } from './client/feeds.ts';
import {
  ContractRejection,
  createTreasuryGuardClient,
  formatUsd,
  Kind,
  Source,
  usd,
  Verdict,
} from './client/treasury-guard.ts';
import { AUSD_ADDRESS, createPayingFetch } from './x402.ts';

const POST_COST = 10_000n; // 0.01 aUSD per signed post
const PRICE_COST = 1_000n; // 0.001 aUSD per signed price
const AUSD_FLOOR = 3_000_000n; // stop below 3 aUSD: the video and live judging pay from the same wallet
const LOG_FILE = 'logs/tweet-cycle.jsonl';
const STATE_FILE = 'logs/tweet-cycle-state.json';

// The BSV vault's locking script, (agent ∧ watcher) ∨ owner, from bsv/docs/evidence/gate1.json → vaultLockingScript
// on origin/feat/bsv-treasury-guard. WhatsOnChain indexes it by sha256(script), byte-reversed (bsv/src/chain/wocUtxos.ts).
const VAULT_SCRIPT =
  '63210234a28e17b594af1306af67ac7dc9e85e990473a83c9d99448438e96c71f3cb3fad210288c067ae286a2df2c2ec509f3c6898e99e2af18cdf0d434475d5a33669372790ac672102ec58ffef26378e84d5981a17a3f019f457f1d64f77a73770a2ae3c2616c2c242ac68';
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const RECEIPT_POLL_MS = 10_000;
const RECEIPT_TIMEOUT_MS = 15 * 60_000;

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    dry: { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
    minutes: { type: 'string', default: '20' },
    interval: { type: 'string', default: '60' },
    'settle-only': { type: 'string' },
    account: { type: 'string', default: '956_kakashi' },
    'max-ausd': { type: 'string', default: '1' },
    'spend-usd': { type: 'string', default: '0.001' },
    network: { type: 'string', default: 'baseSepolia' },
    deployments: { type: 'string' },
    verdict: { type: 'string', default: 'risk_off' },
  },
});
const verdicts = { risk_off: Verdict.RISK_OFF, ignore: Verdict.IGNORE } as const;
if (!(values.verdict in verdicts)) throw new Error('--verdict must be risk_off or ignore');
const verdictName = values.verdict as keyof typeof verdicts;
const verdict = verdicts[verdictName];
if (values.live && values.dry) throw new Error('Pass --live or --dry, not both');
const live = values.live;

const privateKey = process.env.PRIVATE_KEY;
const payerKey = process.env.PAYER_PRIVATE_KEY ?? privateKey;
const rpcUrl = process.env.RPC_URL;
if (!privateKey || !isHex(privateKey) || !payerKey || !isHex(payerKey) || !rpcUrl) {
  throw new Error('Run with --env-file=.env.agent (PRIVATE_KEY, RPC_URL, optional PAYER_PRIVATE_KEY)');
}

const deployment = loadDeployment(values.network, values.deployments ?? DEPLOYMENTS_URL);
if (deployment.vaultId === null) throw new Error('deployments.json has no vaultId');
const vaultId = BigInt(deployment.vaultId);
const guard = createTreasuryGuardClient({ rpcUrl, privateKey, deployment });
const config = await guard.getVaultConfig(vaultId);
if (config.agent.toLowerCase() !== guard.agent?.toLowerCase()) {
  throw new Error(`This key is not the agent of vault ${vaultId} (${config.agent}): run with --env-file=.env.agent`);
}
const contractLower = guard.address.toLowerCase();
const receiptText = (intentId: bigint) => `TGv1 ${deployment.chainId} ${contractLower} ${vaultId} ${intentId}`;
const explorerTx = (hash: string) => `${deployment.explorer}/tx/${hash}`;

// ---- log and state
mkdirSync('logs', { recursive: true });
const log = (event: string, fields: Record<string, unknown> = {}) => {
  const entry = { at: new Date().toISOString(), event, vaultId: String(vaultId), live, ...fields };
  appendFileSync(
    LOG_FILE,
    `${JSON.stringify(entry, (_, value) => (typeof value === 'bigint' ? String(value) : value))}\n`
  );
  const details = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  console.log(`${entry.at} ${event.padEnd(15)} ${details}`);
};

// Post ids already handled (accepted or rejected), so a restart never submits one again. Dry runs keep their own list.
interface State {
  handled: string[];
}
const stateFile = live ? STATE_FILE : STATE_FILE.replace('.json', '-dry.json');
const readState = (): State => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as State;
  } catch {
    return { handled: [] };
  }
};
const state = existsSync(stateFile) ? readState() : { handled: [] };
const markHandled = (postId: string) => {
  if (!state.handled.includes(postId)) state.handled.push(postId);
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
  renameSync(`${stateFile}.tmp`, stateFile);
};

// ---- x402 spending: a cap per run and a floor on the wallet
const maxAusd = usd(Number(values['max-ausd']));
let ausdSpent = 0n;
const payingFetch = createPayingFetch(payerKey);
const ausdBalance = () =>
  guard.publicClient.readContract({
    address: AUSD_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [guard.agent!],
  });
const canSpend = async (cost: bigint) => {
  if (ausdSpent + cost > maxAusd) return `run cap of ${formatUsd(maxAusd)} aUSD reached`;
  const balance = await ausdBalance();
  if (balance - cost < AUSD_FLOOR)
    return `aUSD balance ${formatUsd(balance)} would fall below ${formatUsd(AUSD_FLOOR)}`;
  return undefined;
};

// ---- WhatsOnChain: find the BSV withdrawal that carries an intent's receipt
const scriptHash = async () => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Buffer.from(VAULT_SCRIPT, 'hex')));
  return Buffer.from(digest.reverse()).toString('hex');
};
const wocJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${WOC}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`WhatsOnChain ${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Every tx of the vault script, mempool first: a receipt counts as soon as it is in the mempool.
const vaultTxids = async (hash: string) => {
  const ids: { txid: string; confirmed: boolean }[] = [];
  for (const [path, confirmed] of [
    ['unconfirmed', false],
    ['confirmed', true],
  ] as const) {
    const body = await wocJson<{ result?: { tx_hash: string }[]; error?: string }>(`/script/${hash}/${path}/history`);
    if (body.error) throw new Error(`WhatsOnChain: ${body.error}`);
    for (const { tx_hash } of body.result ?? []) ids.push({ txid: tx_hash, confirmed });
  }
  return ids;
};

// The data of an `OP_FALSE OP_RETURN <push>` output, as text. One push, as bsv/src/vault/proposeSpend.ts writes it.
export const opReturnText = (scriptHex: string): string | undefined => {
  const bytes = Buffer.from(scriptHex, 'hex');
  let at = bytes[0] === 0x00 && bytes[1] === 0x6a ? 2 : bytes[0] === 0x6a ? 1 : -1;
  if (at < 0 || at >= bytes.length) return undefined;
  const op = bytes[at++]!;
  let length: number;
  if (op < 0x4c) length = op;
  else if (op === 0x4c) length = bytes[at++]!;
  else if (op === 0x4d) ((length = bytes.readUInt16LE(at)), (at += 2));
  else if (op === 0x4e) ((length = bytes.readUInt32LE(at)), (at += 4));
  else return undefined;
  if (at + length !== bytes.length) return undefined;
  return bytes.subarray(at, at + length).toString('utf8');
};

const txReceiptText = async (txid: string) => {
  const tx = await wocJson<{ vout: { scriptPubKey: { hex: string } }[] }>(`/tx/hash/${txid}`);
  return tx.vout.map(({ scriptPubKey }) => opReturnText(scriptPubKey.hex)).find((text) => text?.startsWith('TGv1 '));
};

// Polls until a vault tx carries exactly the intent's receipt. `known` are txids that can't be it (seen before the
// intent existed), so each tx is fetched at most once.
const findReceipt = async (intentId: bigint, known = new Set<string>()) => {
  const hash = await scriptHash();
  const expected = receiptText(intentId);
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      for (const { txid, confirmed } of await vaultTxids(hash)) {
        if (known.has(txid)) continue;
        await sleep(350); // WhatsOnChain allows about 3 requests per second without a key
        const text = await txReceiptText(txid);
        known.add(txid);
        if (text === expected) return { txid, confirmed };
      }
    } catch (error) {
      log('woc-error', { intentId, reason: String(error).split('\n')[0] });
    }
    await sleep(RECEIPT_POLL_MS);
  }
  return undefined;
};

const settleIntent = async (intentId: bigint, known?: Set<string>) => {
  const intent = await guard.getIntent(intentId);
  if (intent.vaultId !== vaultId || Kind[intent.kind] !== 'SPEND') {
    log('settle-skipped', { intentId, reason: `intent is ${Kind[intent.kind]} of vault ${intent.vaultId}` });
    return;
  }
  if (intent.settled) {
    log('already-settled', { intentId, bsvTxid: intent.bsvTxid });
    return;
  }
  log('receipt-wait', { intentId, expect: receiptText(intentId) });
  const receipt = await findReceipt(intentId, known);
  if (!receipt) {
    log('receipt-timeout', { intentId, afterMin: RECEIPT_TIMEOUT_MS / 60_000 });
    return;
  }
  const bsvTxid = `0x${receipt.txid}` as Hex;
  log('receipt-found', {
    intentId,
    bsvTxid: receipt.txid,
    status: receipt.confirmed ? 'confirmed' : 'mempool',
    woc: `https://whatsonchain.com/tx/${receipt.txid}`,
  });
  if (!live) {
    log('dry-settle', { intentId, would: `settle(${intentId}, ${bsvTxid})` });
    return;
  }
  try {
    const { hash } = await guard.settle(intentId, bsvTxid);
    log('settle-sent', { intentId, settleTx: explorerTx(hash) });
  } catch (error) {
    // The BSV side never settles, but a second run of this script might have.
    if (!(error instanceof ContractRejection) || error.errorName !== 'AlreadySettled') throw error;
    log('already-settled', { intentId });
  }
  const after = await guard.getIntent(intentId);
  log('settled', { intentId, settled: after.settled, bsvTxid: after.bsvTxid, match: after.bsvTxid === bsvTxid });
};

// ---- one post through the contract
const rejection = (error: unknown) =>
  error instanceof ContractRejection
    ? error.errorName + (error.args.length ? `(${error.args.join(', ')})` : '')
    : undefined;

const handlePost = async (post: SignedResponse) => {
  const { id: postId, text } = parseTweetData(post.data);
  const short = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  log('post-new', { postId, text: short });

  const stop = await canSpend(PRICE_COST);
  if (stop) return log('stopped', { postId, reason: stop });
  // The same price serves submitEvent and submitPrice: submitEvent only verifies it and doesn't record its timestamp.
  let price: SignedResponse;
  try {
    price = await guard.fetchPrice(payingFetch);
    ausdSpent += PRICE_COST;
  } catch (error) {
    // Not handled: the next poll tries again.
    return log('price-failed', { postId, reason: String(error).split('\n')[0] });
  }
  const spendUsd = usd(Number(values['spend-usd']));

  if (!live) {
    try {
      await guard.checkEvent(vaultId, post, price);
      log('dry-accepted', {
        postId,
        regime: await guard.regime(vaultId),
        would: `submitEvent ${verdictName.toUpperCase()}`,
      });
    } catch (error) {
      const reason = rejection(error);
      if (!reason) throw error;
      markHandled(postId);
      return log('rejected', { postId, reason });
    }
    try {
      const spendId = await guard.simulateSubmitPrice(vaultId, price, spendUsd);
      log('dry-spend', { postId, would: `SPEND #${spendId} for ${formatUsd(spendUsd)} USD` });
    } catch (error) {
      log('dry-spend-rejected', { postId, reason: rejection(error) ?? String(error).split('\n')[0] });
    }
    markHandled(postId);
    return;
  }

  const regimeBefore = await guard.regime(vaultId);
  try {
    const { hash, receipt, intents } = await guard.submitEvent(vaultId, post, price, verdict, '0x');
    const hedge = intents.find(({ args }) => Kind[args.kind] === 'SWAP');
    log('post-verified', {
      postId,
      eventTx: explorerTx(hash),
      regime: `${regimeBefore} → ${await guard.regime(vaultId, receipt.blockNumber)}`,
      verdict: verdictName.toUpperCase(),
      hedge: hedge
        ? `SWAP #${hedge.args.intentId} ${hedge.args.maxBps / 100} %`
        : verdict === Verdict.IGNORE
          ? 'none (verdict IGNORE)'
          : 'none (one-shot already used)',
    });
  } catch (error) {
    const reason = rejection(error);
    if (!reason) throw error;
    markHandled(postId);
    return log('rejected', { postId, reason });
  }
  markHandled(postId);

  // The receipt can only appear after the SPEND exists, so every vault tx seen now is skipped while waiting.
  const known = new Set((await vaultTxids(await scriptHash()).catch(() => [])).map(({ txid }) => txid));
  try {
    const { hash, intents } = await guard.submitPrice(vaultId, price, spendUsd);
    const spend = intents.find(({ args }) => Kind[args.kind] === 'SPEND');
    const others = intents
      .filter((event) => event !== spend)
      .map(({ args }) => `${Kind[args.kind]}/${Source[args.source]} #${args.intentId}`);
    if (!spend) return log('spend-missing', { postId, priceTx: explorerTx(hash) });
    log('spend-created', {
      postId,
      spendId: spend.args.intentId,
      maxSats: spend.args.maxSats,
      priceTx: explorerTx(hash),
      ...(others.length ? { alsoCreated: others.join(', ') } : {}),
    });
    await settleIntent(spend.args.intentId, known);
  } catch (error) {
    const reason = rejection(error);
    if (!reason) throw error;
    log('spend-rejected', { postId, reason });
  }
};

// ---- one poll of the post feed
const poll = async ({ baseline = false } = {}) => {
  const stop = await canSpend(POST_COST);
  if (stop) {
    log('stopped', { reason: stop });
    return false;
  }
  let post: SignedResponse;
  try {
    post = await guard.fetchPost(values.account, payingFetch);
    ausdSpent += POST_COST;
  } catch (error) {
    // Network errors and responses that fail the off-chain signature check alike: nothing was submitted.
    log('post-fetch-failed', { reason: String(error).split('\n')[0] });
    return true;
  }
  const { id: postId } = parseTweetData(post.data);
  if (state.handled.includes(postId)) {
    // Quiet while polling, but a manual trigger should say why it did nothing.
    if (values.once) log('post-known', { postId, note: 'already handled, nothing sent' });
    return true;
  }
  if (baseline) {
    markHandled(postId);
    log('baseline', { postId, note: 'present at start, not acted on' });
    return true;
  }
  await handlePost(post);
  return true;
};

// ---- main
const startBalance = await ausdBalance();
log('start', {
  agent: guard.agent,
  account: values.account,
  mode: values['settle-only']
    ? `settle-only ${values['settle-only']}`
    : values.once
      ? 'once'
      : `poll ${values.interval} s × ${values.minutes} min`,
  regime: await guard.regime(vaultId),
  verdict: verdictName.toUpperCase(),
  ausd: formatUsd(startBalance),
  cap: formatUsd(maxAusd),
});

// Any failure still ends with a stop line. After spend-created, recover with --settle-only <N>.
try {
  if (values['settle-only']) {
    await settleIntent(BigInt(values['settle-only']));
  } else if (values.once) {
    await poll();
  } else {
    const until = Date.now() + Number(values.minutes) * 60_000;
    let keepGoing = await poll({ baseline: true });
    while (keepGoing && Date.now() + Number(values.interval) * 1000 < until) {
      await sleep(Number(values.interval) * 1000);
      try {
        keepGoing = await poll();
      } catch (error) {
        log('error', { reason: String(error).split('\n')[0] });
      }
    }
  }
} catch (error) {
  log('error', { reason: String(error).split('\n')[0] });
  process.exitCode = 1;
}
log('stop', { ausdSpent: formatUsd(ausdSpent) });
