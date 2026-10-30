// @bsv/402-pay 0.3.3's client passes the request origin with its scheme ("http://host:port")
// as the BRC-100 originator; wallet-toolbox wallets require a bare host. This is the wrapper
// from the BSV stack guide §10.4 (examples/payPerRequest.ts), unchanged.
import type { WalletInterface } from '@bsv/sdk'

export function withHostOriginator(wallet: WalletInterface): WalletInterface {
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (args: unknown, originator?: string) =>
        value.call(target, args, typeof originator === 'string' ? originator.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') : originator)
    }
  })
}
