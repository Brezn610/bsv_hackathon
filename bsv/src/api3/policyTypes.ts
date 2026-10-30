// The API3 side as the watcher sees it: which contract and vault it guards, and an intent read
// from Base with every number as a bigint. Values come from api3/deployments.json, never typed in.
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const KIND_SPEND = 0
export const KIND_SWAP = 1
export const DIRECTION_NONE = 0

export interface Api3Binding {
  network: 'baseSepolia'
  chainId: number
  contract: string
  /** The one Base vault whose SPEND intents may move BSV out of the vault. */
  vaultId: bigint
  /** Judge and retired vaults: real intents, never co-signed. */
  excludedVaultIds: bigint[]
  deployBlock: bigint
  explorer: string
}

export interface ConfirmedIntent {
  chainId: number
  contract: string
  intentId: bigint
  vaultId: bigint
  kind: number
  direction: number
  source: number
  maxSats: bigint
  maxBps: bigint
  minOut: bigint
  maxOut: bigint
  /** Unix seconds. */
  expiry: bigint
  price: bigint
  priceSignedAt: bigint
  settled: boolean
  bsvTxid: string
  /** The block the intent was read at: at least `minConfirmations` below the tip. */
  readAtBlock: bigint
  latestBlock: bigint
}

export const DEFAULT_DEPLOYMENTS = path.join(__dirname, '..', '..', '..', 'api3', 'deployments.json')

interface DeploymentsJson {
  baseSepolia?: {
    chainId: number
    explorer: string
    treasuryGuard: string | null
    vaultId: number | null
    judgeVaultId: number | null
    liveJudgeVaultId?: number | null
    retiredVaults?: Record<string, string>
    deployBlock: number | null
  }
}

export function loadBinding(file = process.env.API3_DEPLOYMENTS ?? DEFAULT_DEPLOYMENTS): Api3Binding {
  const d = (JSON.parse(readFileSync(file, 'utf8')) as DeploymentsJson).baseSepolia
  if (d === undefined) throw new Error(`${file} has no baseSepolia deployment`)
  if (d.chainId !== 84532) throw new Error(`baseSepolia.chainId is ${d.chainId}, expected 84532`)
  if (d.treasuryGuard === null || !/^0x[0-9a-fA-F]{40}$/.test(d.treasuryGuard)) throw new Error('baseSepolia.treasuryGuard is not an address')
  if (d.vaultId === null || d.deployBlock === null) throw new Error('baseSepolia.vaultId / deployBlock missing')
  const excluded = [d.judgeVaultId, d.liveJudgeVaultId, ...Object.keys(d.retiredVaults ?? {}).map(Number)]
    .filter((v): v is number => typeof v === 'number')
    .map(BigInt)
  const vaultId = BigInt(d.vaultId)
  if (excluded.includes(vaultId)) throw new Error(`Vault ${vaultId} is both the guarded vault and a judge/retired vault`)
  return {
    network: 'baseSepolia',
    chainId: d.chainId,
    contract: d.treasuryGuard,
    vaultId,
    excludedVaultIds: excluded,
    deployBlock: BigInt(d.deployBlock),
    explorer: d.explorer
  }
}

/** Formats a BSV txid the way TreasuryGuard.settle takes it: 0x + the 64 hex chars WhatsOnChain shows. */
export function settleTxidArg(bsvTxid: string): `0x${string}` {
  if (!/^[0-9a-f]{64}$/.test(bsvTxid)) throw new Error(`Not a BSV txid: ${bsvTxid}`)
  return `0x${bsvTxid}`
}
