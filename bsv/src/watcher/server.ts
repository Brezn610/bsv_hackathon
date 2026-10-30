// The watcher as its own process: a small HTTP server on 127.0.0.1 that holds the watcher key
// and the journal. The agent sends a proposal with its own signatures; the server checks those
// signatures first (so no other local process can burn an intent), then runs the unchanged
// Watcher (re-read the intent on Base, policy, journal, sign) and answers with the watcher's
// signatures or the reasons it refused.
//
//   POST /cosign     proposal -> 200 signatures | 422 policy refusal | 409 intent already used | 403 bad agent signature
//   POST /broadcast  the broadcast transaction -> 200 | 409 not the one signed
//   GET  /health     public status, never calls WhatsOnChain
//   GET  /decisions  recent decisions (no keys, no signatures)
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PublicKey, Signature, Transaction, TransactionSignature, Utils, type Transaction as Tx } from '@bsv/sdk'
import { sighashOf } from '../vault/template'
import type { Decision } from './policy'
import type { Watcher } from './service'
import { decodeProposal } from './wire'

export interface DecisionRecord {
  at: string
  intentId: string
  status: number
  verdict: 'APPROVE' | 'DENY' | 'REJECTED'
  reasons?: string[]
  proposalId?: string
  toFloat?: number
  fee?: number
  vaultIn?: number
  change?: number
}

export interface WatcherServerOptions {
  watcher: Pick<Watcher, 'cosign' | 'recordBroadcast'>
  /** The agent's derived vault key from the binding: proposals must carry its signatures. */
  agentKey: string
  /** Public facts for /health (binding version, keys, chain). Never secrets. */
  info: Record<string, unknown>
  decisionsFile?: string
  host?: string
  port?: number
}

export interface RunningWatcherServer {
  url: string
  server: Server
  decisions: DecisionRecord[]
  close: () => Promise<void>
}

const SIGHASH_ALL_FORKID = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
const MAX_BODY_BYTES = 1_000_000

/** True if `sig` (checksig format) is the agent key's SIGHASH_ALL|FORKID signature over input `i`. */
export function isAgentSignature(tx: Tx, i: number, sig: number[], agentKey: string): boolean {
  try {
    if (sig.length < 9 || sig[sig.length - 1] !== SIGHASH_ALL_FORKID) return false
    return PublicKey.fromString(agentKey).verify(sighashOf(tx, i), Signature.fromDER(sig.slice(0, -1)))
  } catch {
    return false
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('request too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send(res: ServerResponse, status: number, body: unknown, cors = false): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  if (cors) headers['Access-Control-Allow-Origin'] = '*'
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

export async function startWatcherServer(o: WatcherServerOptions): Promise<RunningWatcherServer> {
  const decisions: DecisionRecord[] = []
  const startedAt = new Date().toISOString()
  const record = (d: DecisionRecord): void => {
    decisions.push(d)
    if (decisions.length > 200) decisions.shift()
    if (o.decisionsFile !== undefined) appendFileSync(o.decisionsFile, JSON.stringify(d) + '\n')
  }
  const fromDecision = (intentId: string, status: number, d: Decision): DecisionRecord =>
    d.verdict === 'DENY'
      ? { at: new Date().toISOString(), intentId, status, verdict: 'DENY', reasons: d.reasons }
      : { at: new Date().toISOString(), intentId, status, verdict: 'APPROVE', proposalId: d.proposalId, toFloat: d.toFloat, fee: d.fee, vaultIn: d.vaultIn, change: d.change }

  const cosign = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let proposal: ReturnType<typeof decodeProposal>
    try {
      proposal = decodeProposal(await readJson(req))
    } catch (err) {
      send(res, 400, { error: (err as Error).message })
      return
    }
    const { intentId, tx, agentSignatures } = proposal
    const id = intentId.toString()
    // The agent must have signed this exact transaction before the watcher spends an intent on it.
    const badInput = tx.inputs.findIndex((_, i) => agentSignatures[i] === undefined || !isAgentSignature(tx, i, agentSignatures[i], o.agentKey))
    if (agentSignatures.length !== tx.inputs.length || badInput !== -1) {
      const reason = `agent signature missing or invalid for input ${badInput === -1 ? 'count' : badInput}`
      record({ at: new Date().toISOString(), intentId: id, status: 403, verdict: 'REJECTED', reasons: [reason] })
      send(res, 403, { error: reason })
      return
    }
    const { decision, signatures } = await o.watcher.cosign(intentId, tx)
    if (decision.verdict === 'DENY' || signatures === undefined) {
      const used = decision.verdict === 'DENY' && decision.reasons.some(r => r.startsWith('journal already holds'))
      const status = used ? 409 : 422
      record(fromDecision(id, status, decision))
      send(res, status, { decision })
      return
    }
    record(fromDecision(id, 200, decision))
    send(res, 200, { decision, signatures: signatures.map(s => Utils.toHex(s)) })
  }

  const broadcast = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const body = (await readJson(req)) as { intentId?: unknown; tx?: unknown }
      if (typeof body.intentId !== 'string' || !/^[0-9]+$/.test(body.intentId) || typeof body.tx !== 'string') throw new Error('intentId and tx are required')
      await o.watcher.recordBroadcast(BigInt(body.intentId), Transaction.fromHex(body.tx))
      send(res, 200, { recorded: true })
    } catch (err) {
      send(res, 409, { error: (err as Error).message })
    }
  }

  const server = createServer((req, res) => {
    const route = `${req.method ?? ''} ${(req.url ?? '').split('?')[0]}`
    const run = async (): Promise<void> => {
      if (route === 'POST /cosign') return await cosign(req, res)
      if (route === 'POST /broadcast') return await broadcast(req, res)
      if (route === 'GET /health') {
        const last = decisions.at(-1)
        return send(res, 200, { ok: true, ...o.info, startedAt, decisions: decisions.length, lastDecision: last === undefined ? null : { at: last.at, intentId: last.intentId, verdict: last.verdict, status: last.status } }, true)
      }
      if (route === 'GET /decisions') return send(res, 200, decisions, true)
      send(res, 404, { error: 'not found' })
    }
    run().catch(err => {
      // Fail closed: an unexpected error is a refusal, never a signature.
      if (!res.headersSent) send(res, 500, { error: (err as Error).message })
    })
  })
  await new Promise<void>(resolve => server.listen(o.port ?? 4810, o.host ?? '127.0.0.1', resolve))
  const { address, port } = server.address() as AddressInfo
  return {
    url: `http://${address}:${port}`,
    server,
    decisions,
    close: async () => await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
