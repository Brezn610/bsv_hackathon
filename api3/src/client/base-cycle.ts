// One autonomous Base cycle of the agent: decide whether a signed price is worth buying now, buy it via x402, submit it,
// and say when the next one is worth buying. No loop inside: src/agent.ts schedules it (the runner on vault 8). The BSV
// side never calls it and has no EVM key: it only reacts to SPEND intents on vault 5, which it reads on-chain.
//
// The contract makes the decisions that matter (budget, circuit breaker, re-entry) from each signed price. The agent
// decides when data is worth paying for: every 10 min when calm, every 2 min when the 1h change is near the breaker
// threshold or the vault is not NORMAL. It never polls posts: a post is event-driven (see docs/INTERFACE.md).
import type { SignedResponse } from '../airnode-v2.ts';
import { parsePriceData } from './feeds.ts';
import { ContractRejection, Direction, Kind, Source, type TreasuryGuardClient } from './treasury-guard.ts';

export interface CycleOptions {
  // Most aUSD (6 decimals) this agent pays for data per UTC day.
  dailyAusdCap: bigint;
  // What one signed price costs (CoinPaprika: $0.001).
  priceCostAusd?: bigint;
  // A small SPEND (USD, 6 decimals) once per UTC day, so the budget path runs live too. 0n for none.
  heartbeatUsd?: bigint;
  normalDelayMs?: number;
  fastDelayMs?: number;
  // How close (bps of the 1h change) to the breaker threshold switches to the fast cadence.
  nearThresholdBps?: number;
  maxBackoffMs?: number;
}

// Kept by the caller between cycles (and across restarts: it is plain JSON).
export interface CycleState {
  day: number;
  spentAusdToday: string;
  failures: number;
  lastHeartbeatDay: number;
  // Consecutive cycles whose price the contract did not take: after a few, it is a problem, not a quiet market.
  skips?: number;
  lastRegime?: string;
}

export const initialCycleState = (): CycleState => ({
  day: 0,
  spentAusdToday: '0',
  failures: 0,
  lastHeartbeatDay: 0,
  skips: 0,
  lastRegime: 'NORMAL',
});

// After this many skipped prices in a row the agent backs off and says so, instead of paying for nothing all night.
const MAX_QUIET_SKIPS = 3;

export interface CycleIntent {
  intentId: string;
  kind: string;
  direction: string;
  source: string;
  maxSats: string;
  maxBps: number;
}

export interface CycleResult {
  at: string;
  vaultId: string;
  action: 'submitted' | 'skipped' | 'error';
  reason?: string;
  txHash?: string;
  price?: number;
  change1h?: number;
  signedAt?: number;
  regime?: string;
  usdSpent?: string;
  intents: CycleIntent[];
  aUsdSpent: string;
  aUsdSpentToday: string;
  nextDelayMs: number;
  nextReason: string;
}

// The parts of the client a cycle uses, so a test can pass a fake.
export type CycleGuard = Pick<TreasuryGuardClient, 'fetchPrice' | 'submitPrice' | 'getVaultConfig' | 'regime'>;

const DAY_MS = 86_400_000;

