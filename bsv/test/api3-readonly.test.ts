// The API3 boundary: the ABI copy matches api3/src/client/abi.ts, the binding comes from
// api3/deployments.json, and (with LIVE_BASE=1) a real read of vault 5 on Base Sepolia.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Transaction } from '@bsv/sdk'
import { createIntentReader } from '../src/api3/intentReader'
import { loadBinding, settleTxidArg } from '../src/api3/policyTypes'
import { evaluateWithdrawal } from '../src/watcher/policy'
import { ABI_FILE, api3Abi } from '../scripts/sync-api3'

test('the ABI copy is exactly the entries of api3/src/client/abi.ts (run npm run sync:api3 on drift)', async () => {
  assert.deepEqual(JSON.parse(readFileSync(ABI_FILE, 'utf8')), JSON.parse(JSON.stringify(await api3Abi())))
})

test('the binding is vault 5 on the deployed contract; judge and retired vaults are excluded', () => {
  const b = loadBinding()
  assert.equal(b.chainId, 84532)
  assert.equal(b.contract, '0x8e38cc6B1Bd1f0D25357066cd0036f28fd1f7773')
  assert.equal(b.vaultId, 5n)
  for (const v of [6n, 7n, 1n, 2n, 3n, 4n]) assert.ok(b.excludedVaultIds.includes(v))
})

test('settle takes the WhatsOnChain txid as 0x + 64 hex', () => {
  const txid = 'ee2a38964df993af6cd48f5f51d1ce0c07c7bf454363735341288d7f71bf8e8c'
  assert.equal(settleTxidArg(txid), `0x${txid}`)
  assert.throws(() => settleTxidArg(`0x${txid}`))
  assert.throws(() => settleTxidArg(txid.toUpperCase()))
})

test('live Base Sepolia: vault 5 config, budget, and an unknown intent fails closed', { skip: process.env.LIVE_BASE !== '1' && 'set LIVE_BASE=1' }, async () => {
  const reader = createIntentReader({ binding: loadBinding(), rpcUrl: process.env.BASE_SEPOLIA_RPC })
  await reader.checkChain()
  const cfg = await reader.vaultConfig(5n)
  assert.equal(cfg.dailyBudgetUsd, 1_000_000n)
  assert.ok(Number(cfg.intentTtl) > 0)
  assert.ok((await reader.remainingUsdToday(5n)) <= 1_000_000n)
  await assert.rejects(reader.readIntent(10n ** 12n), /does not exist/)
})

test('live Base Sepolia: the one real intent so far (id 1, retired vault 2) is refused by the watcher', { skip: process.env.LIVE_BASE !== '1' && 'set LIVE_BASE=1' }, async () => {
  const binding = loadBinding()
  const intent = await createIntentReader({ binding, rpcUrl: process.env.BASE_SEPOLIA_RPC }).readIntent(1n)
  assert.equal(intent.vaultId, 2n)
  const decision = evaluateWithdrawal(
    {
      version: 'live-read', bsvNetwork: 'main',
      base: { chainId: binding.chainId, contract: binding.contract, vaultId: binding.vaultId, excludedVaultIds: binding.excludedVaultIds },
      vaultLockingScript: '51', floatLockingScript: '52', maxFeeSats: 200, expiryMarginSec: 60, minChangeSats: 1
    },
    { intent, tx: new Transaction(), ledger: 'new', vaultUtxos: new Map(), now: Math.floor(Date.now() / 1000) }
  )
  assert.equal(decision.verdict, 'DENY')
  if (decision.verdict === 'DENY') assert.ok(decision.reasons.some(r => /judge or retired/.test(r)))
})
