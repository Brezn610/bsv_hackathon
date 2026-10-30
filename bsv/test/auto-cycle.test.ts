// tg auto's loop (src/flow/autoCycle.ts) with mocked Base reads and a mocked withdraw: no wallet,
// no watcher, no network. The session budget is charged before a withdraw starts, bookkeeping
// failures after a withdrawal halt the loop, and an intent is never started twice.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { ConfirmedIntent } from '../src/api3/policyTypes'
import { runAutoCycle, type AutoCycleOptions } from '../src/flow/autoCycle'

const TXID = 'ab'.repeat(32)

function harness(over: Partial<AutoCycleOptions> & { intents?: Array<{ id: bigint; kind?: number; maxSats?: bigint }> } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tg-auto-'))
  const intents = over.intents ?? [{ id: 1n }, { id: 2n }]
  const withdrawn: bigint[] = []
  const opts: AutoCycleOptions = {
    reader: {
      latestBlock: async () => 101n,
      intentEvents: async () => intents.map((i, n) => ({ intentId: i.id, vaultId: 5n, kind: i.kind ?? 0, blockNumber: 100n, txHash: `0x${n}` })),
      readIntent: async id => ({ intentId: id, maxSats: intents.find(i => i.id === id)?.maxSats ?? 90n }) as ConfirmedIntent
    },
    vaultId: 5n,
    withdraw: async id => {
      withdrawn.push(id)
    },
    receipt: () => ({ bsvTxid: TXID, vaultOutflowSats: 90 }),
    hasPending: () => false,
    stateFile: path.join(dir, 'auto-state.json'),
    logFile: path.join(dir, 'auto-cycle.jsonl'),
    maxIntents: 5,
    maxSats: 1_000,
    fromBlock: 100n,
    pollMs: 1,
    stop: { requested: false },
    print: () => {},
    ...over
  }
  return { opts, withdrawn, dir }
}

test('an evidence read failure after the first withdrawal halts the loop before a second withdrawal', async () => {
  const { opts, withdrawn } = harness({
    maxSats: 100,
    receipt: () => {
      throw new Error('ENOENT: evidence file missing')
    }
  })
  await assert.rejects(runAutoCycle(opts), /Intent 1 failed: bookkeeping after a successful withdrawal: ENOENT/)
  assert.deepEqual(withdrawn, [1n])
  // The intent stays 'started', so a restart refuses instead of running it again.
  assert.equal(JSON.parse(readFileSync(opts.stateFile, 'utf8')).handled['1'].status, 'started')
  await assert.rejects(runAutoCycle(opts), /were started and never finished/)
  assert.deepEqual(withdrawn, [1n])
})

test('the same failure halts even when the budget would allow the second intent', async () => {
  const { opts, withdrawn } = harness({ receipt: () => ({ bsvTxid: 'not a txid', vaultOutflowSats: 90 }) })
  await assert.rejects(runAutoCycle(opts), /bookkeeping after a successful withdrawal: evidence has no BSV txid/)
  assert.deepEqual(withdrawn, [1n])
})

test('the session budget is charged at maxSats before a withdraw starts', async () => {
  const { opts, withdrawn } = harness({ maxSats: 100 })
  await assert.rejects(runAutoCycle(opts), /--max-sats 100 would be exceeded \(committed 90, intent 2 allows 90\)/)
  assert.deepEqual(withdrawn, [1n])
  // An evidence outflow above the intent's maxSats is never accepted as bookkeeping.
  const over = harness({ receipt: () => ({ bsvTxid: TXID, vaultOutflowSats: 91 }) })
  await assert.rejects(runAutoCycle(over.opts), /outflow 91 is not within 0\.\.90/)
  assert.deepEqual(over.withdrawn, [1n])
})

test('a failed withdraw that may have signed halts and is never retried; a clean pre-signing failure is retried', async () => {
  const lost = harness({
    withdraw: async id => {
      lost.withdrawn.push(id)
      throw new Error('Watcher refused: watcher unreachable: fetch failed. It may still have signed: check …')
    }
  })
  await assert.rejects(runAutoCycle(lost.opts), /Intent 1 failed: .*may still have signed/)
  assert.deepEqual(lost.withdrawn, [1n])

  let calls = 0
  const flaky = harness({
    intents: [{ id: 7n }],
    maxIntents: 1,
    withdraw: async id => {
      calls++
      flaky.withdrawn.push(id)
      if (calls === 1) throw new Error('Watcher refused: independent verification failed: RPC timeout')
    }
  })
  const run = runAutoCycle(flaky.opts)
  // After the retry succeeds, the loop idles; stop it once the intent is done.
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5))
    try {
      if (JSON.parse(readFileSync(flaky.opts.stateFile, 'utf8')).handled['7']?.status === 'done') break
    } catch {
      // not written yet
    }
  }
  flaky.opts.stop!.requested = true
  await run
  assert.deepEqual(flaky.withdrawn, [7n, 7n])
})

test('SWAP intents are skipped, and a done intent is not withdrawn again on the next tick', async () => {
  const h = harness({ intents: [{ id: 3n, kind: 1 }, { id: 4n }], maxIntents: 1 })
  const run = runAutoCycle(h.opts)
  await new Promise(r => setTimeout(r, 50)) // many ticks over the same window
  h.opts.stop!.requested = true
  await run
  assert.deepEqual(h.withdrawn, [4n])
  const state = JSON.parse(readFileSync(h.opts.stateFile, 'utf8'))
  assert.equal(state.handled['3'].status, 'skipped:swap')
  assert.equal(state.handled['4'].status, 'done')
})
