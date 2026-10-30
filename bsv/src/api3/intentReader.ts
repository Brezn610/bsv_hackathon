// Read-only access to TreasuryGuard on Base Sepolia. No private key is ever passed here: the
// watcher only reads. The intent is read at a block `minConfirmations` below the tip, so an
// intent that only exists in the newest block (which could still be reorganised) is not seen yet.
// Any RPC error, chain mismatch or missing intent throws: the caller fails closed.
import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem'
import abiJson from './treasuryGuard.abi.json'
import type { Api3Binding, ConfirmedIntent } from './policyTypes'

export const treasuryGuardAbi = abiJson as Abi

export const DEFAULT_BASE_SEPOLIA_RPC = 'https://sepolia.base.org'

interface RawIntent {
  vaultId: bigint
  kind: number
  direction: number
  source: number
  maxSats: bigint
  maxBps: bigint
  minOut: bigint
  maxOut: bigint
  expiry: bigint
  price: bigint
  priceSignedAt: bigint
  settled: boolean
  bsvTxid: string
}

export interface IntentReader {
  binding: Api3Binding
  checkChain: () => Promise<void>
  latestBlock: () => Promise<bigint>
  /** Unix seconds of the latest block: the watcher compares it with its own clock. */
  latestBlockTime: () => Promise<number>
  readIntent: (intentId: bigint) => Promise<ConfirmedIntent>
  vaultConfig: (vaultId: bigint) => Promise<Record<string, unknown>>
  remainingUsdToday: (vaultId: bigint) => Promise<bigint>
  /** The last signed BSV/USD price the vault accepted (8 decimals) and when it was signed. */
  lastPrice: (vaultId: bigint) => Promise<{ price: bigint; change1h: bigint; updatedAt: bigint; signedAt: bigint }>
  /** IntentCreated logs of `vaultId` (default: the guarded vault) in [fromBlock, toBlock]. */
  intentEvents: (fromBlock: bigint, toBlock?: bigint, vaultId?: bigint) => Promise<Array<{ intentId: bigint; vaultId: bigint; kind: number; blockNumber: bigint; txHash: string }>>
}

export function createIntentReader(opts: { binding: Api3Binding; rpcUrl?: string; minConfirmations?: bigint; client?: PublicClient }): IntentReader {
  const { binding } = opts
  const client = opts.client ?? (createPublicClient({ transport: http(opts.rpcUrl ?? DEFAULT_BASE_SEPOLIA_RPC) }) as PublicClient)
  const contract = { address: binding.contract as Address, abi: treasuryGuardAbi } as const
  const minConfirmations = opts.minConfirmations ?? 1n

  let chainChecked: Promise<void> | undefined
  const checkChain = async (): Promise<void> =>
    await (chainChecked ??= client.getChainId().then(id => {
      if (id !== binding.chainId) throw new Error(`RPC serves chain ${id}, binding is for ${binding.chainId}`)
    }))

  return {
    binding,
    checkChain,
    latestBlock: async () => await client.getBlockNumber(),
    latestBlockTime: async () => Number((await client.getBlock({ blockTag: 'latest' })).timestamp),
    async readIntent(intentId) {
      await checkChain()
      const latestBlock = await client.getBlockNumber()
      const readAtBlock = latestBlock - minConfirmations
      const raw = (await client.readContract({ ...contract, functionName: 'getIntent', args: [intentId], blockNumber: readAtBlock })) as RawIntent
      if (raw.vaultId === 0n) throw new Error(`Intent ${intentId} does not exist at block ${readAtBlock} (unknown or not yet confirmed)`)
      return {
        chainId: binding.chainId,
        contract: binding.contract,
        intentId,
        vaultId: raw.vaultId,
        kind: Number(raw.kind),
        direction: Number(raw.direction),
        source: Number(raw.source),
        maxSats: BigInt(raw.maxSats),
        maxBps: BigInt(raw.maxBps),
        minOut: BigInt(raw.minOut),
        maxOut: BigInt(raw.maxOut),
        expiry: BigInt(raw.expiry),
        price: BigInt(raw.price),
        priceSignedAt: BigInt(raw.priceSignedAt),
        settled: raw.settled,
        bsvTxid: raw.bsvTxid,
        readAtBlock,
        latestBlock
      }
    },
    async vaultConfig(vaultId) {
      await checkChain()
      return (await client.readContract({ ...contract, functionName: 'getVaultConfig', args: [vaultId] })) as Record<string, unknown>
    },
    async remainingUsdToday(vaultId) {
      await checkChain()
      return (await client.readContract({ ...contract, functionName: 'remainingUsdToday', args: [vaultId] })) as bigint
    },
    async lastPrice(vaultId) {
      await checkChain()
      return (await client.readContract({ ...contract, functionName: 'lastPrice', args: [vaultId] })) as {
        price: bigint
        change1h: bigint
        updatedAt: bigint
        signedAt: bigint
      }
    },
    async intentEvents(fromBlock, toBlock, vaultId = binding.vaultId) {
      await checkChain()
      const last = toBlock ?? (await client.getBlockNumber())
      const out: Array<{ intentId: bigint; vaultId: bigint; kind: number; blockNumber: bigint; txHash: string }> = []
      // sepolia.base.org caps eth_getLogs at 200 blocks.
      for (let from = fromBlock; from <= last; from += 200n) {
        const to = from + 199n < last ? from + 199n : last
        const logs = await client.getContractEvents({ ...contract, eventName: 'IntentCreated', args: { vaultId }, fromBlock: from, toBlock: to })
        for (const log of logs) {
          const args = (log as unknown as { args: { intentId: bigint; vaultId: bigint; kind: number } }).args
          out.push({ intentId: args.intentId, vaultId: args.vaultId, kind: Number(args.kind), blockNumber: log.blockNumber!, txHash: log.transactionHash! })
        }
      }
      return out
    }
  }
}
