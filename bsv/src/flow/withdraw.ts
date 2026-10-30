// The agent's side of one SPEND: propose the withdrawal, have the watcher check and cosign it,
// assemble, broadcast, and have the watcher journal the broadcast. The agent never sees the
// watcher's key; the watcher never sees the agent's.
import type { Transaction } from '@bsv/sdk'
import type { ConfirmedIntent } from '../api3/policyTypes'
import { agentSignatures, assembleCosigned, proposeSpend, receiptScript, type VaultUtxo } from '../vault/proposeSpend'
import type { VaultSigner } from '../vault/template'
import type { Decision } from '../watcher/policy'
import type { Watcher } from '../watcher/service'

export interface WithdrawArgs {
  intent: ConfirmedIntent
  agent: VaultSigner
  watcher: Pick<Watcher, 'cosign' | 'recordBroadcast'>
  utxos: VaultUtxo[]
  vaultLockingScript: string
  floatLockingScript: string
  /** Sats kept aside for the network fee, which the vault pays inside maxSats. */
  feeReserveSats: number
  broadcast: (tx: Transaction) => Promise<void>
  feeSatsPerKb?: number
}

export interface WithdrawResult {
  tx: Transaction
  txid: string
  amountSats: number
  fee: number
  decision: Decision
}

export async function withdrawForIntent(a: WithdrawArgs): Promise<WithdrawResult> {
  const vaultTotal = a.utxos.reduce((s, u) => s + u.satoshis, 0)
  const cap = a.intent.maxSats < BigInt(vaultTotal) ? Number(a.intent.maxSats) : vaultTotal
  const amountSats = cap - a.feeReserveSats
  if (amountSats <= 0) throw new Error(`Intent allows ${a.intent.maxSats} sats, vault holds ${vaultTotal}: nothing left after the fee reserve`)
  const tx = proposeSpend({
    utxos: a.utxos,
    vaultLockingScript: a.vaultLockingScript,
    floatLockingScript: a.floatLockingScript,
    amountSats,
    receiptScript: receiptScript(a.intent),
    feeSatsPerKb: a.feeSatsPerKb
  })
  const agentSigs = await agentSignatures(a.agent, tx)
  const { decision, signatures } = await a.watcher.cosign(a.intent.intentId, tx)
  if (decision.verdict === 'DENY' || signatures === undefined) {
    throw new Error(`Watcher refused: ${decision.verdict === 'DENY' ? decision.reasons.join('; ') : 'no signatures'}`)
  }
  const signed = assembleCosigned(tx, agentSigs, signatures)
  await a.broadcast(signed)
  await a.watcher.recordBroadcast(a.intent.intentId, signed)
  return { tx: signed, txid: signed.id('hex'), amountSats, fee: signed.getFee(), decision }
}
