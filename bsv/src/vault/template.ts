// The Treasury Guard vault: a BSV output that the agent and the watcher can only spend together,
// and that the owner can always spend alone.
//
//   OP_IF   <agentKey> OP_CHECKSIGVERIFY <watcherKey> OP_CHECKSIG
//   OP_ELSE <ownerKey> OP_CHECKSIG
//   OP_ENDIF
//
// Unlocking: agent+watcher = <watcherSig> <agentSig> OP_1; owner alone = <ownerSig> OP_0.
// Every key is a BRC-42 derived key of its holder's wallet (never an identity key), and every
// signature is made with wallet.createSignature over the BIP-143 style preimage, like PushDrop.
import {
  Hash,
  LockingScript,
  OP,
  Signature,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type WalletInterface,
  type WalletProtocol
} from '@bsv/sdk'

/** Security level 2: a key that controls value, bound to one counterparty (self). */
export const VAULT_PROTOCOL: WalletProtocol = [2, 'treasury guard vault']

export type VaultRole = 'agent' | 'watcher' | 'owner'

export interface VaultKeys {
  agent: string
  watcher: string
  owner: string
}

/** One party's signing capability: its wallet, the derivation and how it reaches the wallet. */
/** All a vault signer needs from a wallet. ProtoWallet, wallet-toolbox and WalletClient all fit. */
export type SigningWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>

export interface VaultSigner {
  wallet: SigningWallet
  keyID: string
  protocol?: WalletProtocol
  originator?: string
}

const SIGHASH_ALL_FORKID = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID

function pushKey(hex: string): { op: number; data: number[] } {
  const data = Utils.toArray(hex, 'hex')
  if (data.length !== 33 || (data[0] !== 0x02 && data[0] !== 0x03)) throw new Error(`Not a compressed public key: ${hex}`)
  return { op: data.length, data }
}

export function vaultLockingScript(keys: VaultKeys): LockingScript {
  if (new Set([keys.agent, keys.watcher, keys.owner]).size !== 3) throw new Error('Agent, watcher and owner keys must all differ')
  return new LockingScript([
    { op: OP.OP_IF },
    pushKey(keys.agent),
    { op: OP.OP_CHECKSIGVERIFY },
    pushKey(keys.watcher),
    { op: OP.OP_CHECKSIG },
    { op: OP.OP_ELSE },
    pushKey(keys.owner),
    { op: OP.OP_CHECKSIG },
    { op: OP.OP_ENDIF }
  ])
}

/** Reads the three keys back out of a vault script, or returns undefined if it is not one. */
export function parseVaultScript(script: LockingScript): VaultKeys | undefined {
  const c = script.chunks
  const ops = [OP.OP_IF, 33, OP.OP_CHECKSIGVERIFY, 33, OP.OP_CHECKSIG, OP.OP_ELSE, 33, OP.OP_CHECKSIG, OP.OP_ENDIF]
  if (c.length !== ops.length || c.some((chunk, i) => chunk.op !== ops[i])) return undefined
  const hex = (i: number): string => Utils.toHex(c[i].data ?? [])
  const keys = { agent: hex(1), watcher: hex(3), owner: hex(6) }
  return vaultLockingScript(keys).toHex() === script.toHex() ? keys : undefined
}

export async function vaultPublicKey(signer: VaultSigner): Promise<string> {
  const { publicKey } = await signer.wallet.getPublicKey(
    { protocolID: signer.protocol ?? VAULT_PROTOCOL, keyID: signer.keyID, counterparty: 'self' },
    signer.originator
  )
  return publicKey
}

/** The SIGHASH_ALL|FORKID preimage hash of `inputIndex`; the input's source transaction must be attached. */
export function sighashOf(tx: Transaction, inputIndex: number): number[] {
  return Hash.sha256(tx.preimage(inputIndex, SIGHASH_ALL_FORKID))
}

/**
 * One checksig-format signature (DER + sighash byte) over input `inputIndex` of `tx`, made by
 * the signer's wallet. Always SIGHASH_ALL|FORKID: the signature commits to every input and
 * output, so it is valid for this exact transaction only.
 */
export async function signVaultInput(signer: VaultSigner, tx: Transaction, inputIndex: number): Promise<number[]> {
  const { signature } = await signer.wallet.createSignature(
    { data: sighashOf(tx, inputIndex), protocolID: signer.protocol ?? VAULT_PROTOCOL, keyID: signer.keyID, counterparty: 'self' },
    signer.originator
  )
  const sig = Signature.fromDER([...signature])
  return new TransactionSignature(sig.r, sig.s, SIGHASH_ALL_FORKID).toChecksigFormat()
}

const push = (data: number[]): { op: number; data: number[] } => ({ op: data.length, data })

export function cosignUnlockingScript(agentSig: number[], watcherSig: number[]): UnlockingScript {
  return new UnlockingScript([push(watcherSig), push(agentSig), { op: OP.OP_1 }])
}

export function ownerUnlockingScript(ownerSig: number[]): UnlockingScript {
  return new UnlockingScript([push(ownerSig), { op: OP.OP_0 }])
}

/** Runs the script interpreter on one input, as a miner would. The source transaction must be attached. */
export function verifyInput(tx: Transaction, inputIndex: number): { ok: boolean; error?: string } {
  const input = tx.inputs[inputIndex]
  const source = input.sourceTransaction
  if (source === undefined) return { ok: false, error: 'source transaction missing' }
  const output = source.outputs[input.sourceOutputIndex]
  if (input.unlockingScript === undefined) return { ok: false, error: 'no unlocking script' }
  try {
    const ok = new Spend({
      sourceTXID: source.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: output.satoshis ?? 0,
      lockingScript: output.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
      outputs: tx.outputs,
      inputIndex,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime
    }).validate()
    return ok ? { ok: true } : { ok: false, error: 'script evaluated to false' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
