// Treasury Guard on BSV mainnet. Base Sepolia (testnet) decides; BSV mainnet moves the money.
//
//   npm run tg -- watcher-key            create .env.watcher (watcher root key), print its public key
//   npm run tg -- float-key              create .env.float: the Agent Float's own wallet (income = vault withdrawals only)
//   npm run tg -- rebind-float           new binding version: same vault, Agent Float = the float wallet
//   npm run tg -- init                   derive agent / watcher / owner (BSV Desktop) vault keys, write data/vault-binding.json
//   npm run tg -- gate                   safety gate (1), offline: the EXACT mainnet script through the interpreter and the mock chain
//   npm run tg -- fund --sats N          CONFIRM_MAINNET=1; owner (BSV Desktop) funds the vault: N <= 5000 until the owner exit is proven, then <= 50000
//   npm run tg -- exit                   CONFIRM_MAINNET=1; owner-only exit of every live vault UTXO, through BSV Desktop
//   npm run tg -- watcher-serve          run the watcher as its own process on 127.0.0.1:4810 (--port, --init-journal)
//   npm run tg -- status                 binding, vault UTXOs (checked on chain), journal
//   npm run tg -- withdraw --intent N    CONFIRM_MAINNET=1; watcher checks intent N on Base and cosigns; agent broadcasts and takes it in
//   npm run tg -- buy                    CONFIRM_MAINNET=1; the agent's model decides, the float pays HTTP 402 (local demo merchant,
//                                        or an external service: --url <https url> --price <sats> --description <text> [--item <name>])
//
// Gate (2) is enforced here: no 'spend' funding before an owner exit has been proven on the same
// script, and nothing on mainnet without CONFIRM_MAINNET=1. Keys are never printed.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Beef, Hash, P2PKH, PrivateKey, ProtoWallet, Script, Transaction, Utils, WalletClient } from '@bsv/sdk'
import { decidePurchase, type PaidOffer } from '../src/agent/brain'
import { buyResearch } from '../src/agent/buyResearch'
import { floatLockingScript, internalizeWithdrawal } from '../src/agent/float'
import { createIntentReader } from '../src/api3/intentReader'
import { loadBinding, settleTxidArg } from '../src/api3/policyTypes'
import { MockChain } from '../src/chain/mockChain'
import { unspentByScript } from '../src/chain/wocUtxos'
import { openServerWallet, type ServerWallet } from '../src/chain/serverWallet'
import { config } from '../src/config'
import { DATA_DIR, loadEnv, RAIL_DIR, requireEnv, STATE_DIR, WATCHER_ENV_FILE } from '../src/env'
import { EventBus } from '../src/events'
import { runAutoCycle } from '../src/flow/autoCycle'
import { withdrawForIntent } from '../src/flow/withdraw'
import { Guardian } from '../src/guardian/guardian'
import { RESEARCH_PATH, startPaidApi } from '../src/merchant/paidApi'
import { ownerExitRaw, ownerExitThroughWallet, signOwnerExit } from '../src/vault/ownerExit'
import { agentSignatures, assembleCosigned, proposeSpend, receiptScript, type VaultUtxo } from '../src/vault/proposeSpend'
import {
  cosignUnlockingScript,
  ownerUnlockingScript,
  signVaultInput,
  vaultLockingScript,
  vaultPublicKey,
  verifyInput,
  type VaultSigner
} from '../src/vault/template'
import { evaluateWithdrawal, type VaultBinding } from '../src/watcher/policy'
import { lockJournal } from '../src/watcher/lock'
import { DEFAULT_WATCHER_URL, RemoteWatcher } from '../src/watcher/remoteWatcher'
import { startWatcherServer } from '../src/watcher/server'
import { Watcher } from '../src/watcher/service'
import { WatcherJournal } from '../src/watcher/state'
import { bindOriginator, createGuardedWallet } from '../src/wallet/agentWallet'

const OWNER_ORIGINATOR = process.env.OWNER_ORIGINATOR ?? 'owner.treasuryguard.dev'
const KEY_ID = process.env.VAULT_KEY_ID ?? 'vault-5-v1'
/** Until the owner exit is proven on this script, only a tiny deposit; afterwards still small (50,000 sats ≈ $0.009). */
const MAX_EXIT_PROOF_SATS = 5_000
const MAX_FUND_SATS = 50_000
const BINDING_FILE = path.join(STATE_DIR, 'vault-binding.json')
const UTXO_FILE = path.join(STATE_DIR, 'vault-utxos.json')
const GATE_FILE = path.join(STATE_DIR, 'gate1.json')
const JOURNAL_FILE = path.join(STATE_DIR, 'watcher-journal.json')
const EVIDENCE_DIR = path.join(STATE_DIR, 'evidence')
/** The Agent Float's own wallet: its only income is vault withdrawals, so what it pays is traceable to them. */
const FLOAT_ENV_FILE = path.join(RAIL_DIR, '.env.float')
const woc = (txid: string): string => `https://whatsonchain.com/tx/${txid}`

interface StoredBinding {
  version: string
  network: 'main'
  keyID: string
  ownerOriginator: string
  keys: { agent: string; watcher: string; owner: string }
  vaultLockingScript: string
  floatLockingScript: string
  base: { chainId: number; contract: string; vaultId: string; excludedVaultIds: string[] }
  maxFeeSats: number
  expiryMarginSec: number
  minChangeSats: number
  createdAt: string
}

