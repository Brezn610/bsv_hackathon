// ensureBroadcast: a transaction BSV Desktop returned but the network does not know is posted again, once.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Beef } from '@bsv/sdk'
import { ensureBroadcast } from '../src/chain/ensureBroadcast'

const TXID = 'a5ed5ffaa450f5d51e78dfd4d956bd55ae4076a0af23c2f1011ffe485cd5f23e'

test('already on the network: nothing is posted', async () => {
  let posts = 0
  const state = await ensureBroadcast(new Beef(), TXID, { gapMs: 1, seen: async () => true, post: async () => { posts++; return [] } })
  assert.equal(state, 'seen')
  assert.equal(posts, 0)
})

test('missing: posted once, then seen', async () => {
  let posts = 0
  const state = await ensureBroadcast(new Beef(), TXID, { gapMs: 1, seen: async () => posts > 0, post: async () => { posts++; return [{ status: 'success' }] } })
  assert.equal(state, 'posted')
  assert.equal(posts, 1)
})

test('still missing after posting, or the post throws: unseen, no throw', async () => {
  let posts = 0
  const state = await ensureBroadcast(new Beef(), TXID, { gapMs: 1, seen: async () => false, post: async () => { posts++; throw new Error('ARC down') } })
  assert.equal(state, 'unseen')
  assert.equal(posts, 1)
})
