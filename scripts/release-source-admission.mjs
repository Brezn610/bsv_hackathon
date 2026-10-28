import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXCEPTION_ID = '2026-10-27-674-experimental'
export const EXCEPTION_BASE = 'a6b6e352ab98b1fe5d7dce9fa834959ab260c71f'
export const EXCEPTION_FILE = 'governance/release-exceptions/2026-10-27-674.json'
export const EXCEPTION_PATHS = [
  '.github/workflows/release.yaml',
  '.github/workflows/infra-release.yaml',
  'scripts/release-source-admission.mjs',
  'scripts/release-source-admission.test.mjs',
  'scripts/package-release-artifacts.test.mjs',
  'scripts/ci-integration/mutation-workflows.test.mjs',
  'scripts/ci-integration/release-orchestration.test.mjs',
  EXCEPTION_FILE,
  'docs/reference/release-operations.md'
]

export function validateReleaseException({ id, source, environment, record, paths, now }) {
  if (id !== EXCEPTION_ID || record.id !== EXCEPTION_ID || record.sourceBase !== EXCEPTION_BASE)
    throw new Error('Unknown release exception or application source')
  if (
    !/^[a-f0-9]{40}$/.test(source) ||
    source !== environment.GITHUB_SHA ||
    environment.GITHUB_REF !== 'refs/heads/main' ||
    environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    environment.GITHUB_ACTOR !== 'ty-everett' ||
    record.owner !== 'ty-everett'
  )
    throw new Error('Exception requires the authorized manual main release')
  if (
    record.expiresAt !== '2026-10-29T00:00:00Z' ||
    !Number.isFinite(now) ||
    now >= Date.parse(record.expiresAt)
  )
    throw new Error('Release exception expired')
  if (!paths.length || paths.some(path => !EXCEPTION_PATHS.includes(path)))
    throw new Error('Application or release content changed outside the exact exception')
  return {
    sourceSha: source,
    sourceBase: EXCEPTION_BASE,
    admission: 'operator-waiver',
    exceptionId: id
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [id, source] = process.argv.slice(2)
  if (!/^[a-f0-9]{40}$/.test(source ?? '')) throw new Error('Expected exact source SHA')
  const git = (...args) => execFileSync('/usr/bin/git', args, { encoding: 'utf8' }).trim()
  git('merge-base', '--is-ancestor', EXCEPTION_BASE, source)
  const record = JSON.parse(git('show', `${source}:${EXCEPTION_FILE}`))
  const paths = git('diff', '--no-renames', '--name-only', EXCEPTION_BASE, source).split('\n')
  const result = validateReleaseException({
    id,
    source,
    environment: process.env,
    record,
    paths,
    now: Date.now()
  })
  console.log(
    JSON.stringify({ ...result, reason: record.reason, expiresAt: record.expiresAt }, null, 2)
  )
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `admitted-sha=${source}\nexception-id=${id}\n`)
}
