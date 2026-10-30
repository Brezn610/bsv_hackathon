// The watcher as its own HTTP process (Option B): the agent talks to it through RemoteWatcher,
// which has the in-process Watcher's interface. Approval, refusals with their HTTP codes, a forged
// agent signature that must not burn the intent, the journal lock, and the public endpoints.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { P2PKH, PrivateKey, ProtoWallet, Script, Transaction } from '@bsv/sdk'
import type { ConfirmedIntent } from '../src/api3/policyTypes'
import { agentSignatures, assembleCosigned, proposeSpend, receiptScript, type VaultUtxo } from '../src/vault/proposeSpend'
import { vaultLockingScript, vaultPublicKey, verifyInput, type VaultSigner } from '../src/vault/template'
import { lockJournal } from '../src/watcher/lock'
import type { VaultBinding } from '../src/watcher/policy'
import { RemoteWatcher } from '../src/watcher/remoteWatcher'
import { startWatcherServer, type RunningWatcherServer } from '../src/watcher/server'
import { Watcher } from '../src/watcher/service'
import { WatcherJournal } from '../src/watcher/state'
import { encodeProposal } from '../src/watcher/wire'

const CONTRACT = '0x8e38cc6B1Bd1f0D25357066cd0036f28fd1f7773'
const NOW = 1_793_000_000
const signer = (): VaultSigner => ({ wallet: new ProtoWallet(PrivateKey.fromRandom()), keyID: 'vault-5-v1' })
const agent = signer()
const watcherKey = signer()
const owner = signer()
let binding: VaultBinding
let utxo: VaultUtxo
let utxo5: VaultUtxo
let server: RunningWatcherServer
let remote: RemoteWatcher
let journalFile: string

const intent = (id: bigint, over: Partial<ConfirmedIntent> = {}): ConfirmedIntent => ({
  chainId: 84532, contract: CONTRACT, intentId: id, vaultId: 5n, kind: 0, direction: 0, source: 0, maxSats: 5_000n, maxBps: 0n,
  minOut: 0n, maxOut: 0n, expiry: BigInt(NOW + 900), price: 1_726_000_000n, priceSignedAt: BigInt(NOW - 30), settled: false,
  bsvTxid: '0x' + '00'.repeat(32), readAtBlock: 100n, latestBlock: 101n, ...over
})
const INTENTS = new Map([[1n, intent(1n)], [3n, intent(3n, { vaultId: 8n, maxSats: 57_879n })], [5n, intent(5n)]])
const proposal = (id: bigint, amountSats = 3_000): Transaction =>
  proposeSpend({ utxos: [id === 5n ? utxo5 : utxo], vaultLockingScript: binding.vaultLockingScript, floatLockingScript: binding.floatLockingScript, amountSats, receiptScript: receiptScript({ chainId: 84532, contract: CONTRACT, vaultId: 5n, intentId: id }) })

before(async () => {
  const keys = { agent: await vaultPublicKey(agent), watcher: await vaultPublicKey(watcherKey), owner: await vaultPublicKey(owner) }
  const vault = vaultLockingScript(keys).toHex()
  binding = {
    version: 'server-test', bsvNetwork: 'mock',
    base: { chainId: 84532, contract: CONTRACT, vaultId: 5n, excludedVaultIds: [6n, 7n, 8n, 1n, 2n, 3n, 4n] },
    vaultLockingScript: vault, floatLockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()).toHex(),
    maxFeeSats: 200, expiryMarginSec: 60, minChangeSats: 1
  }
  const source = new Transaction(1, [], [{ satoshis: 10_000, lockingScript: Script.fromHex(vault) }], 0)
  utxo = { outpoint: `${source.id('hex')}.0`, satoshis: 10_000, sourceTransaction: source }
  // A second vault UTXO: the first is claimed by intent 1 and is never offered to another intent.
  const source5 = new Transaction(1, [], [{ satoshis: 8_000, lockingScript: Script.fromHex(vault) }], 0)
  utxo5 = { outpoint: `${source5.id('hex')}.0`, satoshis: 8_000, sourceTransaction: source5 }
  journalFile = path.join(mkdtempSync(path.join(tmpdir(), 'tg-srv-')), 'journal.json')
  const watcher = new Watcher({
    binding,
    journal: new WatcherJournal(journalFile),
    signer: watcherKey,
    reader: { readIntent: async id => { const i = INTENTS.get(id); if (i === undefined) throw new Error(`intent ${id} not found`); return i } },
    unspentVaultUtxos: async () => new Map([[utxo.outpoint, 10_000], [utxo5.outpoint, 8_000]]),
    now: () => NOW * 1000
  })
  server = await startWatcherServer({ watcher, agentKey: keys.agent, info: { binding: binding.version, watcherKey: keys.watcher }, port: 0 })
  remote = new RemoteWatcher(server.url, agent)
})

