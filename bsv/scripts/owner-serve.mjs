// The owner's control server for the dashboard. It only runs the team's existing commands, unchanged:
//   fund / exit        `tg fund`, `tg exit`: BSV Desktop asks the owner to approve every transaction (gate 1, exit proof
//                      and the 50,000-sat cap of `tg` still apply)
//   agent cycle        one full spend, step by step: api3 `spend5.ts` (signed price -> SPEND intent on Base Sepolia),
//                      `tg withdraw --intent N` (the watcher checks and co-signs), `tg buy` (the agent's model decides,
//                      HTTP 402 payment), api3 `tweet-cycle.ts --live --settle-only N` (settle record on Base)
//   refusal            `tg withdraw --intent N` for an intent already used: the watcher refuses (409), nothing moves
// This server holds no key and builds no transaction; the commands use their own key files as before. Do not run
// `tweet-cycle.ts --live` or another process that signs with the vault-5 agent key at the same time.
//
//   CONFIRM_MAINNET=1 npm run owner-serve          then open the URL it prints (it carries a one-time token)
//
// Protection, because a local HTTP endpoint can be reached by any web page in the same browser:
//   - listens on 127.0.0.1 only and rejects any other Host header (DNS rebinding);
//   - CORS and an Origin check allow only the dashboard origins (OWNER_ORIGINS);
//   - a random token, printed here, is required on every request;
//   - mainnet actions are refused unless this server was started with CONFIRM_MAINNET=1;
//   - one action at a time, fixed commands, validated arguments, no shell.
// Plain Node (no dependencies), so it runs without a build step.
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BSV_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.OWNER_PORT ?? 5820) // 48xx can be reserved by Windows (WSL mirrored networking)
const DASHBOARD = process.env.OWNER_DASHBOARD_URL ?? 'http://localhost:8765/'
const ORIGINS = new Set((process.env.OWNER_ORIGINS ?? 'http://localhost:8765,http://127.0.0.1:8765').split(',').map(s => s.trim()).filter(Boolean))
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const MAINNET = process.env.CONFIRM_MAINNET === '1'
const TOKEN = process.env.OWNER_TOKEN ?? randomBytes(18).toString('hex')
// The CLI that runs the actions. Default: this checkout's tsx on scripts/tg.ts. OWNER_TG_CMD (a JSON array) is for tests.
const TG_CMD = process.env.OWNER_TG_CMD ? JSON.parse(process.env.OWNER_TG_CMD) : [path.join(BSV_DIR, 'node_modules', '.bin', 'tsx'), path.join(BSV_DIR, 'scripts', 'tg.ts')]
const API3_DIR = path.join(BSV_DIR, '..', 'api3')
// The API3 steps, run with this Node and the agent's own env file (api3/.env.agent), as the team runs them by hand.
// OWNER_API3_CMD (a JSON array) replaces `node --env-file=.env.agent` for tests.
const API3_CMD = process.env.OWNER_API3_CMD ? JSON.parse(process.env.OWNER_API3_CMD) : [process.execPath, '--env-file=.env.agent']
// Remote API3 agent (bsv/scripts/api3-agent-serve.mjs on the laptop that holds api3/.env.agent): with API3_AGENT_URL
// and API3_AGENT_TOKEN set, the cycle's first step (signed price → SPEND intent) and last step (settle) run there.
const API3_REMOTE = process.env.API3_AGENT_URL ? process.env.API3_AGENT_URL.replace(/\/+$/, '') : null
const API3_REMOTE_TOKEN = process.env.API3_AGENT_TOKEN ?? ''
const remote = async (pathName, init = {}) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4 * 60_000)
  try {
    const res = await fetch(API3_REMOTE + pathName, { ...init, signal: controller.signal, headers: { 'X-Agent-Token': API3_REMOTE_TOKEN, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `API3 agent service: HTTP ${res.status}`)
    return body
  } finally { clearTimeout(timer) }
}
const MAX_AGENT_CYCLES = Number(process.env.AGENT_MAX_CYCLES ?? 3) // per server start: each cycle spends real sats
let agentCycles = 0
const JOB_TIMEOUT_MS = 5 * 60_000 // BSV Desktop waits for the owner to approve; settle waits for the BSV receipt
// Same caps as `tg fund`; `tg` enforces them again. The exit-proof evidence decides which one applies.
const EXIT_EVIDENCE = path.join(BSV_DIR, 'data', 'evidence', 'owner-exit.json')
const fundCap = () => (existsSync(EXIT_EVIDENCE) ? 50_000 : 5_000)

// The agent's own log of each purchase (written by `tg buy`): the task, the model's decision and reason, the guardian's
// checks and what came back. Read-only; only these fields leave this machine.
const EVIDENCE_DIR = path.join(BSV_DIR, 'data', 'evidence')
const clip = (v, n = 400) => (typeof v === 'string' ? v.slice(0, n) : v)
function agentDecisions() {
  let files = []
  try { files = readdirSync(EVIDENCE_DIR).filter((f) => /^http402-\d+\.json$/.test(f)) } catch { return [] }
  return files.map((f) => {
    try {
      const e = JSON.parse(readFileSync(path.join(EVIDENCE_DIR, f), 'utf8'))
      const g = e.guardian || {}
      return {
        at: clip(e.at, 40), task: clip(e.task), status: Number.isInteger(e.status) ? e.status : null, paid: e.paid !== false && !!e.paymentTxid,
        paymentTxid: typeof e.paymentTxid === 'string' && /^[0-9a-f]{64}$/.test(e.paymentTxid) ? e.paymentTxid : null,
        priceSats: Number.isInteger(e.priceSats) ? e.priceSats : null, merchant: clip(e.merchant, 80), ms: Number.isInteger(e.msRequestToAnswer) ? e.msRequestToAnswer : null,
        decision: e.decision ? { buy: !!e.decision.buy, reason: clip(e.decision.reason), by: clip(e.decision.decidedBy, 40) } : null,
        guardian: e.guardian ? { decision: clip(g.decision, 20), risk: Number.isFinite(g.risk) ? g.risk : null, reasons: (g.reasons || []).slice(0, 3).map((r) => clip(r, 200)), findings: (g.findings || []).slice(0, 6).map((x) => ({ rule: clip(x.rule, 40), severity: clip(x.severity, 20), detail: clip(x.detail, 200) })) } : null,
        received: e.body && typeof e.body === 'object' ? { kind: clip(e.body.kind, 120), note: clip(e.body.note ?? e.body.summary ?? '', 240) } : null
      }
    } catch { return null }
  }).filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20)
}

