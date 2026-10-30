// The vault script, run through the SDK's script interpreter (Spend) with wallet-made signatures:
// agent+watcher spends, either alone does not, the owner alone does. Then the same script on the
// offline chain: the owner's wallet exits through createAction/signAction, and an abort frees coins.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Beef, P2PKH, PrivateKey, ProtoWallet, Script, Transaction } from '@bsv/sdk'
import { MockChain, type MockWallet } from '../src/chain/mockChain'
import { assembleCosigned, agentSignatures, proposeSpend, type VaultUtxo } from '../src/vault/proposeSpend'
import { ownerExitRaw, ownerExitThroughWallet, signOwnerExit } from '../src/vault/ownerExit'
import {
  cosignUnlockingScript,
  ownerUnlockingScript,
  parseVaultScript,
  signVaultInput,
  vaultLockingScript,
  vaultPublicKey,
  verifyInput,
  type VaultSigner
} from '../src/vault/template'

const KEY_ID = 'vault-5-v1'
const signer = (key = PrivateKey.fromRandom()): VaultSigner => ({ wallet: new ProtoWallet(key), keyID: KEY_ID })
const agent = signer()
const watcher = signer()
const owner = signer()
let vaultScript: string
let floatScript: string

/** A fake funding transaction paying `sats` into the vault, for interpreter-only checks. */
function fundedVault(sats: number): VaultUtxo {
  const source = new Transaction(1, [], [{ satoshis: sats, lockingScript: Script.fromHex(vaultScript) }], 0)
  return { outpoint: `${source.id('hex')}.0`, satoshis: sats, sourceTransaction: source }
}

before(async () => {
  vaultScript = vaultLockingScript({
    agent: await vaultPublicKey(agent),
    watcher: await vaultPublicKey(watcher),
    owner: await vaultPublicKey(owner)
  }).toHex()
  floatScript = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()).toHex()
})

test('the vault script round-trips and refuses duplicate keys', async () => {
  const keys = parseVaultScript(Script.fromHex(vaultScript))
  assert.equal(keys?.agent, await vaultPublicKey(agent))
  const k = await vaultPublicKey(agent)
  assert.throws(() => vaultLockingScript({ agent: k, watcher: k, owner: k }))
})

test('agent + watcher unlock the vault', async () => {
  const tx = proposeSpend({ utxos: [fundedVault(10_000)], vaultLockingScript: vaultScript, floatLockingScript: floatScript, amountSats: 3_000 })
  const signed = assembleCosigned(tx, await agentSignatures(agent, tx), await agentSignatures(watcher, tx))
  assert.equal(verifyInput(signed, 0).ok, true)
  assert.equal(signed.outputs[0].satoshis, 3_000)
  assert.equal(signed.outputs[1].lockingScript.toHex(), vaultScript)
  assert.equal(signed.getFee() > 0, true)
})

test('agent alone, watcher alone, swapped signatures and a stranger all fail', async () => {
  const tx = proposeSpend({ utxos: [fundedVault(10_000)], vaultLockingScript: vaultScript, floatLockingScript: floatScript, amountSats: 3_000 })
  const a = await signVaultInput(agent, tx, 0)
  const w = await signVaultInput(watcher, tx, 0)
  const s = await signVaultInput(signer(), tx, 0)
  const attempt = (unlock: ReturnType<typeof cosignUnlockingScript>): boolean => {
    tx.inputs[0].unlockingScript = unlock
    return verifyInput(tx, 0).ok
  }
  assert.equal(attempt(cosignUnlockingScript(a, a)), false, 'agent twice')
  assert.equal(attempt(cosignUnlockingScript(w, w)), false, 'watcher twice')
  assert.equal(attempt(cosignUnlockingScript(w, a)), false, 'swapped order')
  assert.equal(attempt(cosignUnlockingScript(a, s)), false, 'agent + stranger')
  assert.equal(attempt(ownerUnlockingScript(a)), false, 'agent on the owner branch')
  assert.equal(attempt(ownerUnlockingScript(w)), false, 'watcher on the owner branch')
  assert.equal(attempt(cosignUnlockingScript(a, w)), true, 'agent + watcher')
})

