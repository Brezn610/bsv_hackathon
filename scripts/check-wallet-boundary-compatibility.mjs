import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { createCommandRunner } from './lib/command-runner.mjs'

// Exercise immutable published clients against the packed candidate in both
// directions. The defective 4.0.0 encoding is repaired, not a supported profile.
const root = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'ts-stack-wallet-boundary-'))
const execute = createCommandRunner({ timeoutMs: 180000, maxBufferBytes: 16 * 1024 * 1024 })
const run = (command, args, cwd) =>
  execute(command, args, {
    cwd,
    env: { ...process.env, npm_config_ignore_scripts: 'true' }
  })

try {
  const tarballs = join(temp, 'tarballs')
  await mkdir(tarballs)
  const { stdout } = await run(
    'pnpm',
    ['pack', '--json', '--pack-destination', tarballs],
    join(root, 'packages/sdk')
  )
  const artifact = resolve(JSON.parse(stdout).filename)
  assert.ok(
    artifact.startsWith(tarballs + '/'),
    'Packed SDK must remain inside the artifact directory'
  )
  const workspace = parse(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(root, 'packages/sdk/package.json'), 'utf8'))
  await writeFile(
    join(temp, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        'sdk-v2': 'npm:@bsv/sdk@2.8.11',
        'sdk-v3': 'npm:@bsv/sdk@3.2.1',
        'sdk-candidate': 'file:' + artifact,
        '@types/node': manifest.devDependencies['@types/node']
      }
    })
  )
  await writeFile(
    join(temp, 'pnpm-workspace.yaml'),
    JSON.stringify({
      minimumReleaseAge: workspace.minimumReleaseAge,
      minimumReleaseAgeExclude: workspace.minimumReleaseAgeExclude
    })
  )
  await run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], temp)
  const require = createRequire(join(temp, 'package.json'))
  const versions = {
    '2.8.11': require('sdk-v2'),
    '3.2.1': require('sdk-v3'),
    candidate: require('sdk-candidate')
  }
  const output = {
    outpoint: '11'.repeat(32) + '.0',
    satoshis: 1,
    spendable: true,
    lockingScript: '51',
    customInstructions: 'legacy ✓',
    tags: ['tag'],
    labels: ['label']
  }
  const listing = {
    basket: 'default',
    include: 'locking scripts',
    includeCustomInstructions: true,
    includeTags: true,
    includeLabels: true,
    limit: 10
  }
  const observations = []
  for (const [serverVersion, serverSDK] of Object.entries(versions)) {
    const backend = {
      getVersion: async () => ({ version: 'wallet-brc100-1.0.0' }),
      listOutputs: async args => {
        if (args.basket === 'p historical balance savings' || args.basket === 'balance savings') {
          return { totalOutputs: 180, outputs: [] }
        }
        return {
          totalOutputs: args.basket === 'empty' ? 0 : 1,
          outputs: args.basket === 'empty' ? [] : [structuredClone(output)]
        }
      }
    }
    const wallet = new serverSDK.WalletClient(backend)
    const server = http.createServer(async (req, res) => {
      try {
        assert.equal(req.method, 'POST')
        const method = req.url.slice(1)
        assert.ok(['listOutputs', 'getVersion'].includes(method))
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const result = await wallet[method](JSON.parse(Buffer.concat(chunks).toString()))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ isError: true, message: error.message, code: error.code ?? 1 }))
      }
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      for (const [clientVersion, clientSDK] of Object.entries(versions)) {
        if (clientVersion !== 'candidate' && serverVersion !== 'candidate') continue
        const clients = {
          wire: new clientSDK.WalletClient(
            new clientSDK.WalletWireTransceiver(new serverSDK.WalletWireProcessor(backend))
          ),
          json: new clientSDK.WalletClient(
            new clientSDK.HTTPWalletJSON(
              'compatibility.example',
              `http://127.0.0.1:${server.address().port}`
            )
          )
        }
        for (const [transport, client] of Object.entries(clients)) {
          for (const scenario of ['ordinary', 'empty', 'balance', 'module-balance', 'version']) {
            if (scenario === 'version') {
              assert.deepEqual(await client.getVersion({}), { version: 'wallet-brc100-1.0.0' })
            } else {
              const args =
                scenario === 'balance'
                  ? { basket: 'balance savings' }
                  : scenario === 'module-balance'
                    ? { basket: 'p historical balance savings' }
                    : scenario === 'empty'
                      ? { basket: 'empty' }
                      : listing
              const result = await client.listOutputs(args)
              assert.equal(typeof result.totalOutputs, 'number')
              assert.equal(
                result.totalOutputs,
                scenario.includes('balance') ? 180 : scenario === 'empty' ? 0 : 1
              )
              assert.deepEqual(result.outputs, scenario === 'ordinary' ? [output] : [])
            }
            observations.push({ client: clientVersion, wallet: serverVersion, transport, scenario })
          }
        }
      }
    } finally {
      await new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    }
  }
  // Both ESM and CommonJS declarations must still allow established arithmetic.
  for (const extension of ['mts', 'cts']) {
    await writeFile(
      join(temp, 'numeric.' + extension),
      ['sdk-v2', 'sdk-v3', 'sdk-candidate']
        .map(
          (name, index) => `
import type { ListOutputsResult as Result${index} } from '${name}'
declare const result${index}: Result${index}
const total${index}: number = result${index}.totalOutputs + 1
void total${index}
`
        )
        .join('\n') +
        `
import type { DecimalString } from 'sdk-candidate'
const retainedAlias: DecimalString = '180'
void retainedAlias
`
    )
  }
  await writeFile(
    join(temp, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2024',
        types: ['node']
      },
      include: ['numeric.mts', 'numeric.cts']
    })
  )
  await run(
    join(root, 'packages/sdk/node_modules/.bin/tsc'),
    ['--project', join(temp, 'tsconfig.json'), '--pretty', 'false'],
    temp
  )
  console.log(
    JSON.stringify({
      passed: observations.length,
      observations,
      numericConsumers: ['ESM', 'CommonJS']
    })
  )
} finally {
  await rm(temp, { recursive: true, force: true })
}
