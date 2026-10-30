// The agent's handle on a watcher server: the same cosign / recordBroadcast interface as the
// in-process Watcher, so flow/withdraw.ts does not change. The agent signs the proposal itself
// (the server refuses proposals without valid agent signatures); it never sees the watcher key.
import { Utils, type Transaction } from '@bsv/sdk'
import { agentSignatures } from '../vault/proposeSpend'
import type { VaultSigner } from '../vault/template'
import type { CosignResult } from './service'
import { encodeProposal, encodeSigned } from './wire'

export const DEFAULT_WATCHER_URL = 'http://127.0.0.1:4810'

export class RemoteWatcher {
  constructor(
    private readonly url: string,
    private readonly agent: VaultSigner,
    // Long: the watcher re-reads Base and WhatsOnChain, and giving up early does not stop it from signing.
    private readonly timeoutMs = 300_000
  ) {}

  async health(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`watcher /health answered HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }

  async cosign(intentId: bigint, tx: Transaction): Promise<CosignResult> {
    const body = encodeProposal(intentId, tx, await agentSignatures(this.agent, tx))
    let res: Response
    try {
      res = await fetch(`${this.url}/cosign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (err) {
      // The watcher may have finished and journaled 'signed' after the connection was lost: not a safe retry.
      return { decision: { verdict: 'DENY', reasons: [`watcher unreachable: ${(err as Error).message}. It may still have signed: check ${this.url}/decisions before retrying; if this intent is there as APPROVE, its vault outpoints are claimed`] } }
    }
    const answer = (await res.json().catch(() => undefined)) as { decision?: CosignResult['decision']; signatures?: string[]; error?: string } | undefined
    if (res.status === 200 && answer?.decision?.verdict === 'APPROVE' && Array.isArray(answer.signatures)) {
      return { decision: answer.decision, signatures: answer.signatures.map(s => Utils.toArray(s, 'hex')) }
    }
    return { decision: answer?.decision ?? { verdict: 'DENY', reasons: [`watcher answered HTTP ${res.status}: ${answer?.error ?? 'no reason'}`] } }
  }

  async recordBroadcast(intentId: bigint, tx: Transaction): Promise<void> {
    const res = await fetch(`${this.url}/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(encodeSigned(intentId, tx)),
      signal: AbortSignal.timeout(this.timeoutMs)
    })
    if (!res.ok) throw new Error(`watcher refused to record the broadcast: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`)
  }
}
