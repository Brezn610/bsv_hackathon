// The owner's way out: spends vault UTXOs with the owner key alone. Needs no agent, no watcher
// and no Base transaction. Two forms:
// - ownerExitThroughWallet: the owner's own BRC-100 wallet (BSV Desktop, or a wallet-toolbox
//   wallet) builds the transaction, takes the sats as change and broadcasts it;
// - ownerExitRaw: a self-contained transaction to any script the owner chooses, signed with
//   createSignature only, for when the owner wants to broadcast it some other way.
import { LockingScript, Script, Transaction, type AtomicBEEF, type WalletInterface } from '@bsv/sdk'
import { estimateFee, DEFAULT_FEE_SATS_PER_KB, type VaultUtxo } from './proposeSpend'
import { ownerUnlockingScript, signVaultInput, verifyInput, VAULT_PROTOCOL, type VaultSigner } from './template'

/** Owner unlock: <= 1+73 signature + OP_0. */
export const OWNER_UNLOCK_BYTES = 75

export function ownerExitRaw(utxos: VaultUtxo[], destination: string, feeSatsPerKb = DEFAULT_FEE_SATS_PER_KB): Transaction {
  const tx = new Transaction(1, [], [], 0)
  let total = 0
  for (const u of utxos) {
    const [, vout] = u.outpoint.split('.')
    tx.addInput({ sourceTransaction: u.sourceTransaction, sourceOutputIndex: Number(vout), sequence: 0xffffffff, unlockingScript: new Script() })
    total += u.satoshis
  }
  tx.addOutput({ satoshis: 0, lockingScript: LockingScript.fromHex(destination) })
  const fee = estimateFee(tx, OWNER_UNLOCK_BYTES, feeSatsPerKb)
  if (total - fee <= 0) throw new Error(`Vault holds ${total} sats, less than the ${fee} sat fee`)
  tx.outputs[0].satoshis = total - fee
  return tx
}

export async function signOwnerExit(owner: VaultSigner, tx: Transaction): Promise<Transaction> {
  for (let i = 0; i < tx.inputs.length; i++) tx.inputs[i].unlockingScript = ownerUnlockingScript(await signVaultInput(owner, tx, i))
  tx.inputs.forEach((_, i) => {
    const check = verifyInput(tx, i)
    if (!check.ok) throw new Error(`Owner unlock of input ${i} fails: ${check.error}`)
  })
  return tx
}

export interface WalletExitResult {
  txid: string
  tx: Transaction
}

/**
 * The owner's wallet spends the vault UTXOs and keeps the sats as change. createAction reserves
 * the inputs; if anything fails before signAction completes, the action is aborted so no wallet
 * coin stays locked.
 */
export async function ownerExitThroughWallet(
  owner: VaultSigner & { wallet: WalletInterface },
  utxos: VaultUtxo[],
  inputBEEF: number[],
  description = 'Treasury Guard owner exit'
): Promise<WalletExitResult> {
  const wallet: WalletInterface = owner.wallet
  const created = await wallet.createAction(
    {
      description,
      inputBEEF,
      inputs: utxos.map(u => ({ outpoint: u.outpoint, unlockingScriptLength: OWNER_UNLOCK_BYTES, inputDescription: 'vault UTXO (owner exit)' })),
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    },
    owner.originator
  )
  const signable = created.signableTransaction
  if (signable === undefined) throw new Error('Wallet did not return a signable transaction')
  try {
    const tx = Transaction.fromAtomicBEEF(signable.tx)
    const spends: Record<number, { unlockingScript: string }> = {}
    const wanted = new Map(utxos.map(u => [u.outpoint, u]))
    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i]
      const outpoint = `${input.sourceTXID ?? input.sourceTransaction?.id('hex')}.${input.sourceOutputIndex}`
      const utxo = wanted.get(outpoint)
      if (utxo === undefined) continue
      input.sourceTransaction ??= utxo.sourceTransaction
      const sig = await signVaultInput({ ...owner, protocol: owner.protocol ?? VAULT_PROTOCOL }, tx, i)
      spends[i] = { unlockingScript: ownerUnlockingScript(sig).toHex() }
    }
    if (Object.keys(spends).length !== utxos.length) throw new Error('Not every vault UTXO is an input of the exit')
    const signed = await wallet.signAction({ reference: signable.reference, spends, options: { acceptDelayedBroadcast: false } }, owner.originator)
    if (signed.txid === undefined || signed.tx === undefined) throw new Error('Wallet did not sign the exit')
    return { txid: signed.txid, tx: Transaction.fromAtomicBEEF(signed.tx as AtomicBEEF) }
  } catch (err) {
    await wallet.abortAction({ reference: signable.reference }, owner.originator).catch(() => {})
    throw err
  }
}

