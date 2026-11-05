import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createNativeBroker } from './native-broker.mjs'
const { NativeClient } = createRequire(import.meta.url)('./native-client.cjs')

test('native RPC preserves JSON payloads, out-of-order replies, and notifications', async () => {
  const broker = await createNativeBroker({ token: 'owned-test-token', dispatch: async (path, value) => {
    if (path === 'slow') await new Promise(done => setTimeout(done, 20))
    return JSON.stringify({ path, value })
  } })
  const client = new NativeClient(broker.path, 'owned-test-token')
  try {
    await client.ready
    const event = new Promise(resolve => client.subscribe(resolve))
    await client.request('connect', '{}')
    const slow = client.request('slow', '{"text":"雪","numbers":[0,1.25,null]}')
    assert.deepEqual(JSON.parse(await client.request('fast', '{}')), { path: 'fast', value: {} })
    assert.deepEqual(JSON.parse(await slow).value, { text: '雪', numbers: [0, 1.25, null] })
    broker.send('{"channel":"chart","detail":"unchanged"}')
    assert.deepEqual(JSON.parse(await event), { channel: 'chart', detail: 'unchanged' })
  } finally { client.close(); await broker.close() }
})

test('a wrong token cannot issue native requests', async () => {
  let dispatched = false
  const broker = await createNativeBroker({ token: 'correct-token', dispatch: async () => { dispatched = true; return '{}' } })
  const client = new NativeClient(broker.path, 'wrong-token')
  try { await client.ready; await assert.rejects(client.request('request', '{}')); assert.equal(dispatched, false) }
  finally { client.close(); await broker.close() }
})
