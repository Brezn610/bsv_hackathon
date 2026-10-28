import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { REPOSITORY_ROOT } from '../repository-health.mjs'

async function workflow(file) {
  const { parse } = await import('yaml')
  return parse(readFileSync(join(REPOSITORY_ROOT, '.github/workflows', file), 'utf8'))
}

test('one up-front approval gates npm and image publication without a late human wait', async () => {
  const release = await workflow('release.yaml')
  assert.equal(release.jobs.approve.environment, 'release-approval')
  assert.equal(release.jobs.approve.needs, undefined)
  assert.deepEqual(release.jobs.approve.permissions, {})
  // npm trusted publishing is bound to this environment name.
  assert.equal(release.jobs.publish.environment, 'npm-production')
  assert.ok(release.jobs.publish.needs.includes('approve'))
  assert.match(release.jobs.publish.if, /needs\.approve\.result == 'success'/)

  const infra = release.jobs.infra
  assert.equal(infra.uses, './.github/workflows/infra-release.yaml')
  assert.ok(infra.needs.includes('approve'))
  assert.match(infra.if, /needs\.approve\.result == 'success'/)
  assert.match(infra.if, /needs\.admission\.outputs\.admitted-sha == github\.sha/)
  assert.match(infra.if, /needs\.prepare\.outputs\.mode == 'cascade'/)
  assert.equal(infra.with['qualified-sha'], '${{ needs.full-mutation.outputs.qualified-sha }}')

  const sync = release.jobs['sync-versions']
  assert.ok(!sync.steps.some(step => /sleep 300/.test(step.run ?? '')))
  const checkout = sync.steps.find(step => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkout.with.ref, '${{ github.sha }}')
  assert.equal(sync.outputs['source-sha'], '${{ steps.source.outputs.source-sha }}')

  const infraRelease = await workflow('infra-release.yaml')
  assert.deepEqual(Object.keys(infraRelease.on.workflow_call.inputs).sort(), [
    'qualified-sha',
    'release-exception-id',
    'source-sha',
    'waived-sha'
  ])
  assert.match(infraRelease.jobs['post-release-verification'].if, /called == 'false'/)
})

