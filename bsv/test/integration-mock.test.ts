// The whole P0 loop on the offline chain, with a fixture SPEND intent in the shape getIntent
// returns: owner funds the vault -> watcher checks the real transaction and cosigns -> the
// withdrawal is broadcast -> the Agent Float takes it in -> the float buys a paid API over 402
// -> the receipt links intent and BSV txid. Then the owner exits the remainder alone.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { Beef, Transaction } from '@bsv/sdk'
import { buyResearch } from '../src/agent/buyResearch'
import { floatLockingScript, internalizeWithdrawal } from '../src/agent/float'
import { settleTxidArg, type ConfirmedIntent } from '../src/api3/policyTypes'
import { MockChain, type MockWallet } from '../src/chain/mockChain'
import { withdrawForIntent } from '../src/flow/withdraw'
import { RESEARCH_PATH, startPaidApi } from '../src/merchant/paidApi'
import { ownerExitThroughWallet } from '../src/vault/ownerExit'
import type { VaultUtxo } from '../src/vault/proposeSpend'
import { vaultLockingScript, vaultPublicKey } from '../src/vault/template'
import { Watcher } from '../src/watcher/service'
import { WatcherJournal } from '../src/watcher/state'

const CONTRACT = '0x8e38cc6B1Bd1f0D25357066cd0036f28fd1f7773'
const KEY_ID = 'vault-5-v1'
let chain: MockChain
let owner: MockWallet
let agent: MockWallet
let watcherW: MockWallet
let merchant: MockWallet

before(async () => {
  chain = await MockChain.create()
  owner = await chain.createWallet('owner', 50_000, 2)
  agent = await chain.createWallet('agent', 0)
  watcherW = await chain.createWallet('watcher', 0)
  merchant = await chain.createWallet('merchant', 1_000, 1)
})

after(async () => {
  await chain.destroy()
})

test('Base intent -> watcher -> vault withdrawal -> Agent Float -> HTTP 402, then owner exit', async () => {
  const agentSigner = { wallet: agent.wallet, keyID: KEY_ID }
  const watcherSigner = { wallet: watcherW.wallet, keyID: KEY_ID }
  const ownerSigner = { wallet: owner.wallet, keyID: KEY_ID }
  const vault = vaultLockingScript({
    agent: await vaultPublicKey(agentSigner),
    watcher: await vaultPublicKey(watcherSigner),
    owner: await vaultPublicKey(ownerSigner)
  }).toHex()
  const float = await floatLockingScript(agent.wallet)

  // Owner deposits 5,000 sats.
  const dep = await owner.wallet.createAction({
    description: 'Fund Treasury Guard vault',
    outputs: [{ lockingScript: vault, satoshis: 5_000, outputDescription: 'vault deposit' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  const depositBeef = Array.from(dep.tx!)
  const depositTx = Transaction.fromAtomicBEEF(depositBeef)
  const utxo: VaultUtxo = { outpoint: `${dep.txid}.0`, satoshis: 5_000, sourceTransaction: depositTx }

  const now = Math.floor(Date.now() / 1000)
  const intent: ConfirmedIntent = {
    chainId: 84532, contract: CONTRACT, intentId: 42n, vaultId: 5n, kind: 0, direction: 0, source: 0,
    maxSats: 3_000n, maxBps: 0n, minOut: 0n, maxOut: 0n, expiry: BigInt(now + 900), price: 1_707_000_000n,
    priceSignedAt: BigInt(now - 20), settled: false, bsvTxid: '0x' + '00'.repeat(32), readAtBlock: 1n, latestBlock: 2n
  }
  const watcher = new Watcher({
    binding: {
      version: 'mock-1', bsvNetwork: 'mock',
      base: { chainId: 84532, contract: CONTRACT, vaultId: 5n, excludedVaultIds: [6n, 7n, 1n, 2n, 3n, 4n] },
      vaultLockingScript: vault, floatLockingScript: float, maxFeeSats: 200, expiryMarginSec: 60, minChangeSats: 1
    },
    reader: { readIntent: async id => { if (id !== 42n) throw new Error('unknown'); return intent } },
    journal: new WatcherJournal(path.join(mkdtempSync(path.join(tmpdir(), 'tg-')), 'journal.json')),
    signer: watcherSigner,
    unspentVaultUtxos: async () => new Map([[utxo.outpoint, 5_000]])
  })

  const w = await withdrawForIntent({
    intent, agent: agentSigner, watcher, utxos: [utxo], vaultLockingScript: vault, floatLockingScript: float, feeReserveSats: 100,
    broadcast: async tx => {
      const beef = Beef.fromBinary(depositBeef)
      beef.mergeRawTx(tx.toBinary())
      const [r] = await chain.services.postBeef(beef, [tx.id('hex')])
      if (r.status !== 'success') throw new Error(JSON.stringify(r))
    }
  })
  assert.equal(w.amountSats, 2_900)
  assert.ok(BigInt(5_000 - w.tx.outputs[1].satoshis!) <= intent.maxSats)
  assert.equal(w.tx.outputs[1].lockingScript.toHex(), vault)

  // A second withdrawal for the same intent is refused.
  await assert.rejects(withdrawForIntent({ intent, agent: agentSigner, watcher, utxos: [utxo], vaultLockingScript: vault, floatLockingScript: float, feeReserveSats: 100, broadcast: async () => {} }), /Watcher refused/)

  await internalizeWithdrawal(agent.wallet, w.tx, depositBeef, float)
  assert.equal(await agent.wallet.balance(), 2_900)

  const api = await startPaidApi(merchant.wallet, { priceSats: 1_000 })
  try {
    const bought = await buyResearch(agent.wallet, `${api.baseUrl}${RESEARCH_PATH}?topic=vault`)
    assert.equal(bought.status, 200)
    assert.match(bought.paymentTxid ?? '', /^[0-9a-f]{64}$/)
  } finally {
    await api.close()
  }

  // Receipt for settle(intentId, bsvTxid): the withdrawal, not the merchant payment.
  assert.equal(settleTxidArg(w.txid), `0x${w.txid}`)

  // The owner takes the vault remainder back alone.
  const remainder: VaultUtxo = { outpoint: `${w.txid}.1`, satoshis: w.tx.outputs[1].satoshis!, sourceTransaction: w.tx }
  const ancestry = Beef.fromBinary(depositBeef)
  ancestry.mergeRawTx(w.tx.toBinary())
  const ownerBefore = await owner.wallet.balance()
  const exit = await ownerExitThroughWallet(ownerSigner, [remainder], Array.from(ancestry.toBinaryAtomic(w.txid)))
  assert.equal(await owner.wallet.balance(), ownerBefore + remainder.satoshis - exit.tx.getFee())
})