const jobs = new Map()
let running = null
let seq = 0

const tokenOk = (given) => {
  if (typeof given !== 'string' || given.length !== TOKEN.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN))
}

const summary = (j) => j && { id: j.id, kind: j.kind, sats: j.sats, intentId: j.intentId, state: j.state, startedAt: j.startedAt, endedAt: j.endedAt, txid: j.txid, message: j.message, steps: j.steps.map(st => ({ key: st.key, label: st.label, state: st.state, message: st.message, txid: st.txid, baseTx: st.baseTx })) }

// The last meaningful line of a command's output. The commands print no keys, and only such lines are passed on.
const lastLine = (text) => text.split('\n').map(s => s.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? ''
const WOC_TX = /whatsonchain\.com\/tx\/([0-9a-f]{64})/
const BASE_TX = /sepolia\.basescan\.org\/tx\/(0x[0-9a-f]{64})/

// Runs one command; resolves { code, out, err }. Never a shell.
function run(cmd, args, cwd, env, job) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d; const l = lastLine(out); if (l && job.current) job.current.message = l })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => { err += '\ntimed out'; child.kill('SIGTERM') }, JOB_TIMEOUT_MS)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: `could not start: ${e.message}` }) })
  })
}
const tg = (args, job) => run(TG_CMD[0], [...TG_CMD.slice(1), ...args], BSV_DIR, { CONFIRM_MAINNET: MAINNET ? '1' : '' }, job)
const api3 = (args, job) => run(API3_CMD[0], [...API3_CMD.slice(1), ...args], API3_DIR, {}, job)