interface StoredUtxo {
  outpoint: string
  satoshis: number
  /** Atomic BEEF of the transaction that created the output. */
  beef: string
  purpose: 'exit-proof' | 'spend' | 'change'
  status: 'live' | 'spent'
  spentBy?: string
  fundedAt: string
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T
const writeJson = (file: string, data: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
}
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const requireMainnetConfirm = (what: string): void => {
  if (process.env.CONFIRM_MAINNET !== '1') throw new Error(`${what} touches BSV mainnet. Rerun with CONFIRM_MAINNET=1 after the owner approved it.`)
}

function ownerSigner(): VaultSigner & { wallet: WalletClient } {
  return { wallet: new WalletClient('auto', OWNER_ORIGINATOR), keyID: KEY_ID, originator: OWNER_ORIGINATOR }
}

/** Reads one key from a key file of its own, without putting it into process.env. */
function readKeyFile(file: string, name: string, hint: string): string {
  if (!existsSync(file)) throw new Error(`No ${name}. Run: npm run tg -- ${hint}`)
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m !== null && m[1] === name) return m[2]
  }
  throw new Error(`${file} has no ${name}`)
}

function watcherSigner(): VaultSigner {
  return { wallet: new ProtoWallet(PrivateKey.fromHex(readKeyFile(WATCHER_ENV_FILE, 'WATCHER_ROOT_KEY_HEX', 'watcher-key'))), keyID: KEY_ID }
}

async function floatWallet(): Promise<ServerWallet> {
  return await openServerWallet('float', readKeyFile(FLOAT_ENV_FILE, 'FLOAT_ROOT_KEY_HEX', 'float-key'), STATE_DIR)
}

/** The wallet that owns the bound Agent Float script: the float wallet after rebind-float, the agent wallet before. */
async function floatOwner(stored: StoredBinding): Promise<ServerWallet> {
  if (existsSync(FLOAT_ENV_FILE)) {
    const f = await floatWallet()
    if ((await floatLockingScript(f.wallet)) === stored.floatLockingScript) return f
    await f.close()
  }
  const a = await agentWallet()
  if ((await floatLockingScript(a.wallet)) === stored.floatLockingScript) return a
  await a.close()
  throw new Error('Neither the float wallet nor the agent wallet owns the bound Agent Float script')
}

async function agentWallet(): Promise<ServerWallet> {
  loadEnv()
  return await openServerWallet('agent', requireEnv('AGENT_ROOT_KEY_HEX'), DATA_DIR)
}

function loadStoredBinding(): { stored: StoredBinding; binding: VaultBinding } {
  if (!existsSync(BINDING_FILE)) throw new Error('No vault binding. Run: npm run tg -- init')
  const stored = readJson<StoredBinding>(BINDING_FILE)
  if (vaultLockingScript(stored.keys).toHex() !== stored.vaultLockingScript) throw new Error('vault-binding.json: script does not match its keys')
  return {
    stored,
    binding: {
      version: stored.version,
      bsvNetwork: 'main',
      base: { chainId: stored.base.chainId, contract: stored.base.contract, vaultId: BigInt(stored.base.vaultId), excludedVaultIds: stored.base.excludedVaultIds.map(BigInt) },
      vaultLockingScript: stored.vaultLockingScript,
      floatLockingScript: stored.floatLockingScript,
      maxFeeSats: stored.maxFeeSats,
      expiryMarginSec: stored.expiryMarginSec,
      minChangeSats: stored.minChangeSats
    }
  }
}

const loadUtxos = (): StoredUtxo[] => (existsSync(UTXO_FILE) ? readJson<StoredUtxo[]>(UTXO_FILE) : [])
const toVaultUtxo = (u: StoredUtxo): VaultUtxo => ({
  outpoint: u.outpoint,
  satoshis: u.satoshis,
  sourceTransaction: Transaction.fromAtomicBEEF(Utils.toArray(u.beef, 'hex'))
})

async function watcherKey(): Promise<void> {
  if (existsSync(WATCHER_ENV_FILE)) {
    console.log(`Watcher key already exists in ${WATCHER_ENV_FILE}; vault key ${await vaultPublicKey(watcherSigner())}`)
    return
  }
  writeFileSync(WATCHER_ENV_FILE, `WATCHER_ROOT_KEY_HEX=${PrivateKey.fromRandom().toHex()}\n`, { mode: 0o600 })
  console.log(`Watcher key created in ${WATCHER_ENV_FILE} (mode 600). Vault key ${await vaultPublicKey(watcherSigner())}`)
  console.log('Never commit, paste or share that file.')
}

async function floatKey(): Promise<void> {
  if (!existsSync(FLOAT_ENV_FILE)) writeFileSync(FLOAT_ENV_FILE, `FLOAT_ROOT_KEY_HEX=${PrivateKey.fromRandom().toHex()}\n`, { mode: 0o600 })
  const f = await floatWallet()
  try {
    console.log(`Float wallet key in ${FLOAT_ENV_FILE} (mode 600). Identity ${f.identityKey}; Agent Float script ${await floatLockingScript(f.wallet)}`)
    console.log('Never commit, paste or share that file.')
  } finally {
    await f.close()
  }
}

/**
 * New binding version: the same vault script and keys, the Agent Float moved to the dedicated
 * float wallet, and the excluded-vault list refreshed from api3/deployments.json. Refused while
 * the journal holds a signature that was not broadcast. The previous version is kept on disk.
 */
async function rebindFloat(): Promise<void> {
  const { stored } = loadStoredBinding()
  if (existsSync(JOURNAL_FILE)) {
    const pending = Object.entries(readJson<{ records: Record<string, { status: string }> }>(JOURNAL_FILE).records).filter(([, r]) => r.status === 'reserved' || r.status === 'signed')
    if (pending.length > 0) throw new Error(`Journal has unbroadcast signatures (${pending.map(([k]) => k).join(', ')}); reconcile first`)
  }
  const f = await floatWallet()
  try {
    const base = loadBinding()
    const next: StoredBinding = {
      ...stored,
      version: `${stored.version}+float-wallet`,
      floatLockingScript: await floatLockingScript(f.wallet),
      base: { ...stored.base, excludedVaultIds: base.excludedVaultIds.map(String) },
      createdAt: new Date().toISOString()
    }
    writeJson(BINDING_FILE.replace(/\.json$/, `.${stored.version}.json`), stored)
    writeJson(BINDING_FILE, next)
    console.log(`Binding ${next.version}: vault script unchanged; Agent Float now ${next.floatLockingScript}; excluded vaults ${next.base.excludedVaultIds.join(', ')}`)
  } finally {
    await f.close()
  }
}

