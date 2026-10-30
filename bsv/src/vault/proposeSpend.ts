// The agent's half of a vault withdrawal: a transaction that spends vault UTXOs, pays the fixed
// Agent Float, returns the rest to the same vault script and pays the fee out of the vault.
// No wallet funding inputs are added, so vault accounting cannot hide behind other coins.
import { LockingScript, OP, Script, Transaction, Utils } from '@bsv/sdk'
import { cosignUnlockingScript, signVaultInput, verifyInput, type VaultSigner } from './template'

export interface VaultUtxo {
  outpoint: string
  satoshis: number
  /** The transaction that created the output. */
  sourceTransaction: Transaction
}

/** Sizes used for the fee estimate: a cosign unlock is <= 1+73 + 1+73 + 1 bytes. */
const COSIGN_UNLOCK_BYTES = 149
export const DEFAULT_FEE_SATS_PER_KB = 100

export interface SpendProposal {
  utxos: VaultUtxo[]
  vaultLockingScript: string
  floatLockingScript: string
  amountSats: number
  /** Optional OP_FALSE OP_RETURN audit label; checked byte for byte by the watcher. */
  receiptScript?: string
  feeSatsPerKb?: number
}

export function estimateFee(tx: Transaction, unlockBytesPerInput: number, satsPerKb: number): number {
  const unsignedBytes = tx.toBinary().length
  return Math.max(1, Math.ceil(((unsignedBytes + unlockBytesPerInput * tx.inputs.length) * satsPerKb) / 1000))
}

/** Unsigned withdrawal: output 0 to the float, output 1 change to the vault (if any), then the receipt. */
export function proposeSpend(p: SpendProposal): Transaction {
  if (!Number.isSafeInteger(p.amountSats) || p.amountSats <= 0) throw new Error(`Invalid amount ${p.amountSats}`)
  if (p.utxos.length === 0) throw new Error('No vault UTXOs to spend')
  const vault = LockingScript.fromHex(p.vaultLockingScript)
  const tx = new Transaction(1, [], [], 0)
  let inputSats = 0
  for (const u of p.utxos) {
    const [txid, vout] = u.outpoint.split('.')
    const out = u.sourceTransaction.outputs[Number(vout)]
    if (u.sourceTransaction.id('hex') !== txid || out === undefined) throw new Error(`UTXO ${u.outpoint} does not match its source`)
    if (out.lockingScript.toHex() !== p.vaultLockingScript) throw new Error(`UTXO ${u.outpoint} is not locked to the vault`)
    if (out.satoshis !== u.satoshis) throw new Error(`UTXO ${u.outpoint} holds ${out.satoshis} sats, not ${u.satoshis}`)
    inputSats += u.satoshis
    tx.addInput({ sourceTransaction: u.sourceTransaction, sourceOutputIndex: Number(vout), sequence: 0xffffffff, unlockingScript: new Script() })
  }
  tx.addOutput({ satoshis: p.amountSats, lockingScript: LockingScript.fromHex(p.floatLockingScript) })
  // A change output first, sized after the fee is known.
  tx.addOutput({ satoshis: 0, lockingScript: vault })
  if (p.receiptScript !== undefined) tx.addOutput({ satoshis: 0, lockingScript: LockingScript.fromHex(p.receiptScript) })
  const fee = estimateFee(tx, COSIGN_UNLOCK_BYTES, p.feeSatsPerKb ?? DEFAULT_FEE_SATS_PER_KB)
  const change = inputSats - p.amountSats - fee
  if (change < 0) throw new Error(`Vault holds ${inputSats} sats; ${p.amountSats} + ${fee} fee does not fit`)
  if (change === 0) tx.outputs.splice(1, 1)
  else tx.outputs[1].satoshis = change
  return tx
}

/** Deterministic audit label linking the BSV withdrawal to the Base intent. Not a proof of anything on Base. */
export function receiptScript(r: { chainId: number; contract: string; vaultId: bigint; intentId: bigint }): string {
  const text = `TGv1 ${r.chainId} ${r.contract.toLowerCase()} ${r.vaultId} ${r.intentId}`
  return new Script([{ op: OP.OP_FALSE }, { op: OP.OP_RETURN }, { op: text.length, data: Utils.toArray(text, 'utf8') }]).toHex()
}

/** Agent signs every input. The signatures commit to the whole transaction. */
export async function agentSignatures(agent: VaultSigner, tx: Transaction): Promise<number[][]> {
  return await Promise.all(tx.inputs.map(async (_, i) => await signVaultInput(agent, tx, i)))
}

/** Puts both signatures in place and checks every input with the script interpreter. */
export function assembleCosigned(tx: Transaction, agentSigs: number[][], watcherSigs: number[][]): Transaction {
  if (agentSigs.length !== tx.inputs.length || watcherSigs.length !== tx.inputs.length) throw new Error('One signature per input is needed')
  tx.inputs.forEach((input, i) => {
    input.unlockingScript = cosignUnlockingScript(agentSigs[i], watcherSigs[i])
  })
  tx.inputs.forEach((_, i) => {
    const check = verifyInput(tx, i)
    if (!check.ok) throw new Error(`Input ${i} does not unlock: ${check.error}`)
  })
  return tx
}
