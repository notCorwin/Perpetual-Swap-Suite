import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachOperationSink, type OperationEvent } from '../electron/services/operations.js'
import { networkResource, recordedWebSocketFactory } from '../electron/services/network-operations.js'
import { MarketService } from '../electron/services/market-service.js'

class Socket extends EventTarget {
  readyState = 0
  #sent: string[] = []
  get sent() { return this.#sent }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  send(data: string) { if (this.readyState !== 1) throw new Error('Closed.'); this.#sent.push(data) }
  close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, wasClean: true })) }
}

test('WebSocket records every transport action with byte counts and preserves native method receivers', t => {
  const entries: OperationEvent[] = [], off = attachOperationSink(entry => entries.push(entry))
  t.after(off)
  const raw = new Socket(), socket = recordedWebSocketFactory(() => raw, 'test')('wss://user:password@example.com/feed?token=secret#fragment')
  raw.open()
  let receives = 0
  const listener = () => { receives++ }
  socket.addEventListener('message', listener)
  for (const data of ['你好', new Uint8Array([1, 2, 3]), new Blob(['四'])]) raw.dispatchEvent(new MessageEvent('message', { data }))
  socket.removeEventListener('message', listener)
  raw.dispatchEvent(new MessageEvent('message', { data: 'ping' }))
  socket.send('你好')
  socket.close()
  assert.equal(receives, 3)
  assert.deepEqual(raw.sent, ['你好'])
  assert.equal(entries.filter(entry => entry.name === 'websocket.connect').length, 1)
  assert.deepEqual(entries.filter(entry => entry.name === 'websocket.receive').map(entry => entry.attributes?.bytes), [6, 3, 3, 4])
  assert.equal(entries.find(entry => entry.name === 'websocket.send')?.attributes?.bytes, 6)
  assert.ok(entries.every(entry => entry.status === 'ok' && entry.resource === 'wss://example.com/feed'))
  assert.doesNotMatch(JSON.stringify(entries), /password|token|secret|fragment|你好/)
  assert.equal(networkResource('invalid URL'), 'unknown')
})

test('WebSocket failures, abandoned connections and already-open injected sockets always finish', t => {
  const entries: OperationEvent[] = [], off = attachOperationSink(entry => entries.push(entry))
  t.after(off)
  assert.throws(() => recordedWebSocketFactory(() => { throw new Error('private detail') }, 'test')('wss://example.com/factory'))
  const failed = new Socket(), transport = recordedWebSocketFactory(() => failed, 'test')('wss://example.com/failed')
  failed.dispatchEvent(new Event('error'))
  assert.throws(() => transport.send('private detail'))
  transport.close()
  const abandoned = recordedWebSocketFactory(() => new Socket(), 'test')('wss://example.com/abandoned')
  abandoned.close()
  const ready = new Socket()
  ready.open()
  const opened = recordedWebSocketFactory(() => ready, 'test')('wss://example.com/ready')
  ready.dispatchEvent(new Event('open'))
  opened.close()
  assert.deepEqual(entries.filter(entry => entry.name === 'websocket.connect').map(entry => entry.status), ['error', 'error', 'cancelled', 'ok'])
  assert.equal(entries.find(entry => entry.name === 'websocket.send')?.status, 'error')
  assert.doesNotMatch(JSON.stringify(entries), /private detail/)
})

// Exercise the physical HTTP boundary without starting market background work.
function request(fetcher: typeof fetch, controller = new AbortController(), timeout = 1_000) {
  const service = Object.assign(Object.create(MarketService.prototype), { fetcher, requestTimeout: timeout, disposed: false })
  const lane = { name: 'candles', interval: 0, concurrency: 4, rateLimitedUntil: 0 }
  const result = new Promise((resolve, reject) => {
    void service.performRequest(lane, { path: '/market/history-candles', parameters: { instId: 'BTC-USDT-SWAP', privateValue: 'secret' }, priority: 'foreground', bucket: lane, enqueuedAt: Date.now(), controller, cleaned: true, resolve, reject })
  })
  return result
}

test('HTTP records actual attempts through JSON completion with safe response facts', async t => {
  const entries: OperationEvent[] = [], off = attachOperationSink(entry => entries.push(entry))
  t.after(off)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const task = request(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': '123' }),
    json: async () => { await gate; return { code: '0', data: [['private payload']] } },
  }) as Response)
  await Promise.resolve(); await Promise.resolve()
  assert.equal(entries.length, 0, 'Headers alone do not finish the network operation.')
  release()
  assert.deepEqual(await task, [['private payload']])
  await assert.rejects(request(async () => new Response('rate limited', { status: 429 })))
  await assert.rejects(request(async () => new Response('invalid JSON', { status: 200 })))
  assert.deepEqual(entries.map(entry => entry.status), ['ok', 'error', 'error'])
  assert.equal(entries[0].attributes?.rows, 1)
  assert.equal(entries[0].attributes?.httpStatus, 200)
  assert.equal(entries[0].attributes?.declaredResponseBytes, 123)
  assert.ok(entries.every(entry => entry.resource === 'https://www.okx.com/api/v5/market/history-candles'))
  assert.doesNotMatch(JSON.stringify(entries), /secret|private payload/)
})

test('HTTP abort finishes even when a transport ignores its signal; preempted work creates no request', async t => {
  const entries: OperationEvent[] = [], off = attachOperationSink(entry => entries.push(entry))
  t.after(off)
  const controller = new AbortController()
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const task = request(() => { started(); return new Promise<Response>(() => {}) }, controller)
  await entered
  controller.abort()
  await assert.rejects(task)
  assert.deepEqual(entries.map(entry => entry.status), ['cancelled'])
  const preempted = new AbortController()
  preempted.abort()
  await assert.rejects(request(() => { throw new Error('Must not fetch.') }, preempted))
  assert.equal(entries.length, 1)
})

test('HTTP timeouts are failed requests even when the underlying response arrives later', async t => {
  const entries: OperationEvent[] = [], off = attachOperationSink(entry => entries.push(entry))
  t.after(off)
  let release!: () => void
  const gate = new Promise<Response>(resolve => { release = () => resolve(Response.json({ code: '0', data: [] })) })
  const keepAlive = setTimeout(() => release(), 100)
  t.after(() => { clearTimeout(keepAlive); release() })
  await assert.rejects(request(() => gate, new AbortController(), 5), /timed out/)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].status, 'error')
  assert.equal(entries[0].attributes?.timedOut, true)
  release()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(entries.length, 1, 'A late response cannot finish the same attempt twice.')
})

test('HTTP service failures preserve Retry-After delays and dates for shared source backoff', async t => {
  const now = Date.UTC(2026, 9, 23, 12)
  t.mock.method(Date, 'now', () => now)
  for (const header of ['120', new Date(now + 120_000).toUTCString()]) {
    await assert.rejects(request(async () => new Response('Unavailable', { status: 503, headers: { 'Retry-After': header } })),
      (error: Error & { retryAfter?: number }) => /503/.test(error.message) && error.retryAfter === 120_000)
  }
})
