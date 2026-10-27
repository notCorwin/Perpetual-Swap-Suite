import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'
import { OKX_BUSINESS_WEBSOCKET_URL, type RealtimeWebSocket } from '../electron/services/realtime-market.js'
import { OKX_PUBLIC_WEBSOCKET_URL } from '../electron/services/realtime-public-market.js'

const instrument = (symbol = 'BTC') => ({ instId: `${symbol}-USDT-SWAP`, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', ctVal: '0.01', ctMult: '1', ctValCcy: symbol, ruleType: 'normal', state: 'live' })
const ticker = (instId: string, bidPx?: string) => ({ instId, last: '100', bidPx: bidPx ?? '99.99', askPx: '100', ts: String(Date.now()) })
const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const waitFor = async (condition: () => boolean, timeout = 3_000) => {
  const deadline = performance.now() + timeout
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for network demand reconciliation.')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const preferences = (...enabled: (keyof typeof DEFAULT_PREFERENCES.liquidity)[]) => {
  const value = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(value.liquidity)) rule.enabled = false
  for (const key of enabled) value.liquidity[key].enabled = true
  return value
}
type Subscription = { channel: string; instId: string }
const keyFor = ({ channel, instId }: Subscription) => `${channel}:${instId}`
const failedSlippageBook = () => ({
  asks: [['100', '1'], ...Array.from({ length: 400 }, (_, index) => [(100.2 + index * 0.0001).toFixed(4), '1000'])],
  bids: [['99.99', '1'], ...Array.from({ length: 400 }, (_, index) => [(99.79 - index * 0.0001).toFixed(4), '1000'])],
  ts: String(Date.now()), seqId: 1, prevSeqId: -1,
})

class Socket extends EventTarget implements RealtimeWebSocket {
  readyState = 0
  subscriptions = new Map<string, Subscription>()
  sent: string[] = []
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })) }
  send(value: string) {
    assert.equal(this.readyState, 1)
    this.sent.push(value)
    if (value === 'ping') { queueMicrotask(() => this.message('pong')); return }
    const command = JSON.parse(value)
    for (const arg of command.args as Subscription[]) {
      if (command.op === 'subscribe') this.subscriptions.set(keyFor(arg), arg)
      else this.subscriptions.delete(keyFor(arg))
      queueMicrotask(() => this.message({ id: command.id, event: command.op, arg }))
    }
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' })))
  }
}

async function fixture(config: ReturnType<typeof preferences>, instruments: ReturnType<typeof instrument>[]) {
  const root = await mkdtemp(join(tmpdir(), 'perp-market-network-demand-'))
  const store = await MarketStore.open(root), sockets = new Map<string, Socket[]>()
  const service = new MarketService(store, () => config, async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response(instruments)
    throw new Error(`Unexpected network request: ${path}`)
  }, false, {
    webSocketFactory: url => {
      const socket = new Socket(), values = sockets.get(url) ?? []
      values.push(socket); sockets.set(url, values)
      return socket
    },
  })
  await service.ready
  // Keep membership and demand transitions deterministic without admitting chart/history work.
  service.preparedCharts.setUniverse = () => ({ frames: [] })
  service.updateRanking = async () => undefined
  for (const lane of service.requestLanes.values()) lane.interval = 0
  service.publicRealtime.start(); service.realtime.start()
  const idle = async () => {
    await Promise.all([service.publicRealtime.whenIdle(), service.realtime.whenIdle()])
    await setImmediate()
  }
  const discover = () => service.discoverInstruments(service.catalogCriteriaKey(), new AbortController().signal, 'foreground')
  const open = async () => {
    for (const values of sockets.values()) for (const socket of values) if (socket.readyState === 0) socket.open()
    await idle()
  }
  const subscriptions = (url: string) => [...(sockets.get(url) ?? [])].filter(socket => socket.readyState !== 3).flatMap(socket => [...socket.subscriptions.keys()]).sort()
  const push = (url: string, instId: string, channel: string, data: unknown[], action?: string) => {
    const socket = sockets.get(url)?.find(value => value.readyState === 1 && value.subscriptions.has(keyFor({ instId, channel })))
    assert.ok(socket, `Missing ${channel} subscription for ${instId}.`)
    socket.message({ arg: { instId, channel }, data, ...(action ? { action } : {}) })
  }
  const close = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { service, sockets, idle, discover, open, subscriptions, push, close }
}

