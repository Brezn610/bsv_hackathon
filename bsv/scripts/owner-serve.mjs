// Owner actions for the dashboard: fund the vault and the owner-only exit, through the existing `tg fund` and
// `tg exit` commands. This server never holds a key and builds no transaction itself: `tg` asks BSV Desktop, and the
// owner approves every transaction in BSV Desktop. The gates and caps of `tg` (gate 1, exit proof, 50,000-sat cap)
// still apply unchanged.
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
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BSV_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.OWNER_PORT ?? 4820)
const DASHBOARD = process.env.OWNER_DASHBOARD_URL ?? 'http://localhost:8765/'
const ORIGINS = new Set((process.env.OWNER_ORIGINS ?? 'http://localhost:8765,http://127.0.0.1:8765').split(',').map(s => s.trim()).filter(Boolean))
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const MAINNET = process.env.CONFIRM_MAINNET === '1'
const TOKEN = process.env.OWNER_TOKEN ?? randomBytes(18).toString('hex')
// The CLI that runs the actions. Default: this checkout's tsx on scripts/tg.ts. OWNER_TG_CMD (a JSON array) is for tests.
const TG_CMD = process.env.OWNER_TG_CMD ? JSON.parse(process.env.OWNER_TG_CMD) : [path.join(BSV_DIR, 'node_modules', '.bin', 'tsx'), path.join(BSV_DIR, 'scripts', 'tg.ts')]
const JOB_TIMEOUT_MS = 5 * 60_000 // BSV Desktop waits for the owner to approve
// Same caps as `tg fund`; `tg` enforces them again. The exit-proof evidence decides which one applies.
const EXIT_EVIDENCE = path.join(BSV_DIR, 'data', 'evidence', 'owner-exit.json')
const fundCap = () => (existsSync(EXIT_EVIDENCE) ? 50_000 : 5_000)

const jobs = new Map()
let running = null
let seq = 0

const tokenOk = (given) => {
  if (typeof given !== 'string' || given.length !== TOKEN.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN))
}

const summary = (j) => j && { id: j.id, kind: j.kind, sats: j.sats, state: j.state, startedAt: j.startedAt, endedAt: j.endedAt, txid: j.txid, message: j.message }

// The last meaningful line of the CLI's output: `tg` prints no keys, and only this line is passed on.
const lastLine = (text) => text.split('\n').map(s => s.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? ''

function startJob(kind, args, sats) {
  const job = { id: String(++seq), kind, sats, state: 'running', startedAt: new Date().toISOString(), endedAt: null, txid: null, message: 'Waiting for approval in BSV Desktop…' }
  jobs.set(job.id, job)
  if (jobs.size > 20) jobs.delete(jobs.keys().next().value)
  running = job
  const [cmd, ...pre] = TG_CMD
  const child = spawn(cmd, [...pre, kind, ...args], { cwd: BSV_DIR, env: { ...process.env, CONFIRM_MAINNET: MAINNET ? '1' : '' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d; const l = lastLine(out); if (l) job.message = l })
  child.stderr.on('data', (d) => { err += d })
  const timer = setTimeout(() => { job.message = 'Timed out waiting for BSV Desktop; nothing was confirmed by this server.'; child.kill('SIGTERM') }, JOB_TIMEOUT_MS)
  child.on('close', (code) => {
    clearTimeout(timer)
    const m = /(?:Funded|Owner exit): https:\/\/whatsonchain\.com\/tx\/([0-9a-f]{64})/.exec(out)
    job.txid = m ? m[1] : null
    job.state = code === 0 && job.txid ? 'done' : 'failed'
    if (job.state === 'failed') job.message = lastLine(err) || lastLine(out) || `tg ${kind} exited with code ${code}`
    else job.message = kind === 'fund' ? `Funded the vault with ${sats} sats.` : 'The owner took every vault coin back.'
    job.endedAt = new Date().toISOString()
    running = null
    console.log(`[owner] ${kind} ${job.state}${job.txid ? ` ${job.txid}` : ''}: ${job.message}`)
  })
  child.on('error', (e) => { job.state = 'failed'; job.message = `Could not start tg: ${e.message}`; job.endedAt = new Date().toISOString(); running = null })
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
      return send(res, 200, { ok: true, mainnetAllowed: MAINNET, fundCap: fundCap(), busy: summary(running), last: summary([...jobs.values()].at(-1)) }, allowed)
    }
    const jm = /^\/owner\/jobs\/(\d+)$/.exec(url)
    if (req.method === 'GET' && jm) {
      const j = jobs.get(jm[1])
      return j ? send(res, 200, summary(j), allowed) : send(res, 404, { error: 'no such job' }, allowed)
    }
    if (req.method === 'POST' && (url === '/owner/fund' || url === '/owner/exit')) {
      if (!allowed) return send(res, 403, { error: 'origin not allowed' })
      if ((req.headers['content-type'] ?? '').split(';')[0] !== 'application/json') return send(res, 415, { error: 'JSON only' }, allowed)
      if (!MAINNET) return send(res, 403, { error: 'Mainnet actions are off. Restart with CONFIRM_MAINNET=1 npm run owner-serve.' }, allowed)
      if (running) return send(res, 409, { error: 'Another owner action is still running.', job: summary(running) }, allowed)
      const body = await readBody(req)
      if (url === '/owner/fund') {
        const sats = body.sats
        const cap = fundCap()
        if (!Number.isSafeInteger(sats) || sats < 1 || sats > cap) return send(res, 400, { error: `sats must be a whole number from 1 to ${cap}` }, allowed)
        return send(res, 202, summary(startJob('fund', ['--sats', String(sats)], sats)), allowed)
      }
      if (body.confirm !== 'EXIT') return send(res, 400, { error: 'confirm must be "EXIT"' }, allowed)
      return send(res, 202, summary(startJob('exit', [], null)), allowed)
    }
    return send(res, 404, { error: 'not found' }, allowed)
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) }, allowed)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Owner actions on http://127.0.0.1:${PORT} (mainnet ${MAINNET ? 'ON' : 'OFF: start with CONFIRM_MAINNET=1'})`)
  console.log(`Allowed dashboard origins: ${[...ORIGINS].join(', ')}`)
  console.log(`Open the dashboard with this link (it carries the owner token; do not share it):`)
  console.log(`  ${DASHBOARD}?owner=${TOKEN}#owner`)
})
