// Autonomous agent, Base side: runs runBaseCycle on its own vault, forever, without a person starting each cycle.
// Every cycle buys a signed BSV/USD price via x402 (when worth it), submits it, and the contract runs the budget and
// circuit breaker on it. Schedule: every 10 min, every 2 min near the breaker threshold or outside NORMAL. Limits: at
// most DAILY_AUSD_CAP for data per UTC day, the vault's USD budget on-chain, one heartbeat SPEND per day. Failures back
// off exponentially. Every cycle, also a skipped one, is appended to logs/agent-cycles.jsonl.
//
//   caffeinate -is node --env-file=.env.runner src/agent.ts          run until stopped (Ctrl+C)
//   node --env-file=.env.runner src/agent.ts --once                  one cycle, then exit
//
// It runs on deployments.json → runnerVaultId with its own key (.env.runner) and refuses the team's agent vault and the
// judge vaults, so it never shares a key, nonce, budget or last price with another process.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isHex } from 'viem';
import { type CycleResult, type CycleState, initialCycleState, runBaseCycle } from './client/base-cycle.ts';
import { DEPLOYMENTS_URL, loadDeployment } from './client/deployments.ts';
import { createTreasuryGuardClient, usd } from './client/treasury-guard.ts';
import { createPayingFetch } from './x402.ts';

const DAILY_AUSD_CAP = 500_000n; // 0.5 aUSD per UTC day for signed data
const HEARTBEAT_USD = usd(0.01); // one tiny SPEND per day, so the budget path runs live too
const LOG_FILE = 'logs/agent-cycles.jsonl';
const STATE_FILE = 'logs/agent-state.json';

const { values } = parseArgs({
  options: {
    once: { type: 'boolean', default: false },
    vault: { type: 'string' },
    network: { type: 'string', default: 'baseSepolia' },
    deployments: { type: 'string' },
  },
});

const privateKey = process.env.PRIVATE_KEY;
const payerKey = process.env.PAYER_PRIVATE_KEY ?? privateKey;
const rpcUrl = process.env.RPC_URL;
if (!privateKey || !isHex(privateKey) || !payerKey || !isHex(payerKey) || !rpcUrl) {
  throw new Error('Run with --env-file=.env.runner (PRIVATE_KEY, RPC_URL, optional PAYER_PRIVATE_KEY)');
}

const deployment = loadDeployment(values.network, values.deployments ?? DEPLOYMENTS_URL);
const vaultId = BigInt(values.vault ?? deployment.runnerVaultId ?? 0);
const reserved = [deployment.vaultId, deployment.judgeVaultId, deployment.liveJudgeVaultId].filter(
  (id): id is number => id !== null && id !== undefined
);
if (vaultId === 0n) throw new Error('No vault: set runnerVaultId in deployments.json or pass --vault <id>');
if (reserved.some((id) => BigInt(id) === vaultId)) {
  throw new Error(`Vault ${vaultId} belongs to the team's agent or the judge script. The runner needs its own vault`);
}

const guard = createTreasuryGuardClient({ rpcUrl, privateKey, deployment });
const config = await guard.getVaultConfig(vaultId);
if (config.agent.toLowerCase() !== guard.agent?.toLowerCase()) {
  throw new Error(`This key is not the agent of vault ${vaultId} (${config.agent})`);
}
const payingFetch = createPayingFetch(payerKey);

// A state file broken by a crash mid-write starts fresh instead of stopping the agent.
const readState = (): CycleState => {
  try {
    return { ...initialCycleState(), ...(JSON.parse(readFileSync(STATE_FILE, 'utf8')) as CycleState) };
  } catch {
    return initialCycleState();
  }
};
const state = existsSync(STATE_FILE) ? readState() : initialCycleState();
mkdirSync('logs', { recursive: true });

const report = (result: CycleResult) => {
  appendFileSync(LOG_FILE, `${JSON.stringify(result)}\n`);
  // Written to a temp file and renamed, so a crash never leaves half a state file.
  writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state));
  renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  const intents = result.intents.map((intent) => ` ${intent.kind}/${intent.source} #${intent.intentId}`).join('');
  const tx = result.txHash ? ` ${deployment.explorer}/tx/${result.txHash}` : '';
  console.log(
    `${result.at} ${result.action.padEnd(9)} ${[result.reason, result.price && `BSV ${result.price.toFixed(4)} USD, 1h ${result.change1h?.toFixed(2)} %`, result.regime].filter(Boolean).join(', ')}` +
      `${intents}${tx} | aUSD today ${Number(result.aUsdSpentToday) / 1e6} | next in ${Math.round(result.nextDelayMs / 1000)} s (${result.nextReason})`
  );
};

console.log(
  `Agent on TreasuryGuard ${guard.address}, vault ${vaultId}, agent ${guard.agent}. Cap ${Number(DAILY_AUSD_CAP) / 1e6} aUSD/day, log ${LOG_FILE}`
);

let timer: ReturnType<typeof setTimeout> | undefined;
// Whatever happens in a cycle or in writing its log, the next cycle is always scheduled.
const cycle = async () => {
  let nextDelayMs = 600_000;
  try {
    const result = await runBaseCycle(guard, vaultId, payingFetch, state, {
      dailyAusdCap: DAILY_AUSD_CAP,
      heartbeatUsd: HEARTBEAT_USD,
    });
    nextDelayMs = result.nextDelayMs;
    report(result);
  } catch (error) {
    console.error(`${new Date().toISOString()} cycle failed: ${String(error).split('\n')[0]}`);
  } finally {
    if (!values.once) timer = setTimeout(() => void cycle(), nextDelayMs);
  }
};
process.on('SIGINT', () => {
  clearTimeout(timer);
  console.log('Stopped.');
  process.exit(0);
});
await cycle();