// Each step: { key, label, exec(job) -> Promise<{ ok, message, txid?, baseTx?, skipped? }> }. Steps run in order; the
// first failure stops the job.
const STEPS = {
  fund: (sats) => [{ key: 'fund', label: `Fund the vault with ${sats} sats (approve in BSV Desktop)`, exec: async (job) => {
    const r = await tg(['fund', '--sats', String(sats)], job)
    const m = /Funded: https:\/\/whatsonchain\.com\/tx\/([0-9a-f]{64})/.exec(r.out)
    return r.code === 0 && m ? { ok: true, txid: m[1], message: `Funded the vault with ${sats} sats.` } : { ok: false, message: lastLine(r.err) || lastLine(r.out) }
  } }],
  exit: () => [{ key: 'exit', label: 'Owner exit (approve in BSV Desktop)', exec: async (job) => {
    const r = await tg(['exit'], job)
    const m = /Owner exit: https:\/\/whatsonchain\.com\/tx\/([0-9a-f]{64})/.exec(r.out)
    return r.code === 0 && m ? { ok: true, txid: m[1], message: 'The owner took every vault coin back.' } : { ok: false, message: lastLine(r.err) || lastLine(r.out) }
  } }],
  cycle: () => [
    { key: 'intent', label: 'Signed price → SPEND intent on Base Sepolia', exec: async (job) => {
      if (API3_REMOTE) {
        try {
          job.current.message = 'The API3 agent buys a signed price and asks for budget…'
          const r = await remote('/spend', { method: 'POST', body: '{}' })
          if (!/^\d+$/.test(String(r.intentId))) return { ok: false, message: 'the API3 agent answered without an intent' }
          job.intentId = String(r.intentId)
          return { ok: true, baseTx: typeof r.baseTx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r.baseTx) ? r.baseTx : null, message: `SPEND intent ${r.intentId}: up to ${r.maxSats} sats.` }
        } catch (e) { return { ok: false, message: String(e.message || e) } }
      }
      const r = await api3(['src/spend5.ts'], job)
      const m = /intentId (\d+)n? kind 0 maxSats (\d+)/.exec(r.out)
      const b = BASE_TX.exec(r.out)
      if (r.code !== 0 || !m) return { ok: false, message: lastLine(r.err) || lastLine(r.out) || 'no SPEND intent was created' }
      job.intentId = m[1]
      return { ok: true, baseTx: b ? b[1] : null, message: `SPEND intent ${m[1]}: up to ${m[2]} sats.` }
    } },
    { key: 'withdraw', label: 'Watcher checks and co-signs; money leaves the vault', exec: async (job) => {
      const r = await tg(['withdraw', '--intent', job.intentId], job)
      const m = /Withdrawal broadcast: https:\/\/whatsonchain\.com\/tx\/([0-9a-f]{64})/.exec(r.out)
      const a = /(\d+) sats to the Agent Float, fee (\d+)/.exec(r.out)
      return r.code === 0 && m ? { ok: true, txid: m[1], message: a ? `${a[1]} sats to the Agent Float, fee ${a[2]}.` : 'Withdrawal broadcast.' } : { ok: false, message: lastLine(r.err) || lastLine(r.out) }
    } },
    { key: 'buy', label: 'The agent decides and pays over HTTP 402', exec: async (job) => {
      const r = await tg(['buy'], job)
      const d = /Agent \(([^)]+)\): (BUY|SKIP) - (.*)/.exec(r.out)
      const m = /HTTP (\d+); payment https:\/\/whatsonchain\.com\/tx\/([0-9a-f]{64})/.exec(r.out)
      if (r.code === 0 && d && d[2] === 'SKIP') return { ok: true, skipped: true, message: `${d[1]} decided not to buy: ${d[3].slice(0, 200)}` }
      return r.code === 0 && m ? { ok: true, txid: m[2], message: `${d ? `${d[1]} chose to buy. ` : ''}HTTP ${m[1]}, paid.` } : { ok: false, message: lastLine(r.err) || lastLine(r.out) }
    } },
    { key: 'settle', label: 'Settle record on Base (finds the BSV receipt first)', exec: async (job) => {
      if (API3_REMOTE) {
        // The remote service started settling right after the intent; wait for it here.
        const end = Date.now() + 10 * 60_000
        while (Date.now() < end) {
          try {
            const st = await remote(`/intent/${job.intentId}`)
            if (st.state === 'settled') return { ok: true, baseTx: typeof st.settleTx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(st.settleTx) ? st.settleTx : null, message: 'Recorded on Base (a record, not a proof).' }
            if (st.state === 'failed') return { ok: false, message: String(st.message || 'settle failed') }
            job.current.message = 'The API3 agent waits for the BSV receipt, then settles…'
          } catch (e) { job.current.message = `API3 agent service: ${String(e.message || e)}` }
          await new Promise((r) => setTimeout(r, 4000))
        }
        return { ok: false, message: 'settle did not finish within 10 minutes' }
      }
      const r = await api3(['src/tweet-cycle.ts', '--live', '--settle-only', job.intentId], job)
      const b = BASE_TX.exec(r.out)
      const ok = r.code === 0 && /\b(settle-sent|already-settled)\b/.test(r.out)
      return ok ? { ok: true, baseTx: b ? b[1] : null, message: 'Recorded on Base (a record, not a proof).' } : { ok: false, message: lastLine(r.err) || lastLine(r.out) }
    } }
  ],
  refusal: (intentId) => [{ key: 'refusal', label: `Replay intent ${intentId}: the watcher must refuse`, exec: async (job) => {
    const r = await tg(['withdraw', '--intent', intentId], job)
    const text = `${r.out}\n${r.err}`
    if (WOC_TX.test(r.out) && /Withdrawal broadcast/.test(r.out)) return { ok: false, message: 'Unexpected: a withdrawal was broadcast.' }
    const m = /(journal already holds[^\n]*|Watcher refused[^\n]*|refused[^\n]*)/i.exec(text)
    return r.code !== 0 && m ? { ok: true, message: m[1].slice(0, 300) } : { ok: false, message: lastLine(r.err) || lastLine(r.out) }
  } }]
}