test('a waived campaign still reaches every successful cascade continuation', async () => {
  const release = await workflow('release.yaml')
  for (const name of [
    'admission',
    'publish',
    'sync-versions',
    'infra',
    'post-release-verification'
  ]) {
    assert.match(release.jobs[name].if, /always\(\)/, `${name} must opt out of implicit success()`)
  }
  const sync = release.jobs['sync-versions']
  assert.match(sync.if, /!cancelled\(\)/)
  assert.match(sync.if, /needs\.prepare\.result == 'success'/)
  assert.match(sync.if, /needs\.publish\.result == 'success'/)
  const stage = release.jobs.prepare.steps.find(
    step => step.name === 'Stage exact npm release artifacts'
  )
  assert.equal(stage.env.RELEASE_EXCEPTION, '${{ steps.exception.outputs.exception-id }}')
  assert.match(stage.run, /--include-published/)
  assert.match(stage.run, /select\(\.releaseType != "none"\)/)
  assert.match(stage.run, /\$\{#released\[@\]\}.*!= 37/)
  assert.match(stage.run, /--package "\$name"/)
})

test('continuation stages exactly the approved release entries and rejects a changed set', async () => {
  const release = await workflow('release.yaml')
  const stage = release.jobs.prepare.steps.find(
    step => step.name === 'Stage exact npm release artifacts'
  )
  const root = mkdtempSync(join(tmpdir(), 'release-continuation-'))
  const notes = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'governance/package-release-notes.json'), 'utf8')
  )
  const expected = notes.entries
    .filter(entry => entry.releaseType !== 'none')
    .map(entry => entry.name)
  const bin = join(root, 'bin')
  const output = join(root, 'stage-arguments')
  mkdirSync(bin)
  mkdirSync(join(root, 'governance'))
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$STAGE_ARGUMENTS"\n')
  chmodSync(join(bin, 'node'), 0o700)
  const run = (exception, filter = '') =>
    spawnSync('/bin/bash', ['-e', '-c', stage.run], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PNPM_FILTER: filter,
        RELEASE_EXCEPTION: exception,
        GITHUB_OUTPUT: join(root, 'github-output'),
        STAGE_ARGUMENTS: output
      }
    })
  try {
    const file = join(root, 'governance/package-release-notes.json')
    writeFileSync(file, JSON.stringify(notes))
    assert.equal(expected.length, 37)
    const resumed = run('2026-10-27-674-experimental')
    assert.equal(resumed.status, 0, resumed.stderr)
    assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), [
      'scripts/package-release-artifacts.mjs',
      'stage',
      '--output',
      'release-artifacts',
      '--include-published',
      ...expected.flatMap(name => ['--package', name])
    ])
    assert.notEqual(run('2026-10-27-674-experimental', './packages/sdk').status, 0)
    notes.entries.find(entry => entry.name === expected[0]).releaseType = 'none'
    writeFileSync(file, JSON.stringify(notes))
    assert.notEqual(run('2026-10-27-674-experimental').status, 0)
    assert.equal(run('', './packages/sdk').status, 0)
    assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), [
      'scripts/package-release-artifacts.mjs',
      'stage',
      '--output',
      'release-artifacts',
      '--filter',
      './packages/sdk'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('jobs downstream of a deliberately skipped campaign opt out of implicit success()', async () => {
  // GitHub's implicit success() treats any skipped upstream job as blocking.
  // A release.yaml call skips infra-release's own full-mutation campaign, so
  // every job below it must use always() and check its direct needs itself.
  const infraRelease = await workflow('infra-release.yaml')
  const needs = job => [infraRelease.jobs[job].needs ?? []].flat()
  const downstream = new Set()
  const visit = job => {
    for (const [name] of Object.entries(infraRelease.jobs)) {
      if (needs(name).includes(job) && !downstream.has(name)) {
        downstream.add(name)
        visit(name)
      }
    }
  }
  visit('full-mutation')
  assert.ok(downstream.has('release'))
  for (const job of downstream) {
    const condition = String(infraRelease.jobs[job].if ?? '')
    assert.match(condition, /always\(\)/, `${job} must not inherit implicit success()`)
  }
  assert.match(infraRelease.jobs.release.if, /needs\.discover\.result == 'success'/)
  assert.match(infraRelease.jobs.release.if, /needs\.qualification\.result == 'success'/)
})

test('remaining image recovery keeps the normal approval and exact source gates', async () => {
  const infra = await workflow('infra-release.yaml')
  assert.deepEqual(Object.keys(infra.on.workflow_dispatch.inputs).sort(), [
    'release-exception-id',
    'source-sha'
  ])
  assert.equal(infra.jobs['approve-recovery'].environment, 'release-approval')
  assert.match(infra.jobs['approve-recovery'].if, /manual-recovery == 'true'/)
  assert.ok(infra.jobs.release.needs.includes('approve-recovery'))
  assert.match(infra.jobs.release.if, /needs\.approve-recovery\.result == 'success'/)
  const guard = infra.jobs.discover.steps.find(
    step => step.name === 'Verify trusted release source'
  ).run
  assert.match(guard, /infra-release\.yaml@refs\/heads\/main/)
  assert.match(guard, /2026-10-27-674-experimental/)
  assert.match(guard, /node scripts\/release-source-admission\.mjs/)
})

function git(cwd, ...arguments_) {
  return execFileSync('git', arguments_, { cwd, encoding: 'utf8' }).trim()
}

function commit(cwd, file, content) {
  mkdirSync(dirname(join(cwd, file)), { recursive: true })
  writeFileSync(join(cwd, file), content)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', file)
  return git(cwd, 'rev-parse', 'HEAD')
}

test('a release.yaml call accepts only the qualified commit or its infra-sync child', async () => {
  const infraRelease = await workflow('infra-release.yaml')
  const script = infraRelease.jobs.discover.steps.find(
    step => step.name === 'Verify trusted release source'
  ).run
  const root = mkdtempSync(join(tmpdir(), 'infra-source-'))
  try {
    const origin = join(root, 'origin.git')
    const work = join(root, 'work')
    git(root, 'init', '-q', '--bare', origin)
    git(root, 'init', '-q', '-b', 'main', work)
    git(work, 'config', 'user.email', 'test@example.com')
    git(work, 'config', 'user.name', 'test')
    git(work, 'remote', 'add', 'origin', origin)
    const release = commit(work, 'packages/a/src/index.ts', 'export {}\n')
    git(work, 'push', '-q', 'origin', 'main')

    git(work, 'switch', '-q', '-c', 'sync')
    const sync = commit(work, 'infra/wab/package-lock.json', '{}\n')
    const grandchild = commit(work, 'infra/wab/package.json', '{}\n')
    git(work, 'switch', '-q', '-c', 'tampered', release)
    const tampered = commit(work, 'infra/wab/src/index.ts', 'export {}\n')
    git(work, 'switch', '-q', '-c', 'product', release)
    const product = commit(work, 'packages/a/src/index.ts', 'export const x = 1\n')

    const run = (sourceSha, overrides = {}) => {
      const output = join(root, 'output')
      writeFileSync(output, '')
      const result = spawnSync('/bin/bash', ['-e', '-c', script], {
        cwd: work,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          EVENT_NAME: 'workflow_dispatch',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'bsv-blockchain/ts-stack',
          GITHUB_WORKFLOW_REF:
            'bsv-blockchain/ts-stack/.github/workflows/release.yaml@refs/heads/main',
          GITHUB_SHA: release,
          GITHUB_OUTPUT: output,
          SOURCE_SHA: sourceSha,
          QUALIFIED_SHA: release,
          ...overrides
        }
      })
      return { status: result.status, output: readFileSync(output, 'utf8') }
    }

    assert.equal(run(release).status, 0)
    const accepted = run(sync)
    assert.equal(accepted.status, 0)
    assert.match(accepted.output, new RegExp(`source-sha=${sync}`))
    assert.match(accepted.output, /called=true/)
    assert.notEqual(run(grandchild).status, 0)
    assert.notEqual(run(tampered).status, 0)
    assert.notEqual(run(product).status, 0)
    assert.notEqual(run(sync, { QUALIFIED_SHA: sync }).status, 0)
    assert.notEqual(
      run(sync, {
        GITHUB_WORKFLOW_REF: 'bsv-blockchain/ts-stack/.github/workflows/other.yml@refs/heads/main'
      }).status,
      0
    )

    const standalone = run('')
    assert.equal(standalone.status, 0)
    assert.match(standalone.output, /called=false/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('remaining image validator accepts only both version bumps with identical source and dependencies', async () => {
  const infra = await workflow('infra-release.yaml')
  const script = infra.jobs.discover.steps.find(
    step => step.name === 'Validate remaining hotfix image inputs'
  ).run
  const root = mkdtempSync(join(tmpdir(), 'remaining-image-inputs-'))
  try {
    const work = join(root, 'work')
    const origin = join(root, 'origin.git')
    git(root, 'init', '-q', '--bare', origin)
    git(root, 'init', '-q', '-b', 'main', work)
    git(work, 'config', 'user.email', 'test@example.com')
    git(work, 'config', 'user.name', 'test')
    git(work, 'remote', 'add', 'origin', origin)
    const versions = { 'message-box-server': '1.1.55', 'webrtpay-relay': '0.2.2' }
    for (const [name, version] of Object.entries(versions)) {
      mkdirSync(join(work, 'infra', name), { recursive: true })
      writeFileSync(
        join(work, 'infra', name, 'package.json'),
        JSON.stringify({ name, version, dependencies: { '@bsv/sdk': '^4.0.1' } })
      )
      writeFileSync(
        join(work, 'infra', name, 'package-lock.json'),
        JSON.stringify({
          name,
          version,
          packages: {
            '': { name, version },
            'node_modules/@bsv/sdk': { version: '4.0.1', integrity: 'sha512-fixture' }
          }
        })
      )
    }
    git(work, 'add', '.')
    git(work, 'commit', '-qm', 'original generated inputs')
    const original = git(work, 'rev-parse', 'HEAD')
    git(work, 'push', '-q', 'origin', 'main')
    const run = source =>
      spawnSync('/bin/bash', ['-e', '-c', script], {
        cwd: work,
        encoding: 'utf8',
        env: { ...process.env, SOURCE_SHA: source, ORIGINAL_SOURCE: original }
      })
    assert.notEqual(run(original).status, 0)
    for (const [name, version] of Object.entries({
      'message-box-server': '1.1.56',
      'webrtpay-relay': '0.2.3'
    })) {
      for (const file of ['package.json', 'package-lock.json']) {
        const path = join(work, 'infra', name, file)
        const record = JSON.parse(readFileSync(path, 'utf8'))
        record.version = version
        if (record.packages) record.packages[''].version = version
        writeFileSync(path, JSON.stringify(record))
      }
    }
    git(work, 'add', '.')
    git(work, 'commit', '-qm', 'two patch versions')
    const accepted = git(work, 'rev-parse', 'HEAD')
    const valid = run(accepted)
    assert.equal(valid.status, 0, valid.stderr)
    const file = join(work, 'infra/message-box-server/package.json')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    record.dependencies['@bsv/sdk'] = '^4.0.0'
    writeFileSync(file, JSON.stringify(record))
    git(work, 'add', '.')
    git(work, 'commit', '-qm', 'wrong dependency')
    assert.notEqual(run(git(work, 'rev-parse', 'HEAD')).status, 0)
    git(work, 'switch', '-q', '-c', 'product-change', accepted)
    const changed = commit(work, 'packages/a/src/index.ts', 'export const changed = true\n')
    assert.notEqual(run(changed).status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
