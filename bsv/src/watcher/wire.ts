// How a withdrawal proposal travels between the agent and the watcher server: the raw
// transaction plus the raw source transaction of every input, so the watcher can read each
// input's script and value itself. Signatures travel as hex in checksig format.
import { Transaction, Utils } from '@bsv/sdk'

export interface WireProposal {
  intentId: string
  tx: string
  sources: Record<string, string>
  agentSignatures: string[]
}

export function encodeProposal(intentId: bigint, tx: Transaction, agentSignatures: number[][]): WireProposal {
  const sources: Record<string, string> = {}
  for (const input of tx.inputs) {
    if (input.sourceTransaction === undefined) throw new Error('every input needs its source transaction')
    sources[input.sourceTransaction.id('hex')] = input.sourceTransaction.toHex()
  }
  return { intentId: intentId.toString(), tx: tx.toHex(), sources, agentSignatures: agentSignatures.map(s => Utils.toHex(s)) }
}

export function decodeProposal(body: unknown): { intentId: bigint; tx: Transaction; agentSignatures: number[][] } {
  const b = body as Partial<WireProposal>
  if (typeof b?.intentId !== 'string' || !/^[0-9]+$/.test(b.intentId)) throw new Error('intentId must be a decimal string')
  if (typeof b.tx !== 'string' || typeof b.sources !== 'object' || b.sources === null) throw new Error('tx and sources are required')
  if (!Array.isArray(b.agentSignatures) || b.agentSignatures.some(s => typeof s !== 'string')) throw new Error('agentSignatures must be hex strings')
  const tx = Transaction.fromHex(b.tx)
  tx.inputs.forEach((input, i) => {
    const raw = b.sources![input.sourceTXID ?? '']
    if (typeof raw !== 'string') throw new Error(`source transaction of input ${i} is missing`)
    const source = Transaction.fromHex(raw)
    if (source.id('hex') !== input.sourceTXID) throw new Error(`source of input ${i} does not hash to ${input.sourceTXID}`)
    input.sourceTransaction = source
  })
  return { intentId: BigInt(b.intentId), tx, agentSignatures: b.agentSignatures.map(s => Utils.toArray(s, 'hex')) }
}

export function encodeSigned(intentId: bigint, tx: Transaction): { intentId: string; tx: string } {
  return { intentId: intentId.toString(), tx: tx.toHex() }
}
