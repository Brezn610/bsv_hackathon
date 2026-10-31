// A small paid API over HTTP 402 (BRC-121, @bsv/402-pay): the merchant's wallet validates and
// internalizes the BRC-29 payment before the route runs, so the answer is only released after a
// valid payment. The content is a deterministic demo answer, labelled as such.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createPaymentMiddleware } from '@bsv/402-pay/server'
import type { WalletInterface } from '@bsv/sdk'

export interface PaidApi {
  baseUrl: string
  priceSats: number
  server: Server
  /** Paid requests served, for the demo log. */
  served: Array<{ path: string; at: string }>
  close: () => Promise<void>
}

export const RESEARCH_PATH = '/api/research'

export async function startPaidApi(wallet: WalletInterface, opts: { priceSats: number; port?: number; host?: string; maxPerMinute?: number }): Promise<PaidApi> {
  const app = express()
  // calculatePrice matches paths exactly; so must routing, or "/API/research" would be free.
  app.set('case sensitive routing', true)
  app.set('strict routing', true)
  const hits: number[] = []
  app.use((_req, res, next) => {
    const now = Date.now()
    while (hits.length > 0 && hits[0] < now - 60_000) hits.shift()
    if (hits.length >= (opts.maxPerMinute ?? 30)) {
      res.status(429).json({ error: 'rate limited' })
      return
    }
    hits.push(now)
    next()
  })
  app.use(createPaymentMiddleware({ wallet, calculatePrice: path => (path === RESEARCH_PATH ? opts.priceSats : undefined) }))
  const served: PaidApi['served'] = []
  app.get(RESEARCH_PATH, (req, res) => {
    const topic = String(req.query.topic ?? 'bsv')
    served.push({ path: req.path, at: new Date().toISOString() })
    res.json({
      topic,
      kind: 'demo research note (deterministic, not external data)',
      note: `Treasury Guard demo merchant: one paid answer about "${topic}".`,
      paidSats: opts.priceSats,
      servedAt: new Date().toISOString()
    })
  })
  const host = opts.host ?? 'localhost'
  const server = await new Promise<Server>(resolve => {
    // The payment travels as BEEF in the x-bsv-beef header. With several unconfirmed ancestors (quick runs between
    // blocks) it outgrows Node's default 16 KB header limit and the request fails with HTTP 431, after the agent paid.
    const s = createServer({ maxHeaderSize: 1024 * 1024 }, app).listen(opts.port ?? 0, host, () => resolve(s))
  })
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://${host}:${port}`,
    priceSats: opts.priceSats,
    server,
    served,
    close: async () => await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
