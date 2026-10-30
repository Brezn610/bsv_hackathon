import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SignedResponse } from '../airnode-v2.ts';
import { type CycleGuard, initialCycleState, runBaseCycle } from './base-cycle.ts';
import { ContractRejection } from './treasury-guard.ts';

const NOW = Date.UTC(2026, 9, 30, 22, 0, 0);
const price = (change1h: number): SignedResponse => ({
  airnode: '0x0000000000000000000000000000000000000001',
  requestHash: '0x18b782163c79529c7bbe757343b930284f3aef690e45560f0aa771b629399480',
  timestamp: String(NOW / 1000),
  data: JSON.stringify({ change1h, price: 17.05, updatedAt: '2026-10-30T21:59:00Z' }),
  signature: '0x',
});

// A fake client: records what was submitted, answers with the given regime or rejection.
const fakeGuard = ({
  change1h = 0.2,
  regime = 'NORMAL',
  reject,
  fetchError,
  regimeFails = false,
}: { change1h?: number; regime?: string; reject?: string; fetchError?: string; regimeFails?: boolean } = {}) => {
  const submitted: bigint[] = [];
  const guard = {
    getVaultConfig: async () => ({ breakerBps: -500, reentryBps: 100, maxDataAge: 600 }),
    fetchPrice: async () => {
      if (fetchError) throw new Error(fetchError);
      return price(change1h);
    },
    submitPrice: async (_vaultId: bigint, _price: SignedResponse, usdAmount: bigint) => {
      if (reject) throw new ContractRejection(reject, []);
      submitted.push(usdAmount);
      return { hash: '0xabc', receipt: { blockNumber: 1n }, intents: [] };
    },
    regime: async () => {
      if (regimeFails) throw new Error('block not found');
      return regime;
    },
  } as unknown as CycleGuard;
  return { guard, submitted };
};

const options = { dailyAusdCap: 500_000n, heartbeatUsd: 10_000n };

test('a calm cycle buys one price, submits it and waits 10 min', async () => {
  const { guard, submitted } = fakeGuard();
  const state = initialCycleState();
  const result = await runBaseCycle(guard, 8n, fetch, state, options, NOW);
  assert.equal(result.action, 'submitted');
  assert.equal(result.nextDelayMs, 600_000);
  assert.equal(result.aUsdSpentToday, '1000');
  assert.deepEqual(submitted, [10_000n]);
});

test('the heartbeat SPEND runs once per UTC day', async () => {
  const { guard, submitted } = fakeGuard();
  const state = initialCycleState();
  await runBaseCycle(guard, 8n, fetch, state, options, NOW);
  await runBaseCycle(guard, 8n, fetch, state, options, NOW + 600_000);
  await runBaseCycle(guard, 8n, fetch, state, options, NOW + 86_400_000);
  assert.deepEqual(submitted, [10_000n, 0n, 10_000n]);
});

test('near the breaker threshold or outside NORMAL it checks every 2 min', async () => {
  const near = await runBaseCycle(fakeGuard({ change1h: -4 }).guard, 8n, fetch, initialCycleState(), options, NOW);
  assert.equal(near.nextDelayMs, 120_000);
  const riskOff = await runBaseCycle(
    fakeGuard({ regime: 'RISK_OFF' }).guard,
    8n,
    fetch,
    initialCycleState(),
    options,
    NOW
  );
  assert.equal(riskOff.nextDelayMs, 120_000);
  const calm = await runBaseCycle(fakeGuard({ change1h: -3 }).guard, 8n, fetch, initialCycleState(), options, NOW);
  assert.equal(calm.nextDelayMs, 600_000);
});

test('no new data is a skip, not a failure', async () => {
  const state = initialCycleState();
  const result = await runBaseCycle(fakeGuard({ reject: 'StaleSignature' }).guard, 8n, fetch, state, options, NOW);
  assert.equal(result.action, 'skipped');
  assert.equal(state.failures, 0);
  assert.equal(result.nextDelayMs, 600_000);
});

test('errors back off exponentially up to the maximum', async () => {
  const { guard } = fakeGuard({ fetchError: 'quota' });
  const state = initialCycleState();
  const delays = [];
  for (let i = 0; i < 5; i++) delays.push((await runBaseCycle(guard, 8n, fetch, state, options, NOW)).nextDelayMs);
  assert.deepEqual(delays, [600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]);
  // Counted conservatively: a paid call whose response then fails still counts toward the cap.
  assert.equal(state.spentAusdToday, '5000');
});

test('the daily aUSD cap stops buying until the next UTC day', async () => {
  const { guard, submitted } = fakeGuard();
  const state = initialCycleState();
  const capped = { ...options, dailyAusdCap: 2_000n };
  await runBaseCycle(guard, 8n, fetch, state, capped, NOW);
  await runBaseCycle(guard, 8n, fetch, state, capped, NOW + 1);
  const third = await runBaseCycle(guard, 8n, fetch, state, capped, NOW + 2);
  assert.equal(third.action, 'skipped');
  assert.equal(third.nextDelayMs, Date.UTC(2026, 9, 31) - (NOW + 2) + 1_000);
  assert.equal(submitted.length, 2);
  const nextDay = await runBaseCycle(guard, 8n, fetch, state, capped, Date.UTC(2026, 9, 31, 0, 0, 5));
  assert.equal(nextDay.action, 'submitted');
});

test('a mined tx stays a success when the regime read after it fails', async () => {
  const state = initialCycleState();
  const result = await runBaseCycle(fakeGuard({ regimeFails: true }).guard, 8n, fetch, state, options, NOW);
  assert.equal(result.action, 'submitted');
  assert.equal(result.txHash, '0xabc');
  assert.equal(state.failures, 0);
});

test('prices not taken several times in a row back off instead of paying for nothing', async () => {
  const { guard } = fakeGuard({ reject: 'StaleSignature' });
  const state = initialCycleState();
  const actions = [];
  for (let i = 0; i < 3; i++) actions.push((await runBaseCycle(guard, 8n, fetch, state, options, NOW)).action);
  assert.deepEqual(actions, ['skipped', 'skipped', 'error']);
});

test('a skip keeps the fast cadence while the vault is not NORMAL', async () => {
  const state = { ...initialCycleState(), lastRegime: 'RISK_OFF' };
  const result = await runBaseCycle(fakeGuard({ reject: 'StaleSignature' }).guard, 8n, fetch, state, options, NOW);
  assert.equal(result.nextDelayMs, 120_000);
});
