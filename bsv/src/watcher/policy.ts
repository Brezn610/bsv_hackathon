// The watcher's decision, as a pure function of: the fixed binding (which Base vault maps to
// which BSV vault script and which Agent Float), an intent read from Base, the journal's answer
// for that intent, the clock, and the complete transaction it is asked to co-sign.
// It reads the transaction's real inputs and outputs. Nothing the agent writes (descriptions,
// labels, claimed amounts) is consulted. Any doubt is a DENY.
import { Transaction, UnlockingScript } from '@bsv/sdk'
import { DIRECTION_NONE, KIND_SPEND, type ConfirmedIntent } from '../api3/policyTypes'

/** Fixed per deployment, authorised by the owner, versioned. */
export interface VaultBinding {
  version: string
  bsvNetwork: 'main' | 'test' | 'mock'
  base: { chainId: number; contract: string; vaultId: bigint; excludedVaultIds: bigint[] }
  vaultLockingScript: string
  /** The single pre-registered recipient of SPEND withdrawals. */
  floatLockingScript: string
  /** Most sats of network fee a withdrawal may pay. */
  maxFeeSats: number
  /** Seconds before expiry after which the watcher no longer signs (time to sign and broadcast). */
  expiryMarginSec: number
  /** A vault remainder must be 0 or at least this. */
  minChangeSats: number
}

export interface WatcherRequest {
  intent: ConfirmedIntent
  tx: Transaction
  /** What the journal says about this intent before this request. */
  ledger: 'new' | 'reserved' | 'signed' | 'broadcast' | 'settled' | 'denied'
  /** Vault outpoints the watcher believes unspent, with their value. */
  vaultUtxos: Map<string, number>
  /** Unix seconds. */
  now: number
  /** The OP_RETURN receipt the watcher expects, if receipts are used. */
  expectedReceipt?: string
}

export type Decision =
  | { verdict: 'APPROVE'; proposalId: string; vaultIn: number; toFloat: number; change: number; fee: number }
  | { verdict: 'DENY'; reasons: string[] }

const isOpReturn = (hex: string): boolean => hex.startsWith('006a') || hex.startsWith('6a')

function outpointOf(tx: Transaction, i: number): string {
  const input = tx.inputs[i]
  return `${input.sourceTXID ?? input.sourceTransaction?.id('hex')}.${input.sourceOutputIndex}`
}