function startJob(kind, steps, extra = {}) {
  const job = { id: String(++seq), kind, ...extra, state: 'running', startedAt: new Date().toISOString(), endedAt: null, txid: null, message: steps[0].label,
    steps: steps.map(st => ({ key: st.key, label: st.label, state: 'todo', message: '', txid: null, baseTx: null })), current: null }
  jobs.set(job.id, job)
  if (jobs.size > 20) jobs.delete(jobs.keys().next().value)
  running = job
  ;(async () => {
    for (let i = 0; i < steps.length; i++) {
      const st = job.steps[i]
      st.state = 'running'
      job.current = st
      job.message = st.label
      let r
      try { r = await steps[i].exec(job) } catch (e) { r = { ok: false, message: String(e.message || e) } }
      st.message = r.message || ''
      st.txid = r.txid ?? null
      st.baseTx = r.baseTx ?? null
      st.state = r.ok ? (r.skipped ? 'skipped' : 'done') : 'failed'
      if (r.txid) job.txid = r.txid
      if (!r.ok) { job.state = 'failed'; job.message = st.message || `${st.label} failed`; break }
    }
    if (job.state === 'running') { job.state = 'done'; job.message = job.steps.at(-1).message }
    job.current = null
    job.endedAt = new Date().toISOString()
    running = null
    console.log(`[control] ${kind} ${job.state}: ${job.message}`)
  })()
  return job
}

