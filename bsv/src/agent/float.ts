// The Agent Float: the single pre-registered recipient of vault withdrawals. It is a BRC-29
// key of the agent's own wallet with a fixed derivation, so the agent wallet can take a
// withdrawal in with internalizeAction ('wallet payment') and spend it like any other coin.
import { Beef, P2PKH, PublicKey, Transaction, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'

const BRC29_PROTOCOL: WalletProtocol = [2, '3241645161d8']
export const FLOAT_DERIVATION = {
  derivationPrefix: Utils.toBase64(Utils.toArray('treasury-guard-float', 'utf8')),
  derivationSuffix: Utils.toBase64(Utils.toArray('v1', 'utf8'))
}

export async function floatLockingScript(wallet: WalletInterface, originator?: string): Promise<string> {
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true }, originator)
  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: BRC29_PROTOCOL,
      keyID: `${FLOAT_DERIVATION.derivationPrefix} ${FLOAT_DERIVATION.derivationSuffix}`,
      counterparty: identityKey,
      forSelf: true
    },
    originator
  )
  return new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex()
}

/** Takes the float output of a vault withdrawal into the agent wallet. `ancestry` holds the vault deposit's BEEF. */
export async function internalizeWithdrawal(
  wallet: WalletInterface,
  withdrawal: Transaction,
  ancestry: number[],
  floatScript: string,
  originator?: string
): Promise<void> {
  const outputIndex = withdrawal.outputs.findIndex(o => o.lockingScript.toHex() === floatScript)
  if (outputIndex === -1) throw new Error('Withdrawal has no Agent Float output')
  const beef = Beef.fromBinary(ancestry)
  beef.mergeRawTx(withdrawal.toBinary())
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true }, originator)
  await wallet.internalizeAction(
    {
      tx: beef.toBinaryAtomic(withdrawal.id('hex')),
      description: 'Treasury Guard vault withdrawal',
      outputs: [{ outputIndex, protocol: 'wallet payment', paymentRemittance: { ...FLOAT_DERIVATION, senderIdentityKey: identityKey } }]
    },
    originator
  )
}
