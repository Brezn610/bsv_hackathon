// The only way the agent fills an offer. fillOffer alone signs whatever it is given; this
// wrapper makes every check mandatory and in order, and nothing reaches the wallet until all
// of them pass:
//   1. the invoice is signed by the trusted merchant, unexpired, unused, for the trusted asset;
//   2. the maker's offer signature is valid, unexpired, unused, and for exactly that token;
//   3. the price is within what the signed API3 BSV/USD rate allows (bigint, maker-favouring
//      rounding, explicit slippage);
//   4. the offered token's ancestry is accepted by the token overlay;
//   5. the BTMS rules admit the merchant's output of the fill (it is not burned);
//   6. offer and invoice are recorded as used before paying (a crash cannot pay twice);
//   7. after the wallet returns, output 0 pays the maker exactly and output 1 is the merchant's token.
// Pass the guarded wallet (WalletPermissionsManager + guardian + TxObserver), so the guardian
// also checks the built transaction before signing and a refusal releases the inputs.
import type { WalletInterface } from '@bsv/sdk'
import type { TxPlan } from '../guardian/txCheck'
import { swapPayPlan } from '../guardian/txCheck'
import { paymentLockingScript } from '../merchant/invoice'
import { verifyInvoice, type SignedInvoice } from '../merchant/signedInvoice'
import type { LocalRegistry } from '../registry/localRegistry'
import { fillOffer, previewFill, type Fill } from './fill'
import { checkOffer, type SignedOffer } from './offer'

/** A signed BSV/USD observation: price in USD per BSV with 8 decimals, as TreasuryGuard stores it. */
export interface SignedRate {
  price8: bigint
  /** Unix seconds when the API3 response was signed. */
  signedAt: number
  source: string
}

export interface QuotePolicy {
  /** USD value of one token unit in micro-USD (pUSD: 1 cent = 10_000). */
  unitUsdMicro: bigint
  slippageBps: bigint
  maxRateAgeSec: number
}

export interface ReplayStore {
  has: (id: string) => boolean
  add: (id: string) => void
}

export interface ExecuteSwapArgs {
  wallet: WalletInterface
  offer: SignedOffer
  invoice: SignedInvoice
  trusted: { assetId: string; merchantIdentityKey: string }
  rate: SignedRate
  quote: QuotePolicy
  /** Is this token output known to the token overlay? Throws when the overlay cannot be asked. */
  provenance: (outpoint: string) => Promise<boolean>
  /** A registry that trusts only outputs whose provenance was checked. */
  registry: LocalRegistry
  replay: ReplayStore
  /** Called with the plan right before the fill (e.g. guardian.declareIntent). */
  beforeFill?: (plan: TxPlan) => Promise<void>
  now?: number
}

export interface SwapResult {
  fill: Fill
  maxAllowedSats: bigint
  fee: number
}

export class SwapRefused extends Error {}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

/** Sats for `usdMicro` at `price8` (USD/BSV, 8 dp): ceil(usdMicro * 10^10 / price8), plus slippage, rounded up. */
export function satsForUsd(usdMicro: bigint, price8: bigint, slippageBps = 0n): bigint {
  if (price8 <= 0n || usdMicro < 0n || slippageBps < 0n) throw new Error('Invalid quote inputs')
  const base = ceilDiv(usdMicro * 10_000_000_000n, price8)
  return ceilDiv(base * (10_000n + slippageBps), 10_000n)
}

export async function executeSwap(a: ExecuteSwapArgs): Promise<SwapResult> {
  const now = a.now ?? Date.now()
  const refuse = (reason: string): never => {
    throw new SwapRefused(reason)
  }
  const { terms } = a.invoice

  // 1. Invoice
  if (!(await verifyInvoice(a.invoice, a.trusted.merchantIdentityKey))) refuse('Invoice is not signed by the trusted merchant')
  if (now > terms.expiresAt) refuse('Invoice has expired')
  if (terms.assetId !== a.trusted.assetId) refuse(`Invoice asks for asset ${terms.assetId}, not the trusted ${a.trusted.assetId}`)
  if (!Number.isSafeInteger(terms.amount) || terms.amount <= 0) refuse(`Invalid invoice amount ${terms.amount}`)
  if (a.replay.has(`invoice:${terms.orderId}`)) refuse('Invoice was already paid')

  // 2. Offer
  const check = checkOffer(a.offer, now)
  if (!check.ok) refuse(`Offer rejected: ${check.reason}`)
  if (a.offer.assetId !== a.trusted.assetId) refuse('Offer is for another asset')
  if (a.offer.amount !== terms.amount || a.offer.metadata !== terms.metadata) refuse('Offer does not cover the invoice')
  if (a.replay.has(`offer:${a.offer.outpoint}`)) refuse('Offer was already used')

  // 3. Price against the signed rate
  const ageSec = Math.floor(now / 1000) - a.rate.signedAt
  if (ageSec > a.quote.maxRateAgeSec || ageSec < -60) refuse(`Signed rate is ${ageSec}s old (limit ${a.quote.maxRateAgeSec}s)`)
  const maxAllowedSats = satsForUsd(a.quote.unitUsdMicro * BigInt(terms.amount), a.rate.price8, a.quote.slippageBps)
  if (BigInt(a.offer.priceSats) > maxAllowedSats) refuse(`Maker asks ${a.offer.priceSats} sats; the signed rate allows at most ${maxAllowedSats}`)

  // 4. Token provenance
  let known: boolean
  try {
    known = await a.provenance(a.offer.outpoint)
  } catch (err) {
    return refuse(`Token overlay unavailable: ${(err as Error).message}`)
  }
  if (!known) refuse('The token overlay does not know the offered token')

  // 5. BTMS admission of the merchant's output
  const merchantLock = await paymentLockingScript(terms)
  const preview = await previewFill(a.offer, merchantLock, a.registry)
  if (!preview.merchantOutputAdmitted) refuse("The merchant's token output would not be admitted (it would be burned)")

  // 6. Reserve, then pay
  const plan = await swapPayPlan(a.offer, terms)
  await a.beforeFill?.(plan)
  a.replay.add(`invoice:${terms.orderId}`)
  a.replay.add(`offer:${a.offer.outpoint}`)
  const fill = await fillOffer(a.wallet, a.offer, merchantLock)

  // 7. What was actually signed
  const [in0] = fill.tx.inputs
  const o0 = fill.tx.outputs[0]
  const o1 = fill.tx.outputs[1]
  if (`${in0.sourceTXID ?? in0.sourceTransaction?.id('hex')}.${in0.sourceOutputIndex}` !== a.offer.outpoint) refuse('Fill input 0 is not the offer')
  if (o0?.lockingScript.toHex() !== a.offer.payLockingScript || o0.satoshis !== a.offer.priceSats) refuse('Fill output 0 does not pay the maker exactly')
  if (o1?.lockingScript.toHex() !== merchantLock || o1.satoshis !== 1) refuse("Fill output 1 is not the merchant's token")
  return { fill, maxAllowedSats, fee: fill.tx.getFee() }
}