test('book demand waits for fresh cheap checks, survives a failed book, and retires only after the grace deadline', async context => {
  let now = 1_800_000_000_000
  context.mock.method(Date, 'now', () => now)
  const value = instrument(), f = await fixture(preferences('spread', 'depth', 'slippage'), [value])
  try {
    await f.discover(); await f.open()
    const id = value.instId, socket = f.sockets.get(OKX_PUBLIC_WEBSOCKET_URL)![0]
    assert.deepEqual(f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL), [`open-interest:${id}`, `tickers:${id}`].sort())
    assert.deepEqual(f.subscriptions(OKX_BUSINESS_WEBSOCKET_URL), [`candle5m:${id}`])

    f.push(OKX_PUBLIC_WEBSOCKET_URL, id, 'tickers', [ticker(id)])
    await f.idle(); f.service.flushStreamQualifications(); await f.idle()
    await waitFor(() => f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).includes(`books:${id}`))

    now += 1
    f.push(OKX_PUBLIC_WEBSOCKET_URL, id, 'books', [failedSlippageBook()], 'snapshot')
    await f.idle(); f.service.flushStreamQualifications()
    await waitFor(() => f.service.catalogChecks.get(id)?.result?.checks?.some((check: { key: string; status: string }) => check.key === 'slippage' && check.status === 'failed')).catch(error => {
      const record = f.service.catalogChecks.get(id), observations = f.service.observations.get(id) ?? {}
      const checks = record?.result?.checks?.map((value: { key: string; status: string }) => `${value.key}:${value.status}`).join(',')
      const input = f.service.liquidityInput(value, f.service.prefs().liquidity, observations)
      const cheap = f.service.cheapLiquidity(input)
      const cheapChecks = cheap.checks?.map((item: { key: string; status: string }) => `${item.key}:${item.status}`).join(',')
      throw new Error(`${error.message} check=${record?.status}/${record?.result?.status}; checks=${checks}; freshBook=${Boolean(input.book)}; cheap=${cheap.status}[${cheapChecks}]; observations=${Object.keys(observations).join(',')}; evaluation=${f.service.streamEvaluations.has(id)}`)
    })
    assert.equal(f.service.catalogChecks.get(id)?.result?.checks?.find((check: { key: string }) => check.key === 'depth')?.status, 'verified')
    assert.equal(f.service.catalogChecks.get(id)?.result?.checks?.find((check: { key: string }) => check.key === 'slippage')?.status, 'failed')
    assert.ok(f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).includes(`books:${id}`), 'A failed depth/slippage result stays subscribed for recovery.')

    const failedTicker = () => ticker(id, '99')
    now += 1
    f.push(OKX_PUBLIC_WEBSOCKET_URL, id, 'tickers', [failedTicker()])
    await f.idle(); f.service.flushStreamQualifications(); await f.idle()
    const firstRetirement = f.service.bookRetirements.get(id)
    assert.equal(firstRetirement, now + 30_000)
    assert.ok(f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).includes(`books:${id}`), 'Cheap failures retain an already demanded book during grace.')

    now = firstRetirement - 1
    f.push(OKX_PUBLIC_WEBSOCKET_URL, id, 'tickers', [ticker(id)])
    await f.idle(); f.service.flushStreamQualifications(); await f.idle()
    await waitFor(() => !f.service.bookRetirements.has(id))
    assert.equal(f.service.bookRetirements.has(id), false, 'A fresh pass before expiry cancels retirement.')
    assert.ok(f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).includes(`books:${id}`))

    now += 1
    f.push(OKX_PUBLIC_WEBSOCKET_URL, id, 'tickers', [failedTicker()])
    await f.idle(); f.service.flushStreamQualifications(); await f.idle()
    const retirement = f.service.bookRetirements.get(id)
    assert.equal(retirement, now + 30_000)
    now = retirement
    f.service.processMarketDeadline()
    await waitFor(() => !f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).includes(`books:${id}`))

    now += 1
    f.push(OKX_PUBLIC_WEBSOCKET_URL, id, 'tickers', [ticker(id)])
    await f.idle(); f.service.flushStreamQualifications(); await f.idle()
    await waitFor(() => f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).includes(`books:${id}`))
    assert.equal(f.sockets.get(OKX_PUBLIC_WEBSOCKET_URL)?.length, 1, 'The channel retires and returns without rebuilding the socket.')
    const controls = socket.sent.filter(value => value !== 'ping').map(value => JSON.parse(value))
    assert.equal(controls.filter(command => command.op === 'unsubscribe').length, 1)
    assert.equal(controls.filter(command => command.op === 'subscribe' && command.args.some((arg: Subscription) => arg.channel === 'books')).length, 2)
    assert.ok(controls.every(command => command.args.every((arg: Subscription) => arg.channel === 'books' || command.op === 'subscribe')))
  } finally { await f.close() }
})

test('trades follow qualified-list and focus demand, and focus removal breaks coverage without a socket reset', async () => {
  const values = [instrument(), instrument('ETH'), instrument('SOL')], f = await fixture(preferences('spread'), values)
  try {
    await f.discover(); await f.open()
    const [focused, qualified, idle] = values.map(value => value.instId)
    assert.deepEqual(f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL), values.flatMap(value => [`tickers:${value.instId}`, `open-interest:${value.instId}`]).sort())
    f.service.preparedCharts.prepareFocus = async () => null
    f.service.preparedCharts.setFocus({ instId: focused, timeframe: '15m' }, 'first-focus')
    await waitFor(() => f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).includes(`trades:${focused}`))
    await f.idle()
    assert.deepEqual(f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).filter(key => key.startsWith('trades:')), [`trades:${focused}`])

    f.push(OKX_PUBLIC_WEBSOCKET_URL, focused, 'trades', [{ instId: focused, tradeId: '1', side: 'buy', sz: '1', ts: String(Date.now()) }])
    await f.idle()
    assert.notEqual(f.service.liveStatistics.instruments.get(focused)?.active, null)

    f.push(OKX_PUBLIC_WEBSOCKET_URL, qualified, 'tickers', [ticker(qualified)])
    await f.idle(); f.service.flushStreamQualifications(); await f.idle()
    await waitFor(() => f.service.catalog.has(qualified) && f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).includes(`trades:${qualified}`))
    assert.ok(!f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).includes(`trades:${idle}`))

    f.service.preparedCharts.setFocus({ instId: idle, timeframe: '1H' }, 'second-focus')
    await waitFor(() => f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).includes(`trades:${idle}`)
      && !f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).includes(`trades:${focused}`))
    await f.idle()
    const coverage = f.service.liveStatistics.instruments.get(focused)
    assert.equal(coverage?.active, null)
    assert.equal(coverage?.coverage.length, 1, 'Removing the focus-only trade channel retires its continuous coverage.')
    assert.deepEqual(f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).filter(key => key.startsWith('trades:')).sort(), [`trades:${idle}`, `trades:${qualified}`].sort())
    assert.equal(f.sockets.get(OKX_PUBLIC_WEBSOCKET_URL)?.length, 1)
  } finally { await f.close() }
})