async function init(): Promise<void> {
  if (existsSync(BINDING_FILE) && !process.argv.includes('--force')) {
    throw new Error(`${BINDING_FILE} exists. The binding is fixed once funded; pass --force only for a new, unfunded version.`)
  }
  const base = loadBinding()
  const agent = await agentWallet()
  try {
    console.log(`Asking BSV Desktop (as ${OWNER_ORIGINATOR}) for the owner's derived vault key; approve the prompt...`)
    const keys = {
      agent: await vaultPublicKey({ wallet: agent.wallet, keyID: KEY_ID }),
      watcher: await vaultPublicKey(watcherSigner()),
      owner: await vaultPublicKey(ownerSigner())
    }
    const stored: StoredBinding = {
      version: `tg-vault-${KEY_ID}-${new Date().toISOString().slice(0, 10)}`,
      network: 'main',
      keyID: KEY_ID,
      ownerOriginator: OWNER_ORIGINATOR,
      keys,
      vaultLockingScript: vaultLockingScript(keys).toHex(),
      floatLockingScript: await floatLockingScript(agent.wallet),
      base: { chainId: base.chainId, contract: base.contract, vaultId: base.vaultId.toString(), excludedVaultIds: base.excludedVaultIds.map(String) },
      maxFeeSats: 200,
      expiryMarginSec: 60,
      minChangeSats: 1,
      createdAt: new Date().toISOString()
    }
    writeJson(BINDING_FILE, stored)
    console.log(`Binding written to ${BINDING_FILE}`)
    console.log(`  Base: chain ${base.chainId}, ${base.contract}, vault ${base.vaultId} (never ${base.excludedVaultIds.join(', ')})`)
    console.log(`  BSV vault script: ${stored.vaultLockingScript}`)
    console.log(`  Agent Float script: ${stored.floatLockingScript}`)
  } finally {
    await agent.close()
  }
}

