// After BSV Desktop hands back a transaction, check that the network has it, and post the same signed
// transaction again if it does not. Seen on 2026-10-31: a vault deposit (a5ed5ffa…) came back from BSV
// Desktop with a txid, yet minutes later neither WhatsOnChain nor ARC knew it; posting the same BEEF put it
// in the next block. A deposit the network never saw would make the next withdrawal fail at the watcher.
import { Beef } from '@bsv/sdk'
import { Services } from '@bsv/wallet-toolbox'
import { ARCADE_URL } from './serverWallet'

type Post = (beef: Beef, txids: string[]) => Promise<Array<{ status: string }>>

const sleep = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))

/** True when WhatsOnChain returns the transaction (mempool or block). Any error counts as not seen. */
export async function seenOnNetwork(txid: string): Promise<boolean> {
  const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid}`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
  return res?.ok === true
}

const defaultPost: Post = async (beef, txids) => {
  const options = Services.createDefaultOptions('main')
  options.arcadeUrl = ARCADE_URL
  return await new Services(options).postBeef(beef, txids)
}

/**
 * 'seen': the network already had it. 'posted': it did not; the same signed transaction was posted and
 * is now seen. 'unseen': still not seen after posting. Never throws; the caller decides what to print.
 */
export async function ensureBroadcast(beef: Beef, txid: string, opts: { gapMs?: number; post?: Post; seen?: (txid: string) => Promise<boolean> } = {}): Promise<'seen' | 'posted' | 'unseen'> {
  const gap = opts.gapMs ?? 2_000
  const seen = opts.seen ?? seenOnNetwork
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(gap)
    if (await seen(txid)) return 'seen'
  }
  await (opts.post ?? defaultPost)(beef, [txid]).catch(() => [])
  for (let i = 0; i < 3; i++) {
    await sleep(gap)
    if (await seen(txid)) return 'posted'
  }
  return 'unseen'
}
