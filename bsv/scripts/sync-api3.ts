// Copies what the watcher needs from the API3 workspace: the TreasuryGuard ABI entries it reads,
// straight from api3/src/client/abi.ts (itself generated from the forge build). Addresses and
// vault IDs are not copied: the watcher reads api3/deployments.json at runtime.
// Run after every API3 interface change: npm run sync:api3. test/api3-readonly.test.ts fails on drift.
import { writeFileSync } from 'node:fs'
import path from 'node:path'

export const ABI_ENTRIES = ['getIntent', 'getVaultConfig', 'remainingUsdToday', 'regime', 'lastPrice', 'IntentCreated', 'Settled']
export const ABI_FILE = path.join(__dirname, '..', 'src', 'api3', 'treasuryGuard.abi.json')

export async function api3Abi(): Promise<unknown[]> {
  // A runtime path: the API3 workspace is ESM TypeScript with its own compiler settings.
  const spec = '../../api3/src/client/abi.ts'
  const mod = (await import(spec)) as { treasuryGuardAbi: Array<{ name?: string }> }
  return mod.treasuryGuardAbi.filter(e => e.name !== undefined && ABI_ENTRIES.includes(e.name))
}

if (require.main === module) {
  api3Abi().then(abi => {
    writeFileSync(ABI_FILE, JSON.stringify(abi, null, 2) + '\n')
    console.log(`Wrote ${abi.length} ABI entries to ${ABI_FILE}`)
  }).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
