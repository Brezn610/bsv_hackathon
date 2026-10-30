// The watcher process: re-reads the intent from Base, decides with the pure policy, journals,
// and only then signs. Its signing wallet is its own; the agent never gets the key, only the
// signatures for a transaction the watcher approved. One request at a time.
import type { Transaction } from '@bsv/sdk'
import type { IntentReader } from '../api3/intentReader'
import { receiptScript } from '../vault/proposeSpend'
import { signVaultInput, type VaultSigner } from '../vault/template'
import { evaluateWithdrawal, proposalIdOf, type Decision, type VaultBinding } from './policy'
import { intentKey, type WatcherJournal } from './state'

export interface WatcherOptions {
  binding: VaultBinding
  reader: Pick<IntentReader, 'readIntent'>
  journal: WatcherJournal
  signer: VaultSigner
  /** Vault outpoints that are unspent right now, with their value, from an independent source. */
  unspentVaultUtxos: () => Promise<Map<string, number>>
  now?: () => number
}

export type CosignResult = { decision: Decision; signatures?: number[][] }

export class Watcher {
  constructor(private readonly opts: WatcherOptions) {}

  async cosign(intentId: bigint, tx: Transaction): Promise<CosignResult> {
    return await this.opts.journal.exclusive(async () => {
      const { binding, journal } = this.opts
      let intent
      let unspent: Map<string, number>
      try {
        // Always read again right before signing: never trust a log, a cache or the agent.
        intent = await this.opts.reader.readIntent(intentId)
        unspent = await this.opts.unspentVaultUtxos()
      } catch (err) {
        return { decision: { verdict: 'DENY', reasons: [`independent verification failed: ${(err as Error).message}`] } }
      }
      const key = intentKey(intent.chainId, intent.contract, intent.vaultId, intent.intentId)
      // Outpoints another intent already claimed are not available, even if still unspent on chain.
      const claimed = journal.claimedOutpoints()
      for (const outpoint of claimed) unspent.delete(outpoint)

      const decision = evaluateWithdrawal(binding, {
        intent,
        tx,
        ledger: journal.status(key),
        vaultUtxos: unspent,
        now: Math.floor((this.opts.now ?? Date.now)() / 1000),
        expectedReceipt: receiptScript({ chainId: intent.chainId, contract: intent.contract, vaultId: intent.vaultId, intentId: intent.intentId })
      })
      if (decision.verdict === 'DENY') return { decision }

      const outpoints = tx.inputs.map(i => `${i.sourceTransaction!.id('hex')}.${i.sourceOutputIndex}`)
      // Journal first: once 'reserved' is on disk this intent is never signed again.
      journal.write(key, { status: 'reserved', proposalId: decision.proposalId, outpoints })
      const signatures: number[][] = []
      for (let i = 0; i < tx.inputs.length; i++) signatures.push(await signVaultInput(this.opts.signer, tx, i))
      journal.write(key, { status: 'signed', proposalId: decision.proposalId, outpoints })
      return { decision, signatures }
    })
  }

  /** After broadcast: the transaction must be the one this intent's signatures were made for. */
  async recordBroadcast(intentId: bigint, tx: Transaction): Promise<void> {
    await this.opts.journal.exclusive(async () => {
      const { base } = this.opts.binding
      const key = intentKey(base.chainId, base.contract, base.vaultId, intentId)
      const record = this.opts.journal.get(key)
      if (record?.status !== 'signed' || record.proposalId !== proposalIdOf(tx)) {
        throw new Error(`Intent ${intentId}: this transaction is not the one the watcher signed`)
      }
      this.opts.journal.write(key, { ...record, status: 'broadcast', bsvTxid: tx.id('hex') })
    })
  }
}
