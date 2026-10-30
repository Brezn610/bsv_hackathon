// The watcher against fixture intents (shape and numbers as getIntent returns them on Base
// Sepolia; see test/api3-readonly.test.ts for the live read). Every refusal happens before the
// watcher signs, and the journal makes one intent good for one transaction, across restarts.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { before, test } from 'node:test'
import { LockingScript, P2PKH, PrivateKey, ProtoWallet, Script, Transaction } from '@bsv/sdk'
import type { ConfirmedIntent } from '../src/api3/policyTypes'
import { agentSignatures, assembleCosigned, proposeSpend, receiptScript, type VaultUtxo } from '../src/vault/proposeSpend'
import { ownerExitRaw, signOwnerExit } from '../src/vault/ownerExit'
import { vaultLockingScript, vaultPublicKey, verifyInput, type VaultSigner } from '../src/vault/template'
import type { VaultBinding } from '../src/watcher/policy'
import { Watcher } from '../src/watcher/service'
import { WatcherJournal } from '../src/watcher/state'

const CONTRACT = '0x8e38cc6B1Bd1f0D25357066cd0036f28fd1f7773'
const signer = (): VaultSigner => ({ wallet: new ProtoWallet(PrivateKey.fromRandom()), keyID: 'vault-5-v1' })
const agent = signer()
const watcherKey = signer()
const owner = signer()
const NOW = 1_793_000_000
let binding: VaultBinding
let utxo: VaultUtxo
let unspent: Map<string, number>

function intent(id: bigint, over: Partial<ConfirmedIntent> = {}): ConfirmedIntent {
  return {
    chainId: 84532,
    contract: CONTRACT,
    intentId: id,
    vaultId: 5n,
    kind: 0,
    direction: 0,
    source: 0,
    maxSats: 5_000n,
    maxBps: 0n,
    minOut: 0n,
    maxOut: 0n,
    expiry: BigInt(NOW + 900),
    price: 2_000_000_000n,
    priceSignedAt: BigInt(NOW - 30),
    settled: false,
    bsvTxid: '0x' + '00'.repeat(32),
    readAtBlock: 100n,
    latestBlock: 101n,
    ...over
  }
}

function newWatcher(intents: Map<bigint, ConfirmedIntent>, journalFile = path.join(mkdtempSync(path.join(tmpdir(), 'tg-')), 'journal.json')) {
  const journal = new WatcherJournal(journalFile)
  const watcher = new Watcher({
    binding,
    journal,
    signer: watcherKey,
    reader: {
      readIntent: async id => {
        const found = intents.get(id)
        if (found === undefined) throw new Error(`intent ${id} not found`)
        return found
      }
    },
    unspentVaultUtxos: async () => new Map(unspent),
    now: () => NOW * 1000
  })
  return { watcher, journal, journalFile }
}

const receipt = (id: bigint): string => receiptScript({ chainId: 84532, contract: CONTRACT, vaultId: 5n, intentId: id })
const proposal = (id: bigint, amountSats = 3_000, extra: Partial<Parameters<typeof proposeSpend>[0]> = {}): Transaction =>
  proposeSpend({ utxos: [utxo], vaultLockingScript: binding.vaultLockingScript, floatLockingScript: binding.floatLockingScript, amountSats, receiptScript: receipt(id), ...extra })

before(async () => {
  const vault = vaultLockingScript({ agent: await vaultPublicKey(agent), watcher: await vaultPublicKey(watcherKey), owner: await vaultPublicKey(owner) }).toHex()
  binding = {
    version: 'test-1',
    bsvNetwork: 'mock',
    base: { chainId: 84532, contract: CONTRACT, vaultId: 5n, excludedVaultIds: [6n, 7n, 1n, 2n, 3n, 4n] },
    vaultLockingScript: vault,
    floatLockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()).toHex(),
    maxFeeSats: 200,
    expiryMarginSec: 60,
    minChangeSats: 1
  }
  const source = new Transaction(1, [], [{ satoshis: 10_000, lockingScript: Script.fromHex(vault) }], 0)
  utxo = { outpoint: `${source.id('hex')}.0`, satoshis: 10_000, sourceTransaction: source }
  unspent = new Map([[utxo.outpoint, 10_000]])
})

const denied = async (watcher: Watcher, id: bigint, tx: Transaction, pattern: RegExp): Promise<void> => {
  const { decision, signatures } = await watcher.cosign(id, tx)
  assert.equal(decision.verdict, 'DENY')
  assert.equal(signatures, undefined)
  if (decision.verdict === 'DENY') assert.ok(decision.reasons.some(r => pattern.test(r)), decision.reasons.join(' | '))
}

test('a withdrawal within maxSats, change back to the vault, is approved and cosigned', async () => {
  const { watcher, journal } = newWatcher(new Map([[1n, intent(1n)]]))
  const tx = proposal(1n)
  const { decision, signatures } = await watcher.cosign(1n, tx)
  assert.equal(decision.verdict, 'APPROVE')
  const signed = assembleCosigned(tx, await agentSignatures(agent, tx), signatures!)
  assert.equal(verifyInput(signed, 0).ok, true)
  if (decision.verdict === 'APPROVE') {
    assert.equal(decision.toFloat, 3_000)
    assert.equal(decision.vaultIn - decision.change, 3_000 + decision.fee)
  }
  await watcher.recordBroadcast(1n, signed)
  assert.equal(journal.get('84532:' + CONTRACT.toLowerCase() + ':5:1')?.status, 'broadcast')
})

