// The unattended BSV half of the tweet-triggered cycle (`tg auto`): every new SPEND intent of the
// guarded vault on Base is handed to the normal withdraw path, one at a time. Nothing here decides
// or signs: the watcher checks each intent, its journal allows one transaction per intent, and the
// pending-withdrawal file guards a signed transaction. This loop only adds limits and bookkeeping.
//
// Conservative by design: an intent's maxSats is charged to the session budget before its withdraw
// starts, an intent is marked 'started' before and never started again, only clean pre-signing
// failures are retried, and any other failure (also in the bookkeeping after a withdrawal) halts.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { IntentReader } from '../api3/intentReader'
import { KIND_SPEND } from '../api3/policyTypes'

/** Failures that happened before anything was signed or sent, so the same intent may be tried again. */
const RETRYABLE = /independent verification failed|not reachable|fetch failed|ECONNREFUSED|ETIMEDOUT|does not exist at block/
const MAX_TRIES = 6

export type AutoStatus = 'started' | 'done' | 'done-unrecorded' | 'failed' | 'skipped:swap'

export interface AutoState {
  nextBlock: string
  handled: Record<string, { status: AutoStatus; at: string; txid?: string; error?: string }>
}

export interface AutoCycleOptions {
  reader: Pick<IntentReader, 'latestBlock' | 'intentEvents' | 'readIntent'>
  vaultId: bigint
  /** The `tg withdraw` path for one intent. Throws on any failure. */
  withdraw: (intentId: bigint) => Promise<void>
  /** What a finished withdrawal recorded (its evidence file). Throws if it cannot be read. */
  receipt: (intentId: bigint) => { bsvTxid: string; vaultOutflowSats: number }
  /** True while a signed transaction for the intent is kept in its pending-withdrawal file. */
  hasPending: (intentId: bigint) => boolean
  /** Optional purchase after each withdrawal; its failures are logged, never fatal. */
  buy?: () => Promise<void>
  stateFile: string
  logFile: string
  maxIntents: number
  /** Most sats this run may move out of the vault. */
  maxSats: number
  /** First block to read; default: the current block (only intents created from now on). */
  fromBlock?: bigint
  pollMs?: number
  /** Set `requested` to stop after the current step. */
  stop?: { requested: boolean }
  print?: (line: string) => void
}

