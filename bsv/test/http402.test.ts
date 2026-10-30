// The Agent Float pays the paid API over HTTP 402 on the offline chain: no answer without a
// valid payment, the merchant is paid exactly the price, and the guardian decides on the float.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { create402Fetch } from '@bsv/402-pay/client'
import { buyResearch } from '../src/agent/buyResearch'
import { MockChain, type MockWallet } from '../src/chain/mockChain'
import { EventBus } from '../src/events'
import { Guardian } from '../src/guardian/guardian'
import { RESEARCH_PATH, startPaidApi, type PaidApi } from '../src/merchant/paidApi'
import { bindOriginator, createGuardedWallet } from '../src/wallet/agentWallet'

const PRICE = 1_000
const MERCHANT = 'research.example.com'

let chain: MockChain
let merchant: MockWallet
let float: MockWallet
let api: PaidApi

before(async () => {
  chain = await MockChain.create()
  merchant = await chain.createWallet('merchant', 1_000, 1)
  float = await chain.createWallet('float', 30_000, 3)
  api = await startPaidApi(merchant.wallet, { priceSats: PRICE })
})

after(async () => {
  await api.close()
  await chain.destroy()
})

test('without a payment the API answers 402 and serves nothing', async () => {
  const res = await fetch(`${api.baseUrl}${RESEARCH_PATH}?topic=x`)
  assert.equal(res.status, 402)
  assert.equal(api.served.length, 0)
})

test('@bsv/402-pay 0.3.3 needs withHostOriginator with a wallet-toolbox wallet', async () => {
  await assert.rejects(create402Fetch({ wallet: float.wallet })(`${api.baseUrl}${RESEARCH_PATH}`), /originator/i)
})

test('the float pays the price and gets the answer; the merchant is paid exactly', async () => {
  const before = await merchant.wallet.balance()
  const bought = await buyResearch(float.wallet, `${api.baseUrl}${RESEARCH_PATH}?topic=treasury`)
  assert.equal(bought.status, 200)
  assert.equal((bought.body as { topic: string }).topic, 'treasury')
  assert.match(bought.paymentTxid ?? '', /^[0-9a-f]{64}$/)
  assert.equal(await merchant.wallet.balance(), before + PRICE)
  assert.equal(api.served.length, 1)
})

test('behind the guardian: a declared purchase is approved, an undeclared one is refused unpaid', async () => {
  const guarded = createGuardedWallet(float.wallet)
  const guardian = new Guardian({
    manager: guarded,
    wallet: float.wallet,
    events: new EventBus(),
    limits: { maxPerPaymentSats: 5_000, dailyBudgetSats: 20_000, reserveSats: 1_000 },
    issueAllowances: false,
    merchants: [{ domain: MERCHANT, label: 'Research API', trust: 'trusted' }],
    useClaude: false
  })
  guardian.start()
  const asMerchant = bindOriginator(guarded, MERCHANT)
  const url = `${api.baseUrl}${RESEARCH_PATH}?topic=guarded`

  const served = api.served.length
  await assert.rejects(buyResearch(asMerchant, url))
  assert.equal(guardian.journal.at(-1)?.verdict.decision, 'deny')
  assert.equal(api.served.length, served)

  await guardian.declareIntent({ merchant: MERCHANT, item: 'research note', why: 'Agent task needs one research answer', expectedSats: PRICE, source: 'self' })
  const bought = await buyResearch(asMerchant, url).finally(() => guardian.clearIntent(MERCHANT))
  assert.equal(bought.status, 200)
  assert.equal(guardian.journal.at(-1)?.verdict.decision, 'approve')
})
