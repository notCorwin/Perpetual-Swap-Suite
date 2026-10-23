import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'
import { evaluateLiquidity, type LiquidityInput } from '../electron/services/liquidity.js'

const instId = 'BTC-USDT-SWAP'
const instrument = { instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC', ruleType: 'normal' }
const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
class Socket extends EventTarget {
  readyState = 0
  sent: { op: string; id: string; args: { channel: string }[] }[] = []
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  send(raw: string) {
    if (raw === 'ping') { this.dispatchEvent(new MessageEvent('message', { data: 'pong' })); return }
    const command = JSON.parse(raw)
    this.sent.push(command)
    for (const arg of command.args) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, event: command.op, arg }) })))
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
}
const settle = async (service: MarketService) => {
  do {
    await setImmediate()
    await Promise.allSettled([...service.backgroundTasks, ...service.candidateTasks.values()])
  } while (service.backgroundTasks.size || service.candidateTasks.size || service.refreshing)
}
const fixture = async (automatic = false, bookSource?: () => Promise<Response>) => {
  const preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const condition of Object.values(preferences.liquidity)) condition.enabled = false
  preferences.liquidity.spread.enabled = true
  const root = await mkdtemp(join(tmpdir(), 'perp-network-reuse-')), store = await MarketStore.open(root)
  const requests: string[] = [], sockets: Socket[] = []
  const service = new MarketService(store, () => preferences, async input => {
    const path = new URL(String(input)).pathname
    requests.push(path)
    if (path.endsWith('/public/instruments')) return response([instrument])
    if (path.endsWith('/market/tickers')) return response([{ instId, last: '100', bidPx: '99.99', askPx: '100' }])
    if (path.endsWith('/market/books')) return bookSource ? bookSource() : response([{ ts: String(Date.now()), bids: [['99.99', '200001']], asks: [['100', '200001']] }])
    if (path.endsWith('/public/open-interest')) return response([{ instId, oiUsd: '6000000', ts: String(Date.now()) }])
    throw new Error(`Unexpected source request: ${path}`)
  }, automatic, { webSocketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket } })
  service.projectListEntry = async () => null
  service.updateRanking = async () => undefined
  service.scheduleListProjection = () => undefined
  await service.ready
  for (const lane of service.requestLanes.values()) lane.interval = 0
  return { service, preferences, requests, sockets, async close() { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('automatic threshold changes reuse fresh REST metadata, ticker, book and OI without source requests', async () => {
  const f = await fixture()
  try {
    f.preferences.liquidity.depth.enabled = true
    f.preferences.liquidity.openInterest.enabled = true
    await f.service.refresh()
    const requests = [...f.requests], observations = structuredClone(f.service.observations.get(instId))
    f.service.autoRefresh = true
    const previous = structuredClone(f.preferences)
    f.preferences.liquidity.depth.minUSDT += 1000
    await f.service.reconfigure(previous)
    await settle(f.service)
    assert.deepEqual(f.requests, requests)
    assert.deepEqual(f.service.observations.get(instId), observations, 'Reuse cannot renew source timestamps or expiry.')
    assert.equal(f.service.catalog.get(instId)?.status, 'verified')
  } finally { await f.close() }
})

test('enabling a condition acquires only its missing source and shares existing market observations', async () => {
  const f = await fixture()
  try {
    await f.service.refresh()
    const before = f.requests.length
    f.service.autoRefresh = true
    const previous = structuredClone(f.preferences)
    f.preferences.liquidity.depth.enabled = true
    await f.service.reconfigure(previous)
    await settle(f.service)
    assert.deepEqual(f.requests.slice(before), ['/api/v5/market/books'])
    assert.equal(f.service.catalog.get(instId)?.status, 'verified')
  } finally { await f.close() }
})

test('normal startup waits for the instruments ack and obtains one authoritative snapshot', async () => {
  const f = await fixture(true)
  try {
    await setImmediate()
    assert.equal(f.requests.filter(path => path.endsWith('/public/instruments')).length, 0)
    f.sockets[0].open()
    await f.service.publicRealtime.whenIdle()
    await settle(f.service)
    assert.equal(f.service.instrumentStream.synchronized, true)
    assert.equal(f.requests.filter(path => path.endsWith('/public/instruments')).length, 1)
    const previous = structuredClone(f.preferences)
    f.preferences.liquidity.spread.maxPercent = 0.04
    await f.service.reconfigure(previous)
    await settle(f.service)
    assert.equal(f.requests.filter(path => path.endsWith('/public/instruments')).length, 1)
  } finally { await f.close() }
})

test('failed control transport permits REST startup without waiting for a subscription', async () => {
  const f = await fixture(true)
  try {
    f.sockets[0].dispatchEvent(new Event('error'))
    await settle(f.service)
    assert.equal(f.requests.filter(path => path.endsWith('/public/instruments')).length, 1)
    assert.equal(f.service.catalog.get(instId)?.status, 'verified')
    assert.equal(f.service.instrumentStream, null)
  } finally { await f.close() }
})

test('candidate cancellation leaves its shared order-book acquisition available to source recovery', async () => {
  let started!: () => void, release!: (value: Response) => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<Response>(resolve => { release = resolve })
  const f = await fixture(false, () => { started(); return held })
  let refreshing: Promise<void> | undefined
  try {
    f.preferences.liquidity.depth.enabled = true
    refreshing = f.service.refresh()
    await entered
    f.service.autoRefresh = true
    f.service.recoverRequiredSources(instId)
    const recovery = f.service.sourceRecoveries.get(`${instId}:book`)
    assert.ok(recovery)
    const repairing = f.service.repairRequiredSource(recovery)
    await setImmediate()
    f.service.refreshController.abort()
    release(response([{ ts: String(Date.now()), bids: [['99.99', '200001']], asks: [['100', '200001']] }]))
    await Promise.all([refreshing, repairing])
    assert.equal(f.requests.filter(path => path.endsWith('/market/books')).length, 1)
    assert.ok(f.service.observations.get(instId).book.expiresAt > Date.now())
    assert.equal(f.service.sourceRecoveries.has(`${instId}:book`), false)
  } finally { release(response([])); await refreshing; await f.close() }
})

test('book channel recovery immediately retires its cached qualification without reconnecting healthy channels', async () => {
  const f = await fixture(true)
  try {
    f.preferences.liquidity.depth.enabled = true
    f.sockets[0].open()
    await f.service.publicRealtime.whenIdle()
    await settle(f.service)
    const socket = f.sockets[0]
    const emit = (action: string, data: object) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ arg: { channel: 'books', instId }, action, data: [data] }) }))
    emit('snapshot', { ts: String(Date.now()), seqId: 1, prevSeqId: -1, bids: [['99.99', '200001']], asks: [['100', '200001']] })
    await f.service.publicRealtime.whenIdle()
    assert.equal(f.service.observations.get(instId).book.source, 'websocket')
    let held!: { input: LiquidityInput; resolve: (value: ReturnType<typeof evaluateLiquidity>) => void }
    f.service.streamLiquidity = { evaluate: (input: LiquidityInput) => new Promise(resolve => { held = { input, resolve } }), close: async () => undefined }
    f.service.flushStreamQualifications()
    assert.ok(held)
    emit('update', { ts: String(Date.now()), seqId: 3, prevSeqId: 2, bids: [], asks: [] })
    await f.service.publicRealtime.whenIdle()
    held.resolve(evaluateLiquidity(held.input))
    await Promise.all([...f.service.streamEvaluations.values()])
    assert.equal(f.service.observations.get(instId).book, undefined)
    assert.deepEqual(f.service.listRowsFor('15m'), [])
    assert.equal(socket.readyState, 1)
    assert.equal(f.service.catalogChecks.get(instId).status, 'unknown')
  } finally { await f.close() }
})