/** Runs until stopped; throws (halts) on anything that needs a human. */
export async function runAutoCycle(o: AutoCycleOptions): Promise<void> {
  const state: AutoState = existsSync(o.stateFile) ? (JSON.parse(readFileSync(o.stateFile, 'utf8')) as AutoState) : { nextBlock: '0', handled: {} }
  const save = (): void => writeFileSync(o.stateFile, JSON.stringify(state, null, 2) + '\n')
  const log = (entry: Record<string, unknown>): void => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
    appendFileSync(o.logFile, line + '\n')
    ;(o.print ?? console.log)(`[auto] ${line}`)
  }
  const mark = (id: bigint, entry: Omit<AutoState['handled'][string], 'at'>): void => {
    state.handled[id.toString()] = { ...entry, at: new Date().toISOString() }
    save()
  }
  const halt = (message: string): never => {
    log({ event: 'halt', error: message })
    throw new Error(message)
  }

  const stuck = Object.entries(state.handled).filter(([, h]) => h.status === 'started').map(([id]) => id)
  if (stuck.length > 0) throw new Error(`Intent(s) ${stuck.join(', ')} were started and never finished (${o.stateFile}); check them by hand first`)
  state.nextBlock = (o.fromBlock ?? (await o.reader.latestBlock())).toString()
  save()
  const firstBlock = BigInt(state.nextBlock)
  const stop = o.stop ?? { requested: false }
  let withdrawn = 0
  /** Charged at each intent's maxSats before its withdraw starts; refunded only for a retryable pre-signing failure. */
  let committedSats = 0
  const attempts = new Map<string, number>()
  log({ event: 'start', vaultId: o.vaultId.toString(), fromBlock: state.nextBlock, buy: o.buy !== undefined, maxIntents: o.maxIntents, maxSats: o.maxSats })

  while (!stop.requested) {
    let to: bigint
    let events: Awaited<ReturnType<AutoCycleOptions['reader']['intentEvents']>>
    const from = BigInt(state.nextBlock)
    try {
      to = (await o.reader.latestBlock()) - 1n // the same one-block lag as readIntent
      // A small overlap: a lagging RPC node may have answered the last window without its newest logs.
      const scanFrom = from - 20n > firstBlock ? from - 20n : firstBlock
      events = scanFrom <= to ? await o.reader.intentEvents(scanFrom, to, o.vaultId) : []
    } catch (err) {
      log({ event: 'tick-error', error: (err as Error).message })
      await new Promise(r => setTimeout(r, o.pollMs ?? 10_000))
      continue
    }

    let retryLater = false
    for (const ev of events) {
      if (stop.requested) break
      const id = ev.intentId
      if (state.handled[id.toString()] !== undefined) continue
      if (ev.kind !== KIND_SPEND) {
        log({ event: 'skip', intentId: id.toString(), reason: 'SWAP intent: the watcher never co-signs SWAP' })
        mark(id, { status: 'skipped:swap' })
        continue
      }
      if (withdrawn >= o.maxIntents) halt(`--max-intents ${o.maxIntents} reached; intent ${id} left for a human`)
      let maxSats: number
      try {
        maxSats = Number((await o.reader.readIntent(id)).maxSats)
      } catch (err) {
        // Nothing was started: read this window again next tick.
        log({ event: 'tick-error', intentId: id.toString(), error: (err as Error).message })
        retryLater = true
        break
      }
      if (!Number.isSafeInteger(maxSats) || maxSats <= 0) halt(`Intent ${id} has an unusable maxSats ${maxSats}`)
      if (committedSats + maxSats > o.maxSats) halt(`--max-sats ${o.maxSats} would be exceeded (committed ${committedSats}, intent ${id} allows ${maxSats}); left for a human`)

      committedSats += maxSats
      log({ event: 'withdraw', intentId: id.toString(), block: ev.blockNumber.toString(), committedSats })
      mark(id, { status: 'started' })
      try {
        await o.withdraw(id)
      } catch (err) {
        const message = (err as Error).message
        const tries = (attempts.get(id.toString()) ?? 0) + 1
        attempts.set(id.toString(), tries)
        if (!o.hasPending(id) && tries < MAX_TRIES && RETRYABLE.test(message) && !/may still have signed/.test(message)) {
          committedSats -= maxSats
          delete state.handled[id.toString()]
          save()
          log({ event: 'retry', intentId: id.toString(), attempt: tries, error: message })
          retryLater = true
          continue
        }
        mark(id, { status: 'failed', error: message })
        halt(`Intent ${id} failed: ${message}`)
      }
      withdrawn++

      // The withdrawal happened. If its bookkeeping fails, stop: the intent stays 'started' (a restart
      // refuses), and its maxSats stays charged.
      let txid: string
      let unrecorded: boolean
      try {
        const receipt = o.receipt(id)
        if (!/^[0-9a-f]{64}$/.test(receipt.bsvTxid)) throw new Error(`evidence has no BSV txid`)
        if (!Number.isSafeInteger(receipt.vaultOutflowSats) || receipt.vaultOutflowSats < 0 || receipt.vaultOutflowSats > maxSats) {
          throw new Error(`evidence outflow ${receipt.vaultOutflowSats} is not within 0..${maxSats}`)
        }
        txid = receipt.bsvTxid
        unrecorded = o.hasPending(id)
        mark(id, { status: unrecorded ? 'done-unrecorded' : 'done', txid })
      } catch (err) {
        halt(`Intent ${id} failed: bookkeeping after a successful withdrawal: ${(err as Error).message}`)
      }
      log({ event: unrecorded! ? 'withdrawn-unrecorded' : 'withdrawn', intentId: id.toString(), txid: txid!, committedSats })
      if (o.buy !== undefined) {
        await o.buy().then(
          () => log({ event: 'bought', intentId: id.toString() }),
          (err: Error) => log({ event: 'buy-failed', intentId: id.toString(), error: err.message })
        )
      }
    }
    if (!retryLater && !stop.requested) {
      state.nextBlock = (to + 1n > from ? to + 1n : from).toString()
      save()
    }
    await new Promise(r => setTimeout(r, o.pollMs ?? 10_000))
  }
  log({ event: 'stop' })
}