test('the same intent is never cosigned twice, also after a restart', async () => {
  const intents = new Map([[2n, intent(2n)]])
  const { watcher, journalFile } = newWatcher(intents)
  assert.equal((await watcher.cosign(2n, proposal(2n))).decision.verdict, 'APPROVE')
  await denied(watcher, 2n, proposal(2n, 2_000), /journal already holds this intent as signed/)
  // A fresh process on the same journal (crash after signing, before broadcast).
  const restarted = newWatcher(intents, journalFile).watcher
  await denied(restarted, 2n, proposal(2n, 1_000), /journal already holds/)
})

test('a vault UTXO claimed by one intent is not offered to the next', async () => {
  const intents = new Map([[3n, intent(3n)], [4n, intent(4n)]])
  const { watcher } = newWatcher(intents)
  assert.equal((await watcher.cosign(3n, proposal(3n))).decision.verdict, 'APPROVE')
  await denied(watcher, 4n, proposal(4n), /not in the watcher's unspent vault set/)
})

test('a corrupted journal stops the watcher', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tg-')), 'journal.json')
  writeFileSync(file, JSON.stringify({ version: 1, records: { x: { status: 'signed' } }, checksum: 'bad' }))
  assert.throws(() => new WatcherJournal(file), /checksum/)
  writeFileSync(file, '{not json')
  assert.throws(() => new WatcherJournal(file), /unreadable/)
})

test('overspend: vault outflow including the fee above maxSats is denied', async () => {
  const { watcher } = newWatcher(new Map([[10n, intent(10n, { maxSats: 3_000n })]]))
  // 3000 to the float fits on its own, but the fee is paid by the vault too.
  await denied(watcher, 10n, proposal(10n, 3_000), /exceeds intent maxSats 3000/)
})

test('wrong recipient: paying anything but the registered Agent Float is denied', async () => {
  const { watcher } = newWatcher(new Map([[11n, intent(11n)]]))
  const thief = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()).toHex()
  await denied(watcher, 11n, proposal(11n, 3_000, { floatLockingScript: thief }), /unauthorised script|exactly one Agent Float/)
})

test('change leakage: an extra payee, or the change sent to the agent, is denied', async () => {
  const { watcher } = newWatcher(new Map([[12n, intent(12n)]]))
  const extra = proposal(12n, 2_000)
  extra.outputs[1].satoshis! -= 500
  extra.addOutput({ satoshis: 500, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()) })
  await denied(watcher, 12n, extra, /unauthorised script/)

  const toFloat = proposal(12n, 2_000)
  toFloat.outputs[1].lockingScript = LockingScript.fromHex(binding.floatLockingScript)
  await denied(watcher, 12n, toFloat, /exactly one Agent Float output, found 2/)
})

test('a fee above the cap is denied even within maxSats', async () => {
  const { watcher } = newWatcher(new Map([[13n, intent(13n, { maxSats: 9_000n })]]))
  const tx = proposal(13n, 2_000)
  tx.outputs[1].satoshis! -= 500
  await denied(watcher, 13n, tx, /above the 200 sat cap/)
})

test('expired, settled and SWAP intents are denied', async () => {
  const { watcher } = newWatcher(
    new Map([
      [20n, intent(20n, { expiry: BigInt(NOW - 1) })],
      [21n, intent(21n, { expiry: BigInt(NOW + 30) })],
      [22n, intent(22n, { settled: true })],
      [23n, intent(23n, { kind: 1, direction: 1, maxSats: 0n, maxBps: 2_500n })]
    ])
  )
  await denied(watcher, 20n, proposal(20n), /expires at/)
  await denied(watcher, 21n, proposal(21n), /expires at/) // inside the signing margin
  await denied(watcher, 22n, proposal(22n), /already settled/)
  await denied(watcher, 23n, proposal(23n), /not SPEND/)
})

test('wrong network, contract or vault (judge vaults 6 and 7 included) are denied', async () => {
  const { watcher } = newWatcher(
    new Map([
      [30n, intent(30n, { chainId: 8453 })],
      [31n, intent(31n, { contract: '0x0000000000000000000000000000000000000001' })],
      [32n, intent(32n, { vaultId: 6n })],
      [33n, intent(33n, { vaultId: 7n })],
      [34n, intent(34n, { vaultId: 9n })]
    ])
  )
  await denied(watcher, 30n, proposal(30n), /chain 8453/)
  await denied(watcher, 31n, proposal(31n), /not the bound contract/)
  await denied(watcher, 32n, proposal(32n), /judge or retired/)
  await denied(watcher, 33n, proposal(33n), /judge or retired/)
  await denied(watcher, 34n, proposal(34n), /not the bound vault/)
})

test('a missing or forged receipt, an unknown intent and an RPC failure are denied', async () => {
  const { watcher } = newWatcher(new Map([[40n, intent(40n)], [41n, intent(41n)]]))
  await denied(watcher, 40n, proposeSpend({ utxos: [utxo], vaultLockingScript: binding.vaultLockingScript, floatLockingScript: binding.floatLockingScript, amountSats: 3_000 }), /receipt output is missing/)
  await denied(watcher, 41n, proposal(40n), /not the expected receipt/)
  await denied(watcher, 99n, proposal(99n), /independent verification failed: intent 99 not found/)
})

test('a UTXO that is not the bound vault script is denied', async () => {
  const { watcher } = newWatcher(new Map([[50n, intent(50n)]]))
  const other = new Transaction(1, [], [{ satoshis: 10_000, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()) }], 0)
  const tx = proposal(50n)
  tx.inputs[0].sourceTransaction = other
  tx.inputs[0].sourceTXID = other.id('hex')
  await denied(watcher, 50n, tx, /not a vault UTXO/)
})

test('with the watcher offline, the owner still exits alone', async () => {
  const dest = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()).toHex()
  const exit = await signOwnerExit(owner, ownerExitRaw([utxo], dest))
  assert.equal(verifyInput(exit, 0).ok, true)
})