export function evaluateWithdrawal(binding: VaultBinding, req: WatcherRequest): Decision {
  const reasons: string[] = []
  const deny = (r: string): void => {
    reasons.push(r)
  }
  const { intent, tx } = req

  // 1. Binding: the intent belongs to the one guarded Base vault on the one contract.
  if (intent.chainId !== binding.base.chainId) deny(`chain ${intent.chainId} is not ${binding.base.chainId}`)
  if (intent.contract.toLowerCase() !== binding.base.contract.toLowerCase()) deny(`contract ${intent.contract} is not the bound contract`)
  if (binding.base.excludedVaultIds.includes(intent.vaultId)) deny(`vault ${intent.vaultId} is a judge or retired vault`)
  if (intent.vaultId !== binding.base.vaultId) deny(`vault ${intent.vaultId} is not the bound vault ${binding.base.vaultId}`)

  // 2. The intent itself.
  if (intent.kind !== KIND_SPEND) deny(`intent kind ${intent.kind} is not SPEND; SWAP intents are never co-signed in P0`)
  if (intent.direction !== DIRECTION_NONE) deny(`SPEND intent has direction ${intent.direction}`)
  if (intent.maxSats <= 0n) deny('intent maxSats is not positive')
  if (intent.settled) deny('intent is already settled on Base')
  if (BigInt(req.now) + BigInt(binding.expiryMarginSec) >= intent.expiry) deny(`intent expires at ${intent.expiry}, now ${req.now} + ${binding.expiryMarginSec}s margin`)
  if (req.ledger !== 'new') deny(`journal already holds this intent as ${req.ledger}: one BSV transaction per intent`)

  // 3. Inputs: only bound vault UTXOs, each once, each believed unspent, at its known value.
  if (tx.version !== 1 || tx.lockTime !== 0) deny(`unexpected version ${tx.version} / lockTime ${tx.lockTime}`)
  if (tx.inputs.length === 0) deny('no inputs')
  let vaultIn = 0
  const seen = new Set<string>()
  tx.inputs.forEach((input, i) => {
    const outpoint = outpointOf(tx, i)
    if (seen.has(outpoint)) deny(`input ${i} spends ${outpoint} twice`)
    seen.add(outpoint)
    if ((input.sequence ?? 0xffffffff) !== 0xffffffff) deny(`input ${i} is not final`)
    const source = input.sourceTransaction?.outputs[input.sourceOutputIndex]
    if (input.sourceTransaction === undefined || source === undefined) {
      deny(`input ${i} has no source transaction`)
      return
    }
    if (input.sourceTXID !== undefined && input.sourceTXID !== input.sourceTransaction.id('hex')) deny(`input ${i} source does not match its txid`)
    if (source.lockingScript.toHex() !== binding.vaultLockingScript) deny(`input ${i} (${outpoint}) is not a vault UTXO`)
    const known = req.vaultUtxos.get(outpoint)
    if (known === undefined) deny(`input ${i} (${outpoint}) is not in the watcher's unspent vault set`)
    else if (known !== source.satoshis) deny(`input ${i} holds ${source.satoshis} sats, the watcher knows ${known}`)
    vaultIn += source.satoshis ?? 0
  })

  // 4. Outputs: exactly one float payment, at most one change back to the same vault script,
  // at most one zero-value OP_RETURN equal to the expected receipt. Nothing else.
  let toFloat = 0
  let floatOutputs = 0
  let change = 0
  let changeOutputs = 0
  let receipts = 0
  let outSum = 0
  tx.outputs.forEach((out, i) => {
    const script = out.lockingScript.toHex()
    const sats = out.satoshis ?? 0
    outSum += sats
    if (script === binding.floatLockingScript) {
      floatOutputs++
      toFloat += sats
      if (sats <= 0) deny(`float output ${i} pays nothing`)
    } else if (script === binding.vaultLockingScript) {
      changeOutputs++
      change += sats
      if (sats < binding.minChangeSats) deny(`vault change output ${i} is ${sats} sats, below ${binding.minChangeSats}`)
    } else if (isOpReturn(script)) {
      receipts++
      if (sats !== 0) deny(`OP_RETURN output ${i} carries ${sats} sats`)
      if (req.expectedReceipt === undefined || script !== req.expectedReceipt) deny(`OP_RETURN output ${i} is not the expected receipt`)
    } else {
      deny(`output ${i} pays an unauthorised script (${sats} sats)`)
    }
  })
  if (floatOutputs !== 1) deny(`expected exactly one Agent Float output, found ${floatOutputs}`)
  if (changeOutputs > 1) deny(`expected at most one vault change output, found ${changeOutputs}`)
  if (receipts > 1) deny(`more than one OP_RETURN output`)
  if (req.expectedReceipt !== undefined && receipts !== 1) deny('the expected receipt output is missing')

  // 5. Accounting, in bigint against the intent: everything that leaves the vault, fee included.
  const fee = vaultIn - outSum
  if (fee < 0) deny(`outputs (${outSum}) exceed vault inputs (${vaultIn})`)
  if (fee > binding.maxFeeSats) deny(`fee ${fee} sats is above the ${binding.maxFeeSats} sat cap`)
  const outflow = BigInt(vaultIn) - BigInt(change)
  if (outflow > intent.maxSats) deny(`vault outflow ${outflow} sats (float ${toFloat} + fee ${fee}) exceeds intent maxSats ${intent.maxSats}`)

  if (reasons.length > 0) return { verdict: 'DENY', reasons }
  return { verdict: 'APPROVE', proposalId: proposalIdOf(tx), vaultIn, toFloat, change, fee }
}

/**
 * The id of the transaction with its unlocking scripts left empty. Both signatures commit to
 * exactly this content, so it names the proposal before (and independently of) the signatures.
 */
export function proposalIdOf(tx: Transaction): string {
  const bare = Transaction.fromBinary(tx.toBinary())
  for (const input of bare.inputs) input.unlockingScript = new UnlockingScript()
  return bare.id('hex')
}
