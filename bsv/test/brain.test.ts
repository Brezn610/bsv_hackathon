// The agent's purchase decision, with a stub in place of the Claude client: a model "buy" and
// "don't buy" are passed through, anything unexpected (refusal, garbage, an error) means no
// purchase, and without credentials the labelled rules decide.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decidePurchase, type PaidOffer } from '../src/agent/brain'

const OFFER: PaidOffer = { merchant: 'research.treasuryguard.dev', item: 'research note', description: 'One paid research answer', priceSats: 1_000 }
const CTX = { task: 'Summarise BSV fee levels for the treasury report', floatSats: 2_000, maxPerPaymentSats: 2_000 }

function stub(reply: { stop_reason: string; text?: string } | Error) {
  const calls: unknown[] = []
  const client = {
    beta: {
      messages: {
        create: async (args: unknown) => {
          calls.push(args)
          if (reply instanceof Error) throw reply
          return { stop_reason: reply.stop_reason, content: reply.text === undefined ? [] : [{ type: 'text', text: reply.text }] }
        }
      }
    }
  }
  return { client: client as never, calls }
}

test("Claude's buy and don't-buy decisions are passed through, with its reason", async () => {
  const yes = stub({ stop_reason: 'end_turn', text: JSON.stringify({ buy: true, reason: 'The note answers the task at a small price.' }) })
  const d1 = await decidePurchase(OFFER, CTX, { client: yes.client, useClaude: true })
  assert.deepEqual([d1.buy, d1.decidedBy, d1.reason], [true, 'claude', 'The note answers the task at a small price.'])
  const sent = yes.calls[0] as { model: string; fallbacks: string; output_config: { format: { type: string } } }
  assert.equal(sent.model, 'claude-opus-5-5')
  assert.equal(sent.fallbacks, 'default')
  assert.equal(sent.output_config.format.type, 'json_schema')

  const no = stub({ stop_reason: 'end_turn', text: JSON.stringify({ buy: false, reason: 'Unrelated to the task.' }) })
  assert.equal((await decidePurchase(OFFER, CTX, { client: no.client, useClaude: true })).buy, false)
})

test('a refusal, a malformed answer or an API error means no purchase', async () => {
  for (const reply of [{ stop_reason: 'refusal' }, { stop_reason: 'end_turn', text: '{"buy":"yes"}' }, { stop_reason: 'end_turn', text: 'not json' }, new Error('timeout')]) {
    const d = await decidePurchase(OFFER, CTX, { client: stub(reply).client, useClaude: true })
    assert.equal(d.buy, false, JSON.stringify(reply))
  }
})

test('with only a DeepSeek key, DeepSeek decides through its JSON mode; its errors mean no purchase', async () => {
  let sent: { url: string; body: { model: string; response_format: { type: string } }; auth: string } | undefined
  const ok = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ buy: true, reason: 'Fits the task.' }) } }] }))
  }) as unknown as typeof fetch
  const d = await decidePurchase(OFFER, CTX, { useClaude: false, deepseekKey: 'test-key', fetchFn: ok })
  assert.deepEqual([d.buy, d.decidedBy, d.reason], [true, 'deepseek', 'Fits the task.'])
  assert.equal(sent?.body.response_format.type, 'json_object')
  assert.equal(sent?.auth, 'Bearer test-key')
  const down = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch
  assert.equal((await decidePurchase(OFFER, CTX, { useClaude: false, deepseekKey: 'k', fetchFn: down })).buy, false)
})

test('without credentials the labelled rules decide', async () => {
  const d = await decidePurchase(OFFER, CTX, { useClaude: false, deepseekKey: '' })
  assert.deepEqual([d.buy, d.decidedBy], [true, 'rules'])
  assert.equal((await decidePurchase({ ...OFFER, priceSats: 5_000 }, CTX, { useClaude: false, deepseekKey: '' })).buy, false)
})