after(async () => {
  await server.close()
})

test('the agent gets the watcher signatures over HTTP and the transaction unlocks', async () => {
  const tx = proposal(1n)
  const { decision, signatures } = await remote.cosign(1n, tx)
  assert.equal(decision.verdict, 'APPROVE')
  const signed = assembleCosigned(tx, await agentSignatures(agent, tx), signatures!)
  assert.equal(verifyInput(signed, 0).ok, true)
  await remote.recordBroadcast(1n, signed)
  assert.equal(server.decisions.at(-1)?.verdict, 'APPROVE')
})

test('a used intent answers 409, a policy refusal 422, and the agent sees DENY', async () => {
  const again = await fetch(`${server.url}/cosign`, { method: 'POST', body: JSON.stringify(encodeProposal(1n, proposal(1n, 2_000), await agentSignatures(agent, proposal(1n, 2_000)))) })
  assert.equal(again.status, 409)
  const runner = proposal(3n)
  const res = await fetch(`${server.url}/cosign`, { method: 'POST', body: JSON.stringify(encodeProposal(3n, runner, await agentSignatures(agent, runner))) })
  assert.equal(res.status, 422)
  assert.match(JSON.stringify(await res.json()), /judge or retired|not the bound vault/)
  assert.equal((await remote.cosign(3n, proposal(3n))).decision.verdict, 'DENY')
})

test('a proposal without the agent signature is rejected with 403 and does not burn the intent', async () => {
  const tx = proposal(5n)
  const stranger = signer()
  const forged = await fetch(`${server.url}/cosign`, { method: 'POST', body: JSON.stringify(encodeProposal(5n, tx, await agentSignatures(stranger, tx))) })
  assert.equal(forged.status, 403)
  const missing = await fetch(`${server.url}/cosign`, { method: 'POST', body: JSON.stringify(encodeProposal(5n, tx, [])) })
  assert.equal(missing.status, 403)
  // The real agent can still use intent 5.
  assert.equal((await remote.cosign(5n, proposal(5n))).decision.verdict, 'APPROVE')
})

test('malformed requests are 400, a broadcast that is not the signed tx is refused, unknown routes 404', async () => {
  assert.equal((await fetch(`${server.url}/cosign`, { method: 'POST', body: '{"intentId":"x"}' })).status, 400)
  assert.equal((await fetch(`${server.url}/cosign`, { method: 'POST', body: 'not json' })).status, 400)
  await assert.rejects(remote.recordBroadcast(5n, proposal(5n, 1_234)), /not the one the watcher signed/)
  assert.equal((await fetch(`${server.url}/keys`)).status, 404)
})

test('/health and /decisions are public, CORS on GET only, and carry no keys or signatures', async () => {
  const health = await fetch(`${server.url}/health`)
  assert.equal(health.headers.get('access-control-allow-origin'), '*')
  const h = (await health.json()) as Record<string, unknown>
  assert.equal(h.ok, true)
  const decisions = await (await fetch(`${server.url}/decisions`)).text()
  assert.doesNotMatch(decisions, /"signatures"|[0-9a-f]{140}/)
  assert.ok(JSON.parse(decisions).length >= 4)
  const post = await fetch(`${server.url}/cosign`, { method: 'POST', body: '{}' })
  assert.equal(post.headers.get('access-control-allow-origin'), null)
})

test('only one process may own the journal; a stale lock is taken over', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tg-lock-')), 'journal.json')
  const lock = lockJournal(file)
  assert.throws(() => lockJournal(file), /in use by process/)
  lock.release()
  writeFileSync(`${file}.lock`, '2147483646')
  const again = lockJournal(file)
  again.release()
})

test('a lost connection during cosign is a DENY that warns the watcher may still have signed', async () => {
  const lost = new RemoteWatcher('http://127.0.0.1:1', agent)
  const { decision, signatures } = await lost.cosign(7n, proposal(7n))
  assert.equal(signatures, undefined)
  assert.equal(decision.verdict, 'DENY')
  if (decision.verdict === 'DENY') assert.match(decision.reasons.join(' | '), /watcher unreachable: .*may still have signed: check http:\/\/127\.0\.0\.1:1\/decisions/)
})
