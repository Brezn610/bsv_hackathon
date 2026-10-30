// Unspent outputs of one locking script on BSV mainnet, from WhatsOnChain (mempool included).
// The watcher's independent check that the vault UTXOs it is asked to spend still exist. Any
// HTTP or API error throws, so the watcher fails closed. wallet-toolbox's getUtxoStatus has no
// mainnet provider without an API key ("No services available"), hence this.
import { Hash, Utils } from '@bsv/sdk'

export async function unspentByScript(lockingScriptHex: string, network: 'main' | 'test' = 'main'): Promise<Map<string, number>> {
  const scriptHash = Utils.toHex(Hash.sha256(Utils.toArray(lockingScriptHex, 'hex')).reverse())
  const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${network}/script/${scriptHash}/unspent/all`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`WhatsOnChain answered HTTP ${res.status}`)
  const body = (await res.json()) as { error?: string; result?: Array<{ tx_hash: string; tx_pos: number; value: number; isSpentInMempoolTx?: boolean }> }
  if (body.error !== undefined && body.error !== '') throw new Error(`WhatsOnChain: ${body.error}`)
  if (!Array.isArray(body.result)) throw new Error('WhatsOnChain returned no result list')
  const out = new Map<string, number>()
  for (const u of body.result) if (u.isSpentInMempoolTx !== true) out.set(`${u.tx_hash}.${u.tx_pos}`, u.value)
  return out
}