function send(res, status, body, origin) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  if (origin) { headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin' }
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const c of req) { size += c.length; if (size > 1024) throw new Error('body too large'); chunks.push(c) }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin
  const allowed = origin && ORIGINS.has(origin) ? origin : null
  if (!HOSTS.has(req.headers.host ?? '')) return send(res, 421, { error: 'wrong host' })
  if (origin && !allowed) return send(res, 403, { error: 'origin not allowed' })
  if (req.method === 'OPTIONS') {
    if (!allowed) return send(res, 403, { error: 'origin not allowed' })
    res.writeHead(204, { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, X-Owner-Token', 'Access-Control-Max-Age': '600', Vary: 'Origin' })
    return res.end()
  }
  if (!tokenOk(req.headers['x-owner-token'])) return send(res, 401, { error: 'missing or wrong owner token' }, allowed)
  const url = (req.url ?? '').split('?')[0]
  try {
    if (req.method === 'GET' && url === '/owner/health') {
      return send(res, 200, { ok: true, mainnetAllowed: MAINNET, fundCap: fundCap(), agentCyclesLeft: Math.max(0, MAX_AGENT_CYCLES - agentCycles), api3: API3_REMOTE ? 'remote' : 'local', busy: summary(running), last: summary([...jobs.values()].at(-1)) }, allowed)
    }
    if (req.method === 'GET' && url === '/agent/decisions') return send(res, 200, agentDecisions(), allowed)
    const jm = /^\/owner\/jobs\/(\d+)$/.exec(url)
    if (req.method === 'GET' && jm) {
      const j = jobs.get(jm[1])
      return j ? send(res, 200, summary(j), allowed) : send(res, 404, { error: 'no such job' }, allowed)
    }
    if (req.method === 'POST' && ['/owner/fund', '/owner/exit', '/agent/cycle', '/agent/refusal'].includes(url)) {
      if (!allowed) return send(res, 403, { error: 'origin not allowed' })
      if ((req.headers['content-type'] ?? '').split(';')[0] !== 'application/json') return send(res, 415, { error: 'JSON only' }, allowed)
      if (!MAINNET) return send(res, 403, { error: 'Mainnet actions are off. Restart with CONFIRM_MAINNET=1 npm run owner-serve.' }, allowed)
      if (running) return send(res, 409, { error: 'Another owner action is still running.', job: summary(running) }, allowed)
      const body = await readBody(req)
      if (url === '/owner/fund') {
        const sats = body.sats
        const cap = fundCap()
        if (!Number.isSafeInteger(sats) || sats < 1 || sats > cap) return send(res, 400, { error: `sats must be a whole number from 1 to ${cap}` }, allowed)
        return send(res, 202, summary(startJob('fund', STEPS.fund(sats), { sats })), allowed)
      }
      if (url === '/agent/cycle') {
        if (agentCycles >= MAX_AGENT_CYCLES) return send(res, 429, { error: `This server allows ${MAX_AGENT_CYCLES} agent cycles per start (AGENT_MAX_CYCLES). Restart it to allow more.` }, allowed)
        agentCycles++
        return send(res, 202, summary(startJob('cycle', STEPS.cycle())), allowed)
      }
      if (url === '/agent/refusal') {
        const id = String(body.intentId ?? '')
        if (!/^\d{1,9}$/.test(id)) return send(res, 400, { error: 'intentId must be a whole number' }, allowed)
        return send(res, 202, summary(startJob('refusal', STEPS.refusal(id), { intentId: id })), allowed)
      }
      if (body.confirm !== 'EXIT') return send(res, 400, { error: 'confirm must be "EXIT"' }, allowed)
      return send(res, 202, summary(startJob('exit', STEPS.exit())), allowed)
    }
    return send(res, 404, { error: 'not found' }, allowed)
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) }, allowed)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Owner control on http://127.0.0.1:${PORT} (mainnet ${MAINNET ? 'ON' : 'OFF: start with CONFIRM_MAINNET=1'}; up to ${MAX_AGENT_CYCLES} agent cycles)`)
  console.log(API3_REMOTE ? `API3 steps: remote agent service at ${new URL(API3_REMOTE).host}` : 'API3 steps: local (needs api3/.env.agent here)')
  console.log('Needs running: the watcher (npm run tg -- watcher-serve) and BSV Desktop. Do not run tweet-cycle --live at the same time.')
  console.log(`Allowed dashboard origins: ${[...ORIGINS].join(', ')}`)
  console.log(`Open the dashboard with this link (it carries the owner token; do not share it):`)
  console.log(`  ${DASHBOARD}?owner=${TOKEN}#owner`)
})
