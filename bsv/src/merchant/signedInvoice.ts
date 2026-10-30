// An invoice the agent can authenticate: the merchant signs the exact terms with its identity
// (BRC-3, counterparty "anyone"), and the agent checks the signature against the merchant
// identity key it already trusts. A swapped receive key, amount or asset breaks the signature.
import { ProtoWallet, PublicKey, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import type { InvoiceTerms } from './invoice'

export const INVOICE_PROTOCOL: WalletProtocol = [1, 'treasury guard invoice']

export interface SignedInvoice {
  terms: InvoiceTerms
  merchantIdentityKey: string
  signature: string
}

function canonical(t: InvoiceTerms): number[] {
  return Utils.toArray(JSON.stringify([t.orderId, t.assetId, t.amount, t.metadata ?? null, t.publicKey, t.expiresAt]), 'utf8')
}

export async function signInvoice(wallet: WalletInterface, terms: InvoiceTerms, originator?: string): Promise<SignedInvoice> {
  const { publicKey: merchantIdentityKey } = await wallet.getPublicKey({ identityKey: true }, originator)
  const { signature } = await wallet.createSignature(
    { data: canonical(terms), protocolID: INVOICE_PROTOCOL, keyID: terms.orderId, counterparty: 'anyone' },
    originator
  )
  return { terms, merchantIdentityKey, signature: Utils.toHex([...signature]) }
}

/** True only if `trustedMerchantKey` signed exactly these terms. */
export async function verifyInvoice(invoice: SignedInvoice, trustedMerchantKey: string): Promise<boolean> {
  if (invoice.merchantIdentityKey !== trustedMerchantKey) return false
  try {
    PublicKey.fromString(invoice.terms.publicKey)
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: canonical(invoice.terms),
      signature: Utils.toArray(invoice.signature, 'hex'),
      protocolID: INVOICE_PROTOCOL,
      keyID: invoice.terms.orderId,
      counterparty: trustedMerchantKey
    })
    return valid
  } catch {
    return false
  }
}
