import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GoChaintracksServiceClient, GoChaintracksServiceClientOptions } from '../GoChaintracksServiceClient'
import { deserializeBlockHeaders } from '../util/blockHeaderUtilities'

// Consecutive public headers are a decoding fixture, not a mined fork.
const headers = deserializeBlockHeaders(0, Array.from(readFileSync(join(__dirname, 'data/cdnTest402/mainNet_0.headers'))))
const [ancestor, parent, oldTip, newTip] = headers
const goEvent = { depth: 2, commonAncestor: ancestor, newTip, orphanedHashes: [oldTip.hash, parent.hash] }
const tsEvent = { depth: 2, oldTip, newTip, deactivatedHeaders: [oldTip, parent] }
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }

function harness(events: unknown[], options: GoChaintracksServiceClientOptions = {}, lookup?: typeof fetch) {
  const fetcher = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/reorg/stream')) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`))
        }
      }))
    }
    if (lookup != null) return await lookup(input, init)
    const header = headers.find(h => url.endsWith(`/header/hash/${h.hash}`))
    return new Response(JSON.stringify({ status: 'success', value: header }), { status: header == null ? 404 : 200 })
  })
  const client = new GoChaintracksServiceClient('main', 'https://chaintracks.example/v2', {
    fetch: fetcher as typeof fetch, reconnectWaitMsecs: 10000, ...options
  })
  return { client, fetcher }
}

async function replay(events: unknown[], check: (client: GoChaintracksServiceClient, listener: jest.Mock, fetcher: jest.Mock) => void, options: GoChaintracksServiceClientOptions = {}, lookup?: typeof fetch) {
  const { client, fetcher } = harness(events, options, lookup)
  const listener = jest.fn()
  const id = await client.subscribeReorgs(listener)
  try { await flush(); check(client, listener, fetcher) } finally { await client.unsubscribe(id) }
}

// Structural casts keep this witness executable at the base before the additive API exists.
const errors = (client: GoChaintracksServiceClient) => (client as unknown as { streamErrorCount: number }).streamErrorCount

test('preserves the TypeScript shape', async () => {
  await replay([tsEvent], (_client, listener) => expect(listener).toHaveBeenCalledWith(2, oldTip, newTip, [oldTip, parent]))
})

test('normalizes the Go shape using only announced hash lookups', async () => {
  await replay([goEvent], (_client, listener, fetcher) => {
    expect(listener).toHaveBeenCalledWith(2, oldTip, newTip, [oldTip, parent])
    expect(fetcher.mock.calls.map(call => String(call[0]).split('/v2')[1])).toEqual([
      '/reorg/stream', `/header/hash/${oldTip.hash}`, `/header/hash/${parent.hash}`
    ])
  })
})

test.each([
  ['malformed JSON', '{broken'],
  ['unknown keys', { ...goEvent, extra: true }],
  ['inconsistent depth', { ...goEvent, depth: 1 }],
  ['duplicate hashes', { ...goEvent, orphanedHashes: [oldTip.hash, oldTip.hash] }],
  ['missing hashes', { ...goEvent, orphanedHashes: [oldTip.hash, '11'.repeat(32)] }]
])('reports %s without notifying the listener', async (_name, event) => {
  await replay([event], (client, listener) => {
    expect(listener).not.toHaveBeenCalled()
    expect(errors(client)).toBe(1)
  })
})