test('a cosigned spend is invalid once any output is changed after signing', async () => {
  const tx = proposeSpend({ utxos: [fundedVault(10_000)], vaultLockingScript: vaultScript, floatLockingScript: floatScript, amountSats: 3_000 })
  const signed = assembleCosigned(tx, await agentSignatures(agent, tx), await agentSignatures(watcher, tx))
  signed.outputs[0].satoshis! += 1_000
  signed.outputs[1].satoshis! -= 1_000
  assert.equal(verifyInput(signed, 0).ok, false)
})

test('the owner alone exits, with no agent or watcher involved', async () => {
  const dest = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()).toHex()
  const tx = await signOwnerExit(owner, ownerExitRaw([fundedVault(10_000), fundedVault(2_500)], dest))
  assert.equal(tx.inputs.every((_, i) => verifyInput(tx, i).ok), true)
  assert.equal(tx.outputs.length, 1)
  assert.equal(tx.outputs[0].satoshis, 12_500 - tx.getFee())
  // The agent's or watcher's key on the owner branch does not.
  await assert.rejects(signOwnerExit(agent, ownerExitRaw([fundedVault(10_000)], dest)))
  await assert.rejects(signOwnerExit(watcher, ownerExitRaw([fundedVault(10_000)], dest)))
})

// On the offline chain: real wallets, real broadcast (mock miner), the wallet's own coin handling.
let chain: MockChain
let ownerW: MockWallet

before(async () => {
  chain = await MockChain.create()
  ownerW = await chain.createWallet('owner', 30_000, 2)
})

after(async () => {
  await chain.destroy()
})

/** The owner deposits into a vault whose owner key is the owner's own wallet. */
async function depositToVault(sats: number) {
  const ownerSigner = { wallet: ownerW.wallet, keyID: KEY_ID }
  const script = vaultLockingScript({
    agent: await vaultPublicKey(agent),
    watcher: await vaultPublicKey(watcher),
    owner: await vaultPublicKey(ownerSigner)
  }).toHex()
  const res = await ownerW.wallet.createAction({
    description: 'Fund Treasury Guard vault',
    outputs: [{ lockingScript: script, satoshis: sats, outputDescription: 'vault deposit' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  const beef = Array.from(res.tx!)
  const tx = Transaction.fromAtomicBEEF(beef)
  return { utxo: { outpoint: `${res.txid}.0`, satoshis: sats, sourceTransaction: tx }, beef, script, ownerSigner }
}

test('mock chain: the owner wallet exits the vault through createAction/signAction and gets the sats back', async () => {
  const { utxo, beef, ownerSigner } = await depositToVault(5_000)
  const before = await ownerW.wallet.balance()
  const exit = await ownerExitThroughWallet(ownerSigner, [utxo], beef)
  assert.match(exit.txid, /^[0-9a-f]{64}$/)
  const after = await ownerW.wallet.balance()
  assert.equal(after, before + 5_000 - exit.tx.getFee())
})

test('mock chain: a failed owner signature aborts the action and frees the wallet coins', async () => {
  const { utxo, beef } = await depositToVault(4_000)
  const wrong = { wallet: ownerW.wallet, keyID: 'not-the-vault-key' }
  const before = await ownerW.wallet.balance()
  await assert.rejects(ownerExitThroughWallet(wrong, [utxo], beef))
  assert.equal(await ownerW.wallet.balance(), before, 'no coin stays reserved')
  // And the right key still gets out afterwards.
  const exit = await ownerExitThroughWallet({ wallet: ownerW.wallet, keyID: KEY_ID }, [utxo], beef)
  assert.match(exit.txid, /^[0-9a-f]{64}$/)
})

test('mock chain: agent + watcher withdraw to the float and the change stays in the vault', async () => {
  const { utxo, beef, script } = await depositToVault(6_000)
  const tx = proposeSpend({ utxos: [utxo], vaultLockingScript: script, floatLockingScript: floatScript, amountSats: 2_000 })
  const signed = assembleCosigned(tx, await agentSignatures(agent, tx), await agentSignatures(watcher, tx))
  const b = Beef.fromBinary(beef)
  b.mergeRawTx(signed.toBinary())
  const [posted] = await chain.services.postBeef(b, [signed.id('hex')])
  assert.equal(posted.status, 'success', JSON.stringify(posted))
  assert.equal(signed.outputs[1].lockingScript.toHex(), script)
  assert.equal(signed.outputs[1].satoshis, 6_000 - 2_000 - signed.getFee())
})
