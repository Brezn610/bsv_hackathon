// executeSwap on the offline chain: one good swap-and-pay priced from a signed BSV/USD rate,
// then every way it must refuse. A refusal before the wallet means createAction is never called.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { LockingScript, PrivateKey, Transaction, type WalletInterface } from '@bsv/sdk'
import { BTMS } from '@bsv/btms'
import { MockChain, type MockWallet } from '../src/chain/mockChain'
import { checkTransaction, swapPayPlan } from '../src/guardian/txCheck'
import { acceptPayment, createInvoice, invoiceTerms, type Invoice } from '../src/merchant/invoice'
import { signInvoice, type SignedInvoice } from '../src/merchant/signedInvoice'
import { LocalRegistry } from '../src/registry/localRegistry'
import { executeSwap, satsForUsd, SwapRefused, type ExecuteSwapArgs, type ReplayStore } from '../src/swap/executeSwap'
import { collectProceeds, createOffer, type SignedOffer } from '../src/swap/offer'
import { BTMS_BASKET, bytes } from '../src/token/pusd'
import { splitToken, type OwnedToken, type SplitResult } from '../src/token/split'
import { bindOriginator, createGuardedWallet } from '../src/wallet/agentWallet'

// $20.00 per BSV, 8 decimals: one cent is 50,000 sats.
const PRICE8 = 2_000_000_000n
const CENT_SATS = Number(satsForUsd(10_000n, PRICE8))
const QUOTE = { unitUsdMicro: 10_000n, slippageBps: 100n, maxRateAgeSec: 300 }

let chain: MockChain
let registry: LocalRegistry
let maker: MockWallet
let merchant: MockWallet
let agent: MockWallet
let split: SplitResult
let assetId: string

before(async () => {
  chain = await MockChain.create()
  registry = new LocalRegistry()
  maker = await chain.createWallet('maker', 20_000, 2)
  merchant = await chain.createWallet('merchant', 5_000, 2)
  agent = await chain.createWallet('agent', 400_000, 4)
  const btms = registry.attach(new BTMS({ wallet: maker.wallet as any, networkPreset: 'local' }))
  const issued = await btms.issue(100, { name: 'pUSD', description: '1 unit = 1 US cent (demo token)' })
  assert.ok(issued.success)
  assetId = issued.assetId
  const { tokens } = await btms.getSpendableTokens(assetId)
  const ins = JSON.parse(tokens[0].customInstructions!) as { derivationPrefix: string; derivationSuffix: string }
  const { BEEF } = await maker.wallet.listOutputs({ basket: BTMS_BASKET, include: 'entire transactions' })
  const source: OwnedToken = { outpoint: tokens[0].outpoint, beef: bytes(BEEF!), keyID: `${ins.derivationPrefix} ${ins.derivationSuffix}`, assetId, amount: 100, metadata: tokens[0].token.metadata }
  split = await splitToken(maker.wallet, source, [1, 1, 1, 1, 1, 1])
  await registry.submit(split.tx)
})

after(async () => {
  await chain.destroy()
})

/** Counts createAction calls, so a test can prove the wallet was never asked. */
function spy(w: WalletInterface): { wallet: WalletInterface; calls: () => number } {
  let n = 0
  const wallet = new Proxy(w, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r)
      if (p !== 'createAction' || typeof v !== 'function') return v
      return async (...args: unknown[]) => {
        n++
        return await v.apply(t, args)
      }
    }
  })
  return { wallet, calls: () => n }
}

function agentWallet(owner: MockWallet): WalletInterface {
  const guarded = createGuardedWallet(owner.wallet)
  guarded.bindCallback('onSpendingAuthorizationRequested', async (req: any) => {
    await guarded.grantPermission({ requestID: req.requestID, ephemeral: true })
  })
  return bindOriginator(guarded, 'shop.example.com')
}

const memoryReplay = (): ReplayStore => {
  const s = new Set<string>()
  return { has: id => s.has(id), add: id => void s.add(id) }
}

async function setup(piece: number, opts: { priceSats?: number; amount?: number; ttlMs?: number } = {}) {
  const offer = await createOffer(maker.wallet, split.pieces[piece], opts.priceSats ?? CENT_SATS)
  const raw = await createInvoice(merchant.wallet, { assetId, amount: opts.amount ?? 1, metadata: offer.metadata, ttlMs: opts.ttlMs })
  const invoice = await signInvoice(merchant.wallet, invoiceTerms(raw))
  const trustedRegistry = new LocalRegistry()
  trustedRegistry.trust(offer.outpoint, offer.beef)
  const s = spy(agentWallet(agent))
  const args: ExecuteSwapArgs = {
    wallet: s.wallet,
    offer,
    invoice,
    trusted: { assetId, merchantIdentityKey: merchant.identityKey },
    rate: { price8: PRICE8, signedAt: Math.floor(Date.now() / 1000) - 10, source: 'fixture: CoinPaprika BSV/USD shape' },
    quote: QUOTE,
    provenance: async outpoint => registry.isLive(outpoint),
    registry: trustedRegistry,
    replay: memoryReplay()
  }
  return { offer, raw, invoice, args, calls: s.calls }
}

const refused = async (args: ExecuteSwapArgs, calls: () => number, pattern: RegExp): Promise<void> => {
  await assert.rejects(executeSwap(args), (err: Error) => err instanceof SwapRefused && pattern.test(err.message))
  assert.equal(calls(), 0, 'the wallet was never asked to pay')
}