export const runBaseCycle = async (
  guard: CycleGuard,
  vaultId: bigint,
  payingFetch: typeof fetch,
  state: CycleState,
  {
    dailyAusdCap,
    priceCostAusd = 1_000n,
    heartbeatUsd = 0n,
    normalDelayMs = 600_000,
    fastDelayMs = 120_000,
    nearThresholdBps = 150,
    maxBackoffMs = 3_600_000,
  }: CycleOptions,
  now = Date.now()
): Promise<CycleResult> => {
  const day = Math.floor(now / DAY_MS);
  if (day !== state.day) Object.assign(state, { day, spentAusdToday: '0' });
  const base = { at: new Date(now).toISOString(), vaultId: String(vaultId), intents: [] as CycleIntent[] };
  const spentToday = () => BigInt(state.spentAusdToday);

  // Spending limit: never pay past the daily cap; wait for the next UTC day instead.
  if (spentToday() + priceCostAusd > dailyAusdCap) {
    return {
      ...base,
      action: 'skipped',
      reason: `daily aUSD cap ${dailyAusdCap} reached`,
      aUsdSpent: '0',
      aUsdSpentToday: state.spentAusdToday,
      nextDelayMs: (day + 1) * DAY_MS - now + 1_000,
      nextReason: 'next UTC day',
    };
  }

  // Failure handling: RPC, x402 or quota errors back off exponentially; nothing is retried in a tight loop.
  const fail = (reason: string, aUsdSpent: bigint): CycleResult => {
    state.failures += 1;
    const nextDelayMs = Math.min(normalDelayMs * 2 ** (state.failures - 1), maxBackoffMs);
    return {
      ...base,
      action: 'error',
      reason,
      aUsdSpent: String(aUsdSpent),
      aUsdSpentToday: state.spentAusdToday,
      nextDelayMs,
      nextReason: `backoff after ${state.failures} failure(s)`,
    };
  };

  let price: SignedResponse;
  try {
    const config = await guard.getVaultConfig(vaultId);
    // Counted before the call: x402 may settle even if the response then fails, so the cap errs on the safe side.
    state.spentAusdToday = String(spentToday() + priceCostAusd);
    price = await guard.fetchPrice(payingFetch);
    const { price: usdPerBsv, change1h } = parsePriceData(price.data);
    const usdAmount = heartbeatUsd > 0n && state.lastHeartbeatDay !== day ? heartbeatUsd : 0n;
    const priceInfo = { price: usdPerBsv, change1h, signedAt: Number(price.timestamp) };

    // Cadence: the agent decides when the next signed price is worth paying for.
    const cadence = (regime: string) => {
      const distance = Math.round(change1h * 100) - config.breakerBps;
      if (regime !== 'NORMAL') return { nextDelayMs: fastDelayMs, nextReason: `fast: vault is ${regime}` };
      if (distance <= nearThresholdBps) {
        return { nextDelayMs: fastDelayMs, nextReason: `fast: 1h change ${change1h.toFixed(2)} % near breaker` };
      }
      return { nextDelayMs: normalDelayMs, nextReason: 'calm' };
    };

    try {
      const { hash, receipt, intents } = await guard.submitPrice(vaultId, price, usdAmount);
      if (usdAmount > 0n) state.lastHeartbeatDay = day;
      state.failures = 0;
      // The tx is mined: a failed regime read (a lagging RPC node) must not turn it into an error.
      const regime = (await guard.regime(vaultId, receipt.blockNumber).catch(() => undefined)) ?? 'UNKNOWN';
      state.skips = 0;
      state.lastRegime = regime;
      return {
        ...base,
        ...priceInfo,
        action: 'submitted',
        txHash: hash,
        regime,
        usdSpent: String(usdAmount),
        intents: intents.map(({ args }) => ({
          intentId: String(args.intentId),
          kind: Kind[args.kind] ?? String(args.kind),
          direction: Direction[args.direction] ?? String(args.direction),
          source: Source[args.source] ?? String(args.source),
          maxSats: String(args.maxSats),
          maxBps: args.maxBps,
        })),
        aUsdSpent: String(priceCostAusd),
        aUsdSpentToday: state.spentAusdToday,
        ...cadence(regime),
      };
    } catch (error) {
      if (!(error instanceof ContractRejection)) throw error;
      // StaleSignature has three causes; only the first is a quiet source. The others are clock skew or a lagging RPC
      // node, which would otherwise make every cycle pay for nothing.
      if (error.errorName === 'StaleSignature' || error.errorName === 'Replay') {
        const { updatedAt } = parsePriceData(price.data);
        const measuredBeforeSigning = Number(price.timestamp) - Date.parse(updatedAt) / 1000;
        const cause =
          error.errorName === 'Replay'
            ? 'the vault already has this or a newer price'
            : measuredBeforeSigning > config.maxDataAge
              ? `the source has no new data (measured ${measuredBeforeSigning} s before signing)`
              : `signature time vs chain time (clock skew or RPC lag; signed ${Math.round(now / 1000) - Number(price.timestamp)} s ago by this clock)`;
        state.skips = (state.skips ?? 0) + 1;
        if (state.skips >= MAX_QUIET_SKIPS) {
          return fail(`${state.skips} prices in a row not taken: ${error.errorName}, ${cause}`, priceCostAusd);
        }
        state.failures = 0;
        return {
          ...base,
          ...priceInfo,
          action: 'skipped',
          reason: `${error.errorName}: ${cause}`,
          aUsdSpent: String(priceCostAusd),
          aUsdSpentToday: state.spentAusdToday,
          ...cadence(state.lastRegime ?? 'NORMAL'),
        };
      }
      // The heartbeat is optional: if today's budget is gone, skip it today.
      if (error.errorName === 'BudgetExceeded' && usdAmount > 0n) state.lastHeartbeatDay = day;
      return fail(`rejected: ${error.message}`, priceCostAusd);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message.split('\n')[0]! : String(error), 0n);
  }
};
