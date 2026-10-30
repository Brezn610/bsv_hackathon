// The watcher's journal: one record per (chain, contract, vault, intent), written before a
// signature leaves the watcher. Writes go to a temporary file, are fsynced, then renamed over
// the journal, so a crash leaves either the old or the new journal, never half of one. A checksum
// over the body catches a corrupted or hand-edited file, and a corrupted journal stops the watcher.
//
// Recovery rule: an intent in any state but absent is never signed again. If the process died
// after 'signed' but before 'broadcast', the operator reconciles by looking up the recorded
// proposal on chain; the watcher does not sign an alternative transaction for that intent.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { Hash, Utils } from '@bsv/sdk'

export type IntentStatus = 'reserved' | 'signed' | 'broadcast' | 'settled' | 'denied'

export interface IntentRecord {
  status: IntentStatus
  proposalId?: string
  bsvTxid?: string
  /** Vault outpoints this intent has spent or is spending; never offered to another intent. */
  outpoints: string[]
  reasons?: string[]
  updatedAt: string
}

interface JournalFile {
  version: 1
  records: Record<string, IntentRecord>
  checksum: string
}

export const intentKey = (chainId: number, contract: string, vaultId: bigint, intentId: bigint): string =>
  `${chainId}:${contract.toLowerCase()}:${vaultId}:${intentId}`

const checksumOf = (records: Record<string, IntentRecord>): string =>
  Utils.toHex(Hash.sha256(Utils.toArray(JSON.stringify(records), 'utf8')))

export class WatcherJournal {
  private records: Record<string, IntentRecord> = {}
  /** One request at a time: reserve() and the write that follows cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {
    if (!existsSync(file)) return
    let parsed: JournalFile
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as JournalFile
    } catch (err) {
      throw new Error(`Watcher journal ${file} is unreadable, refusing to run: ${(err as Error).message}`)
    }
    if (parsed.version !== 1 || typeof parsed.records !== 'object' || parsed.checksum !== checksumOf(parsed.records)) {
      throw new Error(`Watcher journal ${file} failed its checksum, refusing to run`)
    }
    this.records = parsed.records
  }

  status(key: string): IntentStatus | 'new' {
    return this.records[key]?.status ?? 'new'
  }

  get(key: string): IntentRecord | undefined {
    return this.records[key]
  }

  /** Outpoints any recorded intent has claimed. */
  claimedOutpoints(): Set<string> {
    return new Set(Object.values(this.records).flatMap(r => (r.status === 'denied' ? [] : r.outpoints)))
  }

  /** Runs `fn` with exclusive access to the journal. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return await run
  }

  /** Records a state. Durable on disk when it returns. */
  write(key: string, record: Omit<IntentRecord, 'updatedAt'>): void {
    const next = { ...this.records, [key]: { ...record, updatedAt: new Date().toISOString() } }
    const body: JournalFile = { version: 1, records: next, checksum: checksumOf(next) }
    const tmp = `${this.file}.tmp`
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, JSON.stringify(body, null, 2))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.file)
    this.records = next
  }
}
