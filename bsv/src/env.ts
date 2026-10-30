// Loads the environment file (gitignored) into process.env, so root keys stay out of code and shell
// history. TG_ENV_FILE / TG_DATA_DIR point at an existing rail checkout's .env and wallet data
// (the mainnet agent and merchant wallets), so keys are never copied around.
import path from 'node:path'
import { existsSync } from 'node:fs'

export const RAIL_DIR = path.join(__dirname, '..')
export const DATA_DIR = process.env.TG_DATA_DIR ?? path.join(RAIL_DIR, 'data')
export const ENV_FILE = process.env.TG_ENV_FILE ?? path.join(RAIL_DIR, '.env')
/** Treasury Guard's own state: binding, vault UTXOs, watcher journal, receipts. Never a key. */
export const STATE_DIR = path.join(RAIL_DIR, 'data')
/** The watcher's key lives in its own file, so the agent's environment never contains it. */
export const WATCHER_ENV_FILE = path.join(RAIL_DIR, '.env.watcher')

export function loadEnv(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)
}

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set. Run npm run keys:init first.`)
  return value
}
