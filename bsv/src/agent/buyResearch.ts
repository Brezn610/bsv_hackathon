// The Agent Float buys one answer from a paid API. The float wallet is a normal wallet: Base
// authorised how many sats reached it, not what it buys. The guardian (merchant allowlist,
// declared price, per-payment cap) is the control on this side.
import { create402Fetch } from '@bsv/402-pay/client'
import type { WalletInterface } from '@bsv/sdk'
import { withHostOriginator } from '../wallet/originator'

export interface Purchase {
  status: number
  body: unknown
  /** The 402 payment transaction, as the merchant received it. */
  paymentTxid?: string
}

export async function buyResearch(wallet: WalletInterface, url: string): Promise<Purchase> {
  let paymentTxid: string | undefined
  // Record the payment txid the wallet produced, for the evidence log.
  const recording = new Proxy(wallet, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r)
      if (p !== 'createAction' || typeof v !== 'function') return v
      return async (...args: unknown[]) => {
        const res = await v.apply(t, args)
        paymentTxid = res.txid
        return res
      }
    }
  })
  const fetch402 = create402Fetch({ wallet: withHostOriginator(recording) })
  const res = await fetch402(url)
  const body = await res.json().catch(() => undefined)
  return { status: res.status, body, paymentTxid }
}