test('the quote is ceil(usdMicro * 10^10 / price8) plus slippage, in bigint', () => {
  assert.equal(satsForUsd(10_000n, PRICE8), 50_000n)
  assert.equal(satsForUsd(10_000n, PRICE8, 100n), 50_500n)
  assert.equal(satsForUsd(1n, 3n), 3_333_333_334n)
})

let good: { offer: SignedOffer; raw: Invoice; fillBeef: number[] }

test('a swap-and-pay priced from the signed rate goes through in one transaction', async () => {
  const { offer, raw, args } = await setup(0)
  const { fill, maxAllowedSats, fee } = await executeSwap(args)
  assert.equal(maxAllowedSats, 50_500n)
  assert.equal(fill.tx.outputs[0].satoshis, CENT_SATS)
  assert.equal(fill.tx.outputs[1].satoshis, 1)
  assert.ok(fee > 0)
  const accepted = await acceptPayment(merchant.wallet, raw, fill.atomicBeef, registry)
  assert.equal(accepted.txid, fill.txid)
  const before = await maker.wallet.balance()
  await collectProceeds(maker.wallet, offer, fill.atomicBeef)
  assert.equal(await maker.wallet.balance(), before + CENT_SATS)
  good = { offer, raw, fillBeef: fill.atomicBeef }
})

test('replayed offer and replayed invoice are refused', async () => {
  const { args, calls } = await setup(1)
  args.replay.add(`offer:${args.offer.outpoint}`)
  await refused(args, calls, /Offer was already used/)
  const second = await setup(1)
  second.args.replay.add(`invoice:${second.invoice.terms.orderId}`)
  await refused(second.args, second.calls, /Invoice was already paid/)
})

test('wrong asset and inflated amount are refused', async () => {
  const { args, calls } = await setup(1)
  await refused({ ...args, trusted: { ...args.trusted, assetId: 'deadbeef.0' } }, calls, /not the trusted|another asset/)
  const inflated = await setup(1, { amount: 2 })
  await refused(inflated.args, inflated.calls, /does not cover the invoice/)
})

test('a changed maker payment, and a price above the signed rate, are refused', async () => {
  const { args, calls } = await setup(1)
  await refused({ ...args, offer: { ...args.offer, priceSats: args.offer.priceSats - 1 } }, calls, /Maker signature does not validate/)
  const greedy = await setup(1, { priceSats: CENT_SATS * 2 })
  await refused(greedy.args, greedy.calls, /signed rate allows at most 50500/)
  const stale = await setup(1)
  await refused({ ...stale.args, rate: { ...stale.args.rate, signedAt: Math.floor(Date.now() / 1000) - 3600 } }, stale.calls, /Signed rate is \d+s old/)
})

test('a changed merchant key, a forged invoice signer and an expired invoice or offer are refused', async () => {
  const { args, calls } = await setup(1)
  const swapped: SignedInvoice = { ...args.invoice, terms: { ...args.invoice.terms, publicKey: PrivateKey.fromRandom().toPublicKey().toString() } }
  await refused({ ...args, invoice: swapped }, calls, /not signed by the trusted merchant/)
  const forged = await signInvoice(agent.wallet, args.invoice.terms)
  await refused({ ...args, invoice: forged }, calls, /not signed by the trusted merchant/)
  await refused({ ...args, now: args.invoice.terms.expiresAt + 1 }, calls, /Invoice has expired/)
  const shortInvoice = await setup(1, { ttlMs: 60 * 60_000 })
  await refused({ ...shortInvoice.args, now: shortInvoice.offer.expiresAt + 1 }, shortInvoice.calls, /Offer has expired/)
})

test('fake token ancestry and an offline token overlay are refused', async () => {
  const { args, calls } = await setup(1)
  await refused({ ...args, provenance: async () => false }, calls, /does not know the offered token/)
  await refused({ ...args, provenance: async () => { throw new Error('ECONNREFUSED') } }, calls, /overlay unavailable: ECONNREFUSED/)
  // Provenance said yes, but the registry the preview runs on does not trust the input: the output would be burned.
  await refused({ ...args, registry: new LocalRegistry() }, calls, /would not be admitted/)
})

test('a fill with the maker output moved is blocked by the transaction check', async () => {
  const { offer, raw } = await setup(1)
  const plan = await swapPayPlan(offer, invoiceTerms(raw))
  const tx = Transaction.fromAtomicBEEF(good.fillBeef)
  // Swap the two planned outputs, as a wallet that ignored randomizeOutputs: false would.
  const moved = new Transaction(1, tx.inputs, [tx.outputs[1], tx.outputs[0], ...tx.outputs.slice(2)], 0)
  moved.outputs[0].lockingScript = LockingScript.fromHex(plan.outputs[1].lockingScript)
  const findings = await checkTransaction(moved, plan)
  assert.ok(findings.some(f => f.severity === 'block' && f.rule === 'tx-inputs'))
  assert.ok(findings.some(f => f.severity === 'block' && f.rule === 'tx-outputs'))
})

test('insufficient sats: the fill fails, nothing is paid and the offer is still fillable', async () => {
  const poor = await chain.createWallet('poor', 1_000, 1)
  const { args } = await setup(2)
  const s = spy(agentWallet(poor))
  await assert.rejects(executeSwap({ ...args, wallet: s.wallet }))
  assert.equal(s.calls(), 1)
  assert.equal(registry.isLive(args.offer.outpoint), true)
  // A funded agent (fresh replay store) can still take it.
  const retry = await setup(2)
  const { fill } = await executeSwap({ ...retry.args, offer: args.offer })
  assert.match(fill.txid, /^[0-9a-f]{64}$/)
})