/** Safety gate (1): the exact mainnet script, real key holders, no broadcast to mainnet. */
async function gate(): Promise<void> {
  const { stored, binding } = loadStoredBinding()
  const agent = await agentWallet()
  const results: Array<{ check: string; expected: string; ok: boolean; detail?: string }> = []
  const record = (check: string, expected: 'pass' | 'fail', actual: boolean, detail?: string): void => {
    results.push({ check, expected, ok: (expected === 'pass') === actual, detail })
    console.log(`  ${(expected === 'pass') === actual ? 'OK  ' : 'FAIL'} ${check}: expected ${expected}, got ${actual ? 'pass' : 'fail'}${detail ? ` (${detail})` : ''}`)
  }
  try {
    const agentS: VaultSigner = { wallet: agent.wallet, keyID: KEY_ID }
    const watcherS = watcherSigner()
    const ownerS = ownerSigner()
    console.log('Gate (1) on the exact mainnet vault script. BSV Desktop will ask to sign as the owner.')
    const derived = { agent: await vaultPublicKey(agentS), watcher: await vaultPublicKey(watcherS), owner: await vaultPublicKey(ownerS) }
    record('keys still derive to the bound script', 'pass', vaultLockingScript(derived).toHex() === stored.vaultLockingScript)

    // Interpreter: a synthetic funding transaction paying the exact script. Nothing is broadcast.
    const vault = Script.fromHex(stored.vaultLockingScript)
    const source = new Transaction(1, [], [{ satoshis: 5_000, lockingScript: vault }], 0)
    const utxo: VaultUtxo = { outpoint: `${source.id('hex')}.0`, satoshis: 5_000, sourceTransaction: source }
    const now = Math.floor(Date.now() / 1000)
    const intent = {
      chainId: binding.base.chainId, contract: binding.base.contract, intentId: 0n, vaultId: binding.base.vaultId, kind: 0, direction: 0, source: 0,
      maxSats: 3_000n, maxBps: 0n, minOut: 0n, maxOut: 0n, expiry: BigInt(now + 900), price: 0n, priceSignedAt: 0n, settled: false,
      bsvTxid: '0x', readAtBlock: 0n, latestBlock: 0n
    }
    const tx = proposeSpend({ utxos: [utxo], vaultLockingScript: stored.vaultLockingScript, floatLockingScript: stored.floatLockingScript, amountSats: 2_900, receiptScript: receiptScript(intent) })
    const a = await signVaultInput(agentS, tx, 0)
    const w = await signVaultInput(watcherS, tx, 0)
    const o = await signVaultInput(ownerS, tx, 0)
    const tryUnlock = (u: ReturnType<typeof ownerUnlockingScript>): { ok: boolean; error?: string } => {
      tx.inputs[0].unlockingScript = u
      return verifyInput(tx, 0)
    }
    record('agent + watcher spend', 'pass', tryUnlock(cosignUnlockingScript(a, w)).ok)
    record('agent only (agent signature twice)', 'fail', tryUnlock(cosignUnlockingScript(a, a)).ok)
    record('watcher only (watcher signature twice)', 'fail', tryUnlock(cosignUnlockingScript(w, w)).ok)
    record('agent on the owner branch', 'fail', tryUnlock(ownerUnlockingScript(a)).ok)
    record('watcher on the owner branch', 'fail', tryUnlock(ownerUnlockingScript(w)).ok)
    record('owner on the cosign branch', 'fail', tryUnlock(cosignUnlockingScript(o, w)).ok)
    record('change goes back to the same vault script', 'pass', tx.outputs[1]?.lockingScript.toHex() === stored.vaultLockingScript)
    const policy = evaluateWithdrawal(binding, { intent, tx, ledger: 'new', vaultUtxos: new Map([[utxo.outpoint, 5_000]]), now, expectedReceipt: receiptScript(intent) })
    record('watcher policy approves the in-bounds proposal', 'pass', policy.verdict === 'APPROVE', policy.verdict === 'DENY' ? policy.reasons.join('; ') : undefined)
    const exitDest = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()).toHex()
    const ownerOnly = await signOwnerExit(ownerS, ownerExitRaw([utxo], exitDest)).then(() => true, () => false)
    record('owner-only exit (interpreter)', 'pass', ownerOnly)

    // Mock chain: the same exact script funded, cosign-spent and owner-exited through a miner's checks.
    const chain = await MockChain.create()
    try {
      const funder = await chain.createWallet('funder', 20_000, 2)
      const dep = await funder.wallet.createAction({
        description: 'gate: fund exact script',
        outputs: [{ lockingScript: stored.vaultLockingScript, satoshis: 5_000, outputDescription: 'vault' }],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
      const depBeef = Array.from(dep.tx!)
      const mockUtxo: VaultUtxo = { outpoint: `${dep.txid}.0`, satoshis: 5_000, sourceTransaction: Transaction.fromAtomicBEEF(depBeef) }
      const spend = proposeSpend({ utxos: [mockUtxo], vaultLockingScript: stored.vaultLockingScript, floatLockingScript: stored.floatLockingScript, amountSats: 2_900 })
      const signed = assembleCosigned(spend, await agentSignatures(agentS, spend), await agentSignatures(watcherS, spend))
      const b1 = Beef.fromBinary(depBeef)
      b1.mergeRawTx(signed.toBinary())
      const [p1] = await chain.services.postBeef(b1, [signed.id('hex')])
      record('mock chain accepts agent + watcher spend', 'pass', p1.status === 'success', p1.status)
      const change: VaultUtxo = { outpoint: `${signed.id('hex')}.1`, satoshis: signed.outputs[1].satoshis!, sourceTransaction: signed }
      const exit = await signOwnerExit(ownerS, ownerExitRaw([change], exitDest))
      b1.mergeRawTx(exit.toBinary())
      const [p2] = await chain.services.postBeef(b1, [exit.id('hex')])
      record('mock chain accepts owner-only exit of the vault change', 'pass', p2.status === 'success', p2.status)
    } finally {
      await chain.destroy()
    }
  } finally {
    await agent.close()
  }
  const pass = results.every(r => r.ok)
  writeJson(GATE_FILE, { vaultLockingScript: stored.vaultLockingScript, pass, at: new Date().toISOString(), results })
  console.log(`\nGate (1): ${pass ? 'PASS' : 'FAIL'} (${GATE_FILE})`)
  if (!pass) {
    console.log('STOP: do not fund the custom vault. Use fallback 3.')
    process.exitCode = 1
  }
}

function requireGate1(script: string): void {
  if (!existsSync(GATE_FILE)) throw new Error('Gate (1) has not been run. Run: npm run tg -- gate')
  const g = readJson<{ vaultLockingScript: string; pass: boolean }>(GATE_FILE)
  if (!g.pass || g.vaultLockingScript !== script) throw new Error('Gate (1) did not pass for this exact script; the vault may not be funded')
}

async function fund(): Promise<void> {
  const sats = Number(arg('sats'))
  const { stored } = loadStoredBinding()
  requireGate1(stored.vaultLockingScript)
  const utxos = loadUtxos()
  const exitProven = existsSync(path.join(EVIDENCE_DIR, 'owner-exit.json'))
  const cap = exitProven ? MAX_FUND_SATS : MAX_EXIT_PROOF_SATS
  if (!Number.isSafeInteger(sats) || sats <= 0 || sats > cap) throw new Error(`--sats must be 1..${cap}${exitProven ? '' : ' until the owner exit is proven'}`)
  const purpose: StoredUtxo['purpose'] = exitProven ? 'spend' : 'exit-proof'
  if (purpose === 'exit-proof' && utxos.some(u => u.status === 'live')) throw new Error('Exit-proof funding is already live: run the owner exit first')
  requireMainnetConfirm(`Funding the vault with ${sats} sats`)
  console.log(`Owner (BSV Desktop) funds the vault with ${sats} sats for ${purpose === 'exit-proof' ? 'the owner-exit proof' : 'the agent+watcher spend'}. Approve the prompt...`)
  const owner = ownerSigner()
  const res = await owner.wallet.createAction(
    {
      description: `Treasury Guard vault deposit (${purpose})`,
      outputs: [{ lockingScript: stored.vaultLockingScript, satoshis: sats, outputDescription: 'Treasury Guard vault' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }
  )
  if (res.txid === undefined || res.tx === undefined) throw new Error('BSV Desktop did not return the funding transaction')
  const tx = Transaction.fromAtomicBEEF(Array.from(res.tx))
  const vout = tx.outputs.findIndex(o => o.lockingScript.toHex() === stored.vaultLockingScript)
  utxos.push({ outpoint: `${res.txid}.${vout}`, satoshis: sats, beef: Utils.toHex(Array.from(res.tx)), purpose, status: 'live', fundedAt: new Date().toISOString() })
  writeJson(UTXO_FILE, utxos)
  console.log(`Funded: ${woc(res.txid)} (output ${vout})`)
}

async function exit(): Promise<void> {
  const { stored } = loadStoredBinding()
  const live = loadUtxos().filter(u => u.status === 'live')
  if (live.length === 0) throw new Error('No live vault UTXO')
  requireMainnetConfirm('The owner exit')
  const owner = ownerSigner()
  const beef = new Beef()
  for (const u of live) beef.mergeBeef(Utils.toArray(u.beef, 'hex'))
  console.log(`Owner exits ${live.length} vault UTXO(s), ${live.reduce((s, u) => s + u.satoshis, 0)} sats, with BSV Desktop alone. Approve the prompts...`)
  const t0 = Date.now()
  const result = await ownerExitThroughWallet(owner, live.map(toVaultUtxo), Array.from(beef.toBinary()))
  const all = loadUtxos().map(u => (live.some(l => l.outpoint === u.outpoint) ? { ...u, status: 'spent' as const, spentBy: result.txid } : u))
  writeJson(UTXO_FILE, all)
  writeJson(path.join(EVIDENCE_DIR, 'owner-exit.json'), {
    txid: result.txid,
    url: woc(result.txid),
    vaultLockingScript: stored.vaultLockingScript,
    inputs: live.map(u => u.outpoint),
    fee: result.tx.getFee(),
    ms: Date.now() - t0,
    note: 'Owner key only (BSV Desktop). No agent, no watcher, no Base transaction. Broadcast state: as returned by BSV Desktop (0-conf until mined).',
    at: new Date().toISOString()
  })
  console.log(`Owner exit: ${woc(result.txid)}`)
}

async function status(): Promise<void> {
  const { stored } = loadStoredBinding()
  console.log(`Binding ${stored.version}: Base vault ${stored.base.vaultId} on ${stored.base.contract} (chain ${stored.base.chainId})`)
  console.log(`Vault script ${stored.vaultLockingScript}`)
  const onChain = await unspentByScript(stored.vaultLockingScript).catch((err: Error) => err)
  for (const u of loadUtxos()) {
    const chain = onChain instanceof Error ? `error ${onChain.message}` : onChain.has(u.outpoint) ? 'unspent' : 'spent'
    console.log(`  ${u.outpoint} ${u.satoshis} sats ${u.purpose} local=${u.status} chain=${chain}`)
  }
  const agent = await agentWallet()
  try {
    console.log(`Agent wallet balance: ${await agent.wallet.balance()} sats`)
  } finally {
    await agent.close()
  }
  if (existsSync(FLOAT_ENV_FILE)) {
    const f = await floatWallet()
    try {
      console.log(`Float wallet balance: ${await f.wallet.balance()} sats`)
    } finally {
      await f.close()
    }
  }
  if (existsSync(JOURNAL_FILE)) console.log(readFileSync(JOURNAL_FILE, 'utf8'))
}

async function withdraw(intentIdArg?: bigint): Promise<void> {
  const intentId = intentIdArg ?? BigInt(arg('intent') ?? NaN)
  const { stored, binding } = loadStoredBinding()
  requireGate1(stored.vaultLockingScript)
  if (!existsSync(path.join(EVIDENCE_DIR, 'owner-exit.json'))) throw new Error('Gate (2): the owner exit has not been proven on mainnet yet')
  const live = loadUtxos().filter(u => u.status === 'live')
  if (live.length === 0) throw new Error('No live vault UTXO; fund the vault first')
  // A signed withdrawal from an earlier run: never build a second proposal for this intent.
  const pendingFile = path.join(STATE_DIR, `pending-withdrawal-${intentId}.json`)
  if (existsSync(pendingFile)) {
    const pending = readJson<{ txid: string }>(pendingFile)
    throw new Error(
      `Intent ${intentId} already has a signed withdrawal ${woc(pending.txid)} (${pendingFile}). ` +
        'If it is on chain: record it at the watcher (POST /broadcast {intentId, tx} from that file), update the vault UTXOs, then delete the file. ' +
        'If it is not: re-broadcast that exact tx (its ancestryBeef is in the file). No new proposal is built for this intent.'
    )
  }
  requireMainnetConfirm(`Withdrawing for intent ${intentId}`)
  const reader = createIntentReader({ binding: loadBinding(), rpcUrl: process.env.BASE_SEPOLIA_RPC })
  const agent = await agentWallet()
  const agentSigner: VaultSigner = { wallet: agent.wallet, keyID: KEY_ID }
  // By default the watcher is its own process (tg watcher-serve) and this process never loads its
  // key. TG_INPROCESS_WATCHER=1 keeps the earlier in-process path as a fallback.
  const inProcess = process.env.TG_INPROCESS_WATCHER === '1'
  const lock = inProcess ? lockJournal(JOURNAL_FILE) : undefined
  try {
    let watcher: Pick<Watcher, 'cosign' | 'recordBroadcast'>
    if (inProcess) {
      watcher = new Watcher({
        binding,
        reader,
        journal: new WatcherJournal(JOURNAL_FILE),
        signer: watcherSigner(),
        // Independent check: each recorded vault UTXO must be unspent on chain right now.
        unspentVaultUtxos: async () => await unspentByScript(stored.vaultLockingScript)
      })
      console.log('Watcher: in-process (TG_INPROCESS_WATCHER=1)')
    } else {
      const remote = new RemoteWatcher(process.env.TG_WATCHER_URL ?? DEFAULT_WATCHER_URL, agentSigner)
      const health = await remote.health().catch((err: Error) => {
        throw new Error(`Watcher server not reachable (${err.message}). Start it with: npm run tg -- watcher-serve`)
      })
      if (health.binding !== stored.version) throw new Error(`Watcher server runs binding ${String(health.binding)}, this CLI has ${stored.version}`)
      watcher = remote
      console.log(`Watcher: separate process at ${process.env.TG_WATCHER_URL ?? DEFAULT_WATCHER_URL} (binding ${String(health.binding)})`)
    }
    // After a real broadcast, a failed record must not skip the bookkeeping below (UTXO file, float,
    // evidence). The journal then stays 'signed', which still blocks a second transaction.
    let recordError: Error | undefined
    const recording: Pick<Watcher, 'cosign' | 'recordBroadcast'> = {
      cosign: async (id, tx) => await watcher.cosign(id, tx),
      recordBroadcast: async (id, tx) => {
        for (const wait of [0, 1_000, 3_000]) {
          await new Promise(r => setTimeout(r, wait))
          try {
            await watcher.recordBroadcast(id, tx)
            recordError = undefined
            return
          } catch (err) {
            recordError = err as Error
          }
        }
      }
    }
    const t0 = Date.now()
    const intent = await reader.readIntent(intentId)
    console.log(`Intent ${intentId}: vault ${intent.vaultId}, kind ${intent.kind}, maxSats ${intent.maxSats}, expires ${new Date(Number(intent.expiry) * 1000).toISOString()}, read at block ${intent.readAtBlock}`)
    const ancestry = new Beef()
    for (const u of live) ancestry.mergeBeef(Utils.toArray(u.beef, 'hex'))
    const result = await withdrawForIntent({
      intent,
      agent: agentSigner,
      watcher: recording,
      utxos: live.map(toVaultUtxo),
      vaultLockingScript: stored.vaultLockingScript,
      floatLockingScript: stored.floatLockingScript,
      feeReserveSats: 100,
      broadcast: async tx => {
        const b = Beef.fromBinary(ancestry.toBinary())
        b.mergeRawTx(tx.toBinary())
        // Kept before the broadcast, so the signed transaction survives any later failure.
        writeJson(pendingFile, { intentId: intentId.toString(), txid: tx.id('hex'), tx: tx.toHex(), ancestryBeef: Utils.toHex(b.toBinary()), at: new Date().toISOString() })
        const results = await agent.services.postBeef(b, [tx.id('hex')])
        if (!results.some(r => r.status === 'success')) throw new Error(`Broadcast failed: ${JSON.stringify(results).slice(0, 400)}`)
      }
    })
    const broadcastMs = Date.now() - t0
    // Printed first, so a later bookkeeping error cannot hide them.
    console.log(`Broadcast ${woc(result.txid)}; for the API3 side (vault-5 agent key): settle(${intentId}, ${settleTxidArg(result.txid)})`)
    const utxos = loadUtxos().map(u => (live.some(l => l.outpoint === u.outpoint) ? { ...u, status: 'spent' as const, spentBy: result.txid } : u))
    const changeIndex = result.tx.outputs.findIndex(o => o.lockingScript.toHex() === stored.vaultLockingScript)
    if (changeIndex !== -1) {
      const b = Beef.fromBinary(ancestry.toBinary())
      b.mergeRawTx(result.tx.toBinary())
      utxos.push({ outpoint: `${result.txid}.${changeIndex}`, satoshis: result.tx.outputs[changeIndex].satoshis!, beef: Utils.toHex(Array.from(b.toBinaryAtomic(result.txid))), purpose: 'change', status: 'live', fundedAt: new Date().toISOString() })
    }
    writeJson(UTXO_FILE, utxos)
    const float = await floatOwner(stored)
    let floatBalance: number
    try {
      await internalizeWithdrawal(float.wallet, result.tx, Array.from(ancestry.toBinary()), stored.floatLockingScript)
      floatBalance = await float.wallet.balance()
    } finally {
      if (float !== agent) await float.close()
    }
    const receipt = {
      intentId: intentId.toString(),
      base: { chainId: binding.base.chainId, contract: binding.base.contract, vaultId: intent.vaultId.toString(), readAtBlock: intent.readAtBlock.toString(), maxSats: intent.maxSats.toString(), expiry: intent.expiry.toString() },
      bsvTxid: result.txid,
      url: woc(result.txid),
      settleArg: settleTxidArg(result.txid),
      toFloatSats: result.amountSats,
      feeSats: result.fee,
      vaultOutflowSats: result.amountSats + result.fee,
      decision: result.decision,
      msIntentReadToBroadcast: broadcastMs,
      state: 'broadcast (0-conf); not yet checked for a block',
      at: new Date().toISOString()
    }
    writeJson(path.join(EVIDENCE_DIR, `withdrawal-intent-${intentId}.json`), receipt)
    console.log(`Withdrawal broadcast: ${woc(result.txid)}`)
    console.log(`  ${result.amountSats} sats to the Agent Float, fee ${result.fee}; float wallet balance ${floatBalance}`)
    if (recordError !== undefined) {
      console.error(`\nWARNING: the watcher did not record broadcast ${result.txid} (${recordError.message}).`)
      console.error(`  The withdrawal is broadcast and booked locally; the journal still says 'signed'. Kept ${pendingFile}; retry: POST /broadcast {intentId, tx}.`)
      process.exitCode = 1
    } else {
      unlinkSync(pendingFile)
    }
  } finally {
    lock?.release()
    await agent.close()
  }
}

const AUTO_STATE_FILE = path.join(STATE_DIR, 'auto-state.json')
const AUTO_LOG_FILE = path.join(STATE_DIR, 'auto-cycle.jsonl')

/**
 * Unattended BSV half of the cycle (src/flow/autoCycle.ts): every new SPEND intent of the guarded
 * vault goes through exactly the `tg withdraw` path over the separate watcher, then optionally
 * `tg buy` (which reads --url/--price/--description/--item/--task from the same command line).
 */
async function auto(): Promise<void> {
  requireMainnetConfirm('The automatic withdrawal loop')
  // The same environment withdraw() will see, before any of it is checked or used.
  loadEnv()
  if (process.env.TG_INPROCESS_WATCHER === '1') throw new Error('tg auto only runs against the separate watcher (tg watcher-serve); unset TG_INPROCESS_WATCHER')
  const { binding } = loadStoredBinding()
  const withBuy = process.argv.includes('--buy')
  const maxIntents = Number(arg('max-intents') ?? 5)
  if (!Number.isSafeInteger(maxIntents) || maxIntents <= 0) throw new Error('--max-intents must be a positive integer')
  const maxSats = Number(arg('max-sats') ?? 15_000)
  if (!Number.isSafeInteger(maxSats) || maxSats <= 0) throw new Error('--max-sats must be a positive integer')
  if (withBuy && arg('url') !== undefined && arg('description') === undefined) throw new Error('--description is required with --url')
  const fromArg = arg('from-block')
  const stop = { requested: false }
  process.once('SIGINT', () => {
    stop.requested = true
    console.log('[auto] stopping after the current step')
  })
  const pendingFile = (id: bigint): string => path.join(STATE_DIR, `pending-withdrawal-${id}.json`)
  await runAutoCycle({
    reader: createIntentReader({ binding: loadBinding(), rpcUrl: process.env.BASE_SEPOLIA_RPC }),
    vaultId: binding.base.vaultId,
    withdraw: async id => {
      await withdraw(id)
      // An unrecorded broadcast is logged by the loop as done-unrecorded; it must not end the run.
      process.exitCode = undefined
    },
    receipt: id => readJson<{ bsvTxid: string; vaultOutflowSats: number }>(path.join(EVIDENCE_DIR, `withdrawal-intent-${id}.json`)),
    hasPending: id => existsSync(pendingFile(id)),
    buy: withBuy ? buy : undefined,
    stateFile: AUTO_STATE_FILE,
    logFile: AUTO_LOG_FILE,
    maxIntents,
    maxSats,
    fromBlock: fromArg === undefined ? undefined : BigInt(fromArg),
    stop
  })
}

/**
 * The watcher as its own process. Refuses to start unless: the journal exists (or --init-journal),
 * this process alone owns it, the binding matches api3/deployments.json, the watcher key matches
 * the vault script, Base Sepolia answers on the right chain, and the clock is within 20 s of Base.
 */
async function watcherServe(): Promise<void> {
  const { stored, binding } = loadStoredBinding()
  if (!existsSync(JOURNAL_FILE) && !process.argv.includes('--init-journal')) {
    throw new Error(`No watcher journal at ${JOURNAL_FILE}. Restore it from a backup, or pass --init-journal for a new, empty one`)
  }
  const deployed = loadBinding()
  if (deployed.chainId !== binding.base.chainId || deployed.contract.toLowerCase() !== binding.base.contract.toLowerCase() || deployed.vaultId !== binding.base.vaultId) {
    throw new Error('vault-binding.json does not match api3/deployments.json (chain, contract or vault)')
  }
  const missing = deployed.excludedVaultIds.filter(v => !binding.base.excludedVaultIds.includes(v))
  if (missing.length > 0) throw new Error(`The binding does not exclude vault(s) ${missing.join(', ')} named in deployments.json; run tg rebind-float`)
  const signer = watcherSigner()
  if ((await vaultPublicKey(signer)) !== stored.keys.watcher) throw new Error('The watcher key in .env.watcher does not match the vault script')
  const reader = createIntentReader({ binding: deployed, rpcUrl: process.env.BASE_SEPOLIA_RPC })
  await reader.checkChain()
  const skew = Math.floor(Date.now() / 1000) - (await reader.latestBlockTime())
  if (Math.abs(skew) > 20) throw new Error(`The local clock is ${skew} s off the latest Base block; fix the clock first`)
  const lock = lockJournal(JOURNAL_FILE)
  const watcher = new Watcher({
    binding,
    reader,
    journal: new WatcherJournal(JOURNAL_FILE),
    signer,
    unspentVaultUtxos: async () => await unspentByScript(stored.vaultLockingScript)
  })
  const running = await startWatcherServer({
    watcher,
    agentKey: stored.keys.agent,
    info: {
      binding: stored.version,
      bsvNetwork: 'main',
      base: { chainId: binding.base.chainId, contract: binding.base.contract, vaultId: binding.base.vaultId.toString(), excludedVaultIds: binding.base.excludedVaultIds.map(String) },
      vaultScriptSha256: Utils.toHex(Hash.sha256(Utils.toArray(stored.vaultLockingScript, 'hex'))),
      watcherKey: stored.keys.watcher,
      agentKey: stored.keys.agent,
      clockSkewSec: skew
    },
    decisionsFile: path.join(STATE_DIR, 'watcher-decisions.jsonl'),
    port: Number(arg('port') ?? 4810)
  })
  console.log(`Watcher listening on ${running.url} (binding ${stored.version}, clock skew ${skew} s). Ctrl+C to stop.`)
  const stop = async (): Promise<void> => {
    await running.close()
    lock.release()
    process.exit(0)
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
}

/** Txids of the vault withdrawals recorded in the evidence folder. */
function withdrawalTxids(): Set<string> {
  if (!existsSync(EVIDENCE_DIR)) return new Set()
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  return new Set(
    readdirSync(EVIDENCE_DIR)
      .filter(f => f.startsWith('withdrawal-intent-'))
      .map(f => readJson<{ bsvTxid: string }>(path.join(EVIDENCE_DIR, f)).bsvTxid)
  )
}

/** The txids a mainnet transaction spends from, as WhatsOnChain reports them (retries while it indexes). */
async function inputTxids(txid: string): Promise<string[] | undefined> {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid}`, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined)
    if (res?.ok === true) return ((await res.json()) as { vin: Array<{ txid: string }> }).vin.map(v => v.txid)
    await new Promise(r => setTimeout(r, 2_000))
  }
  return undefined
}

async function buy(): Promise<void> {
  requireMainnetConfirm('The HTTP 402 purchase')
  loadEnv()
  // Model keys (DEEPSEEK_API_KEY or ANTHROPIC_API_KEY) live in their own gitignored file.
  const llmEnv = path.join(RAIL_DIR, '.env.llm')
  if (existsSync(llmEnv)) process.loadEnvFile(llmEnv)
  const task = arg('task') ?? 'Write a short note for the treasury owner on what BSV network fees look like for agent micropayments today.'
  // An external 402 service (e.g. a teammate's Analyst): --url, --price, --description, optionally --item.
  // Without --url, the local demo merchant is started and paid.
  const externalUrl = arg('url')
  const price = Number(arg('price') ?? process.env.RESEARCH_PRICE_SATS ?? 1_000)
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error('--price must be a positive whole number of sats')
  if (externalUrl !== undefined && arg('description') === undefined) throw new Error('--description is required with --url: the agent model judges the offer by it')
  const { stored } = loadStoredBinding()
  const payer = await floatOwner(stored)
  const merchant = externalUrl === undefined ? await openServerWallet('merchant', requireEnv('MERCHANT_ROOT_KEY_HEX'), DATA_DIR) : undefined
  const api = merchant === undefined ? undefined : await startPaidApi(merchant.wallet, { priceSats: price })
  const url = externalUrl ?? `${api!.baseUrl}${RESEARCH_PATH}?topic=bsv-fees`
  // The guardian allowlists the merchant by host name; an external service is identified by its URL's host.
  const domain = externalUrl === undefined ? 'research.treasuryguard.dev' : new URL(externalUrl).hostname
  const limits = { maxPerPaymentSats: 2_000, dailyBudgetSats: 10_000, reserveSats: 0 }
  try {
    const floatSats = await payer.wallet.balance()
    const offer: PaidOffer = externalUrl === undefined
      ? { merchant: domain, item: 'research note: bsv-fees', description: 'One short paid research note on the topic "BSV network fees for agent micropayments", from the team demo merchant (deterministic demo content)', priceSats: price }
      : { merchant: domain, item: arg('item') ?? 'paid API call', description: arg('description')!, priceSats: price }
    const decision = await decidePurchase(offer, { task, floatSats, maxPerPaymentSats: limits.maxPerPaymentSats })
    console.log(`Agent (${decision.decidedBy}): ${decision.buy ? 'BUY' : 'SKIP'} - ${decision.reason}`)
    if (!decision.buy) {
      writeJson(path.join(EVIDENCE_DIR, `http402-${Date.now()}.json`), { task, offer, decision, paid: false, at: new Date().toISOString() })
      return
    }
    const guarded = createGuardedWallet(payer.wallet)
    const guardian = new Guardian({
      manager: guarded,
      wallet: payer.wallet,
      events: new EventBus(),
      limits,
      issueAllowances: false,
      merchants: [{ domain, label: externalUrl === undefined ? 'Treasury Guard research API (local demo merchant)' : `External 402 service at ${domain}`, trust: 'trusted' }],
      useClaude: config.claude.enabled
    })
    guardian.start()
    await guardian.declareIntent({ merchant: domain, item: offer.item, why: decision.reason, expectedSats: price, source: 'self' })
    const merchantBefore = merchant === undefined ? undefined : await merchant.wallet.balance()
    const t0 = Date.now()
    const bought = await buyResearch(bindOriginator(guarded, domain), url).finally(() => guardian.clearIntent(domain))
    const ms = Date.now() - t0
    const inputs = bought.paymentTxid === undefined ? undefined : await inputTxids(bought.paymentTxid)
    const fundedBy = inputs?.filter(t => withdrawalTxids().has(t)) ?? []
    const evidence = {
      task,
      decision,
      payer: payer.name,
      status: bought.status,
      paymentTxid: bought.paymentTxid,
      url: bought.paymentTxid === undefined ? undefined : woc(bought.paymentTxid),
      priceSats: price,
      merchant: externalUrl === undefined ? 'local demo merchant' : url,
      merchantReceivedSats: merchant === undefined || merchantBefore === undefined ? 'external merchant: see the payment output on WhatsOnChain' : (await merchant.wallet.balance()) - merchantBefore,
      guardian: guardian.journal.at(-1)?.verdict,
      paymentInputsFrom: inputs ?? 'not yet indexed by WhatsOnChain',
      fundedByVaultWithdrawal: fundedBy,
      body: bought.body,
      msRequestToAnswer: ms,
      note: externalUrl === undefined ? 'Local demo merchant (localhost); the payment itself is a real BSV mainnet transaction.' : 'External 402 service; the payment is a real BSV mainnet transaction.',
      at: new Date().toISOString()
    }
    writeJson(path.join(EVIDENCE_DIR, `http402-${Date.now()}.json`), evidence)
    console.log(`HTTP ${bought.status}; payment ${evidence.url ?? 'none'}; merchant ${typeof evidence.merchantReceivedSats === 'number' ? `+${evidence.merchantReceivedSats} sats` : '(external)'}`)
    console.log(fundedBy.length > 0 ? `  Paid from vault withdrawal ${fundedBy.join(', ')}` : `  Payment inputs: ${JSON.stringify(inputs ?? 'unknown')}`)
  } finally {
    await api?.close()
    await payer.close()
    await merchant?.close()
  }
}

const commands: Record<string, () => Promise<void>> = { 'watcher-key': watcherKey, 'float-key': floatKey, 'rebind-float': rebindFloat, 'watcher-serve': watcherServe, init, gate, fund, exit, status, withdraw, buy, auto }

const command = commands[process.argv[2] ?? '']
if (command === undefined) {
  console.log(`Commands: ${Object.keys(commands).join(', ')}`)
  process.exitCode = 1
} else {
  command().catch(err => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}

