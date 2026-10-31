// The API3 agent as a small service, so a live demo can be started from another laptop while the vault-5 agent key
// stays on this one. It only runs the team's existing scripts, unchanged:
//
//   POST /spend        `node --env-file=.env.agent src/spend5.ts` once: a fresh signed BSV/USD price (x402) and a
//                      SPEND intent on vault 5. Answers { intentId, maxSats, baseTx }. Then, in the background,
//                      `src/tweet-cycle.ts --live --settle-only N`, which waits for the BSV receipt and settles.
//   GET  /intent/N     { state: 'settling' | 'settled' | 'failed', settleTx, message }
//   GET  /health       { ok, busy, runsLeft }
//
// Run on the laptop that holds api3/.env.agent (api3 dependencies installed):
//   node bsv/scripts/api3-agent-serve.mjs
// and expose it to the demo laptop, e.g. with `cloudflared tunnel --url http://localhost:5830`. Give the demo laptop
// the tunnel URL and the token this prints (API3_AGENT_URL, API3_AGENT_TOKEN for bsv/scripts/owner-serve.mjs).
//
// Every request needs the X-Agent-Token header. One spend at a time, AGENT_MAX_RUNS (default 4) per start, so a leaked
// URL can at most open a few $0.001 limits on Base Sepolia; it cannot move BSV (that needs the watcher and the BSV
// agent key on the other laptop). Plain Node, no dependencies. Do not run tweet-cycle.ts --live in polling mode, or
// anything else that signs with the vault-5 agent key, at the same time.
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// It lives in bsv/scripts (the bridge belongs to the team, not to api3/) and runs the scripts in ../../api3.
const API3_DIR = process.env.API3_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'api3')
const PORT = Number(process.env.AGENT_PORT ?? 5830)
const HOST = process.env.AGENT_HOST ?? '127.0.0.1'
const TOKEN = process.env.AGENT_TOKEN ?? randomBytes(18).toString('hex')
const MAX_RUNS = Number(process.env.AGENT_MAX_RUNS ?? 4)
const SPEND_TIMEOUT_MS = 3 * 60_000
const SETTLE_TIMEOUT_MS = 17 * 60_000 // tweet-cycle gives up on the receipt after 15 min
const BASE_TX = /sepolia\.basescan\.org\/tx\/(0x[0-9a-fA-F]{64})/

if (!existsSync(path.join(API3_DIR, '.env.agent'))) {
  console.error('api3/.env.agent is missing: this service needs the vault-5 agent key.')
  process.exit(1)
}

let runs = 0
let busy = false
const intents = new Map() // intentId → { state, settleTx, message, at }
const settlers = new Map() // intentId → the running tweet-cycle child, so it can be cancelled

const lastLine = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? ''
function run(args, timeoutMs, onChild) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--env-file=.env.agent', ...args], { cwd: API3_DIR, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    if (onChild) onChild(child)
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d) })
    child.stderr.on('data', (d) => { err += d; process.stderr.write(d) })
    const timer = setTimeout(() => { err += '\ntimed out'; child.kill('SIGTERM') }, timeoutMs)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: `could not start: ${e.message}` }) })
  })
}

async function settleInBackground(intentId) {
  intents.set(intentId, { state: 'settling', settleTx: null, message: 'waiting for the BSV receipt', at: Date.now() })
  const r = await run(['src/tweet-cycle.ts', '--live', '--settle-only', intentId], SETTLE_TIMEOUT_MS, (c) => settlers.set(intentId, c))
  settlers.delete(intentId)
  if (intents.get(intentId)?.state === 'cancelled') return
  const ok = r.code === 0 && /\b(settle-sent|already-settled)\b/.test(r.out)
  const tx = BASE_TX.exec(r.out)
  // tweet-cycle exits 0 on receipt-timeout too: that means no BSV transaction with this intent's receipt was found.
  const timedOut = /\breceipt-timeout\b/.test(r.out)
  intents.set(intentId, ok
    ? { state: 'settled', settleTx: tx ? tx[1] : null, message: 'settled on Base', at: Date.now() }
    : { state: 'failed', settleTx: null, message: timedOut ? 'no BSV receipt found within 15 min' : (lastLine(r.err) || lastLine(r.out) || 'settle failed'), at: Date.now() })
  console.log(`[agent-serve] intent ${intentId}: ${intents.get(intentId).state}`)
}

const tokenOk = (given) => typeof given === 'string' && given.length === TOKEN.length && timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN))
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  if (!tokenOk(req.headers['x-agent-token'])) return send(res, 401, { error: 'missing or wrong agent token' })
  const url = (req.url ?? '').split('?')[0]
  // A spend waits until the previous intent is settled: two processes must never sign with the vault-5 key at once.
  const settling = [...intents.values()].some((x) => x.state === 'settling')
  if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true, busy: busy || settling, settling, runsLeft: Math.max(0, MAX_RUNS - runs) })
  // The demo laptop cancels the wait when its withdrawal failed: no BSV receipt will ever come for that intent.
  const c = /^\/intent\/(\d{1,9})\/cancel$/.exec(url)
  if (req.method === 'POST' && c) {
    const it = intents.get(c[1])
    if (!it || it.state !== 'settling') return send(res, 409, { error: 'not settling' })
    intents.set(c[1], { state: 'cancelled', settleTx: null, message: 'cancelled: no BSV withdrawal for this intent', at: Date.now() })
    settlers.get(c[1])?.kill('SIGTERM')
    return send(res, 200, { ok: true })
  }
  const m = /^\/intent\/(\d{1,9})$/.exec(url)
  if (req.method === 'GET' && m) {
    const it = intents.get(m[1])
    return it ? send(res, 200, it) : send(res, 404, { error: 'unknown intent' })
  }
  if (req.method === 'POST' && url === '/spend') {
    if (busy) return send(res, 409, { error: 'a spend is already running' })
    if (settling) return send(res, 409, { error: 'the previous intent is still settling on Base; try again when it is settled' })
    if (runs >= MAX_RUNS) return send(res, 429, { error: `this service allows ${MAX_RUNS} spends per start (AGENT_MAX_RUNS)` })
    busy = true
    runs++
    try {
      const r = await run(['src/spend5.ts'], SPEND_TIMEOUT_MS)
      const im = /intentId (\d+)n? kind 0 maxSats (\d+)/.exec(r.out)
      const tx = BASE_TX.exec(r.out)
      if (r.code !== 0 || !im) return send(res, 502, { error: lastLine(r.err) || lastLine(r.out) || 'no SPEND intent was created' })
      settleInBackground(im[1])
      return send(res, 200, { intentId: im[1], maxSats: im[2], baseTx: tx ? tx[1] : null })
    } finally {
      busy = false
    }
  }
  return send(res, 404, { error: 'not found' })
})

server.listen(PORT, HOST, () => {
  console.log(`API3 agent service on http://${HOST}:${PORT} (up to ${MAX_RUNS} spends)`)
  console.log('Expose it to the demo laptop, e.g.:  cloudflared tunnel --url http://localhost:' + PORT)
  console.log(`Token (give it to the demo laptop as API3_AGENT_TOKEN; do not post it):  ${TOKEN}`)
})
