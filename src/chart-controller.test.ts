import assert from 'node:assert/strict'
import test from 'node:test'
import { ChartController, type ChartTarget, type ChartTransport } from './chart-controller.ts'
import { PreparedChartStore } from './chart-series-store.ts'
import type { PreparedChartBar, PreparedChartResponse } from './chart-data.ts'
import { timeframeMilliseconds, type RadarTimeframe } from './timeframe.ts'

const hour = 3_600_000, btc = 'BTC-USDT-SWAP', eth = 'ETH-USDT-SWAP'
const bars = (first: number, count: number): PreparedChartBar[] => Array.from({ length: count }, (_, index) => ({
  hour: (first + index) * hour, open: 100, high: 102, low: 99, close: 101,
  confirmed: true, statisticsSources: 3, statisticsObserved: true, indicatorsObserved: true,
  vwap: 100, ema: 100, bollUpper: 102, bollMiddle: 100, bollLower: 99,
  roc: 1, maroc: .5, rsi6: 50, rsi12: 51, rsi24: 52, atrPercent: 2.5, bbw: 6, oi: 1_000, buy: 20, sell: 30,
}))
const prepared = (instId: string, end: number, overrides: Partial<PreparedChartResponse> = {}): PreparedChartResponse => ({
  instId, timeframe: '1H', intervalMS: hour, endHour: end * hour, latestEnd: end * hour,
  oldestHour: null, historyExhausted: false, generation: 1, revision: 1,
  bars: bars(end - 95, 96), oiState: 'ready', takerState: 'ready', indicatorState: 'ready', error: '', ...overrides,
})
const nativePrepared = (instId: string, end: number, timeframe: RadarTimeframe): PreparedChartResponse => {
  const intervalMS = timeframeMilliseconds(timeframe)
  return prepared(instId, end, { timeframe, intervalMS, endHour: end * intervalMS, latestEnd: end * intervalMS,
    bars: bars(end - 95, 96).map(bar => ({ ...bar, hour: bar.hour / hour * intervalMS })) })
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve))
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const transport = (overrides: Partial<ChartTransport> = {}): ChartTransport => ({ focus: () => {}, local: async () => null, universe: async () => ({ frames: [] }), ...overrides })
const cached = (count = 200) => {
  const store = new PreparedChartStore()
  store.ingest(prepared(btc, 999 + count, { bars: bars(1000, count) }))
  return store
}
const retryAt = 1_800_000_000_000
const emptyFailure = (overrides: Partial<PreparedChartResponse> = {}) => prepared(btc, 199, {
  endHour: null, latestEnd: null, bars: [], generation: 3, revision: 10, priceState: 'error',
  priceStatus: { state: 'error', from: 104 * hour, through: 199 * hour, error: 'Cold price source offline', retryAt }, ...overrides,
})

test('universe hydration reads all resident periods once per membership regardless of selected timeframe or order', async () => {
  let reads = 0
  const frames = ['5m', '15m', '1H'].flatMap(timeframe => [btc, eth].map(id => nativePrepared(id, 1199, timeframe as RadarTimeframe)))
  const controller = new ChartController(transport({ universe: async (...args) => { assert.equal(args.length, 0); reads += 1; return { frames } } }))
  await controller.setUniverse([btc, eth], '15m')
  await controller.setUniverse([eth, btc, btc], '5m')
  assert.equal(reads, 1)
  for (const frame of frames) assert.equal(controller.store.window(frame.instId, frame.timeframe)?.endHour, frame.endHour)
  const close = controller.open(eth, '1H')
  assert.equal(controller.getSnapshot().presented?.instId, eth)
  assert.equal(controller.getSnapshot().pending, false)
  close()
})

test('superseded resident handshakes cannot overwrite current membership and failed reads may retry', async () => {
  const first = deferred<{ frames: PreparedChartResponse[] }>()
  let reads = 0
  const controller = new ChartController(transport({ universe: async () => {
    reads += 1
    if (reads === 1) return first.promise
    if (reads === 3) throw new Error('read failed')
    return { frames: [prepared(eth, 1199, { generation: 2 })] }
  } }))
  const old = controller.setUniverse([btc], '1H')
  await controller.setUniverse([eth], '1H')
  first.resolve({ frames: [prepared(btc, 1199)] }); await old
  assert.equal(controller.store.window(btc, '1H'), null)
  assert.equal(controller.store.window(eth, '1H')?.generation, 2)
  await controller.setUniverse([btc, eth], '1H')
  await controller.setUniverse([btc, eth], '5m')
  assert.equal(reads, 4)
})

test('durable history hydrates once and cached scrolling commits synchronously without reads or timers', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  const store = cached(), bulk = prepared(btc, 1199, { bars: bars(199, 1001) })
  const controller = new ChartController(transport({ history: async () => { reads += 1; return bulk } }), store)
  const close = controller.open(btc, '1H')
  try {
    controller.scroll(-1); await settled()
    assert.equal(reads, 1)
    for (const steps of [-200, -300, 400, -200, 301]) {
      const before = controller.getSnapshot().presented!.endHour
      controller.scroll(steps)
      assert.equal(controller.getSnapshot().presented?.endHour, before + steps * hour)
      assert.equal(controller.getSnapshot().pending, false)
    }
    await settled(); context.mock.timers.tick(120_000); await settled()
    assert.equal(reads, 1)
  } finally { close(); context.mock.timers.reset() }
})

test('cached native period and instrument switches display synchronously while demand declares each selection', async () => {
  const demands: Array<ChartTarget | null> = []
  const frames = [nativePrepared(btc, 1199, '5m'), nativePrepared(btc, 1199, '15m'), nativePrepared(eth, 1199, '1H')]
  const controller = new ChartController(transport({ focus: target => { demands.push(target) }, universe: async () => ({ frames }) }))
  await controller.setUniverse([btc, eth], '5m')
  const releases: Array<() => void> = []
  for (const frame of frames) {
    releases.push(controller.open(frame.instId, frame.timeframe))
    assert.equal(controller.getSnapshot().presented?.timeframe, frame.timeframe)
    assert.equal(controller.getSnapshot().presented?.instId, frame.instId)
    assert.equal(controller.getSnapshot().pending, false)
  }
  await settled()
  assert.equal(demands.length, 3)
  releases.forEach(release => release())
})

test('uncached scroll declares current demand immediately and preserves calculated paint until pushed repair arrives', async () => {
  const demands: Array<ChartTarget | null> = [], controller = new ChartController(transport({
    focus: target => { demands.push(target) }, history: async () => null,
  }), cached())
  const close = controller.open(btc, '1H')
  const previous = controller.getSnapshot().presented
  controller.scroll(-1000)
  assert.equal(controller.getSnapshot().presented, previous)
  assert.equal(controller.getSnapshot().pending, true)
  await settled()
  assert.equal(demands.at(-1)?.end, 199 * hour)
  controller.ingestPrepared(prepared(btc, 199, { latestEnd: 1199 * hour, revision: 2 }))
  assert.equal(controller.getSnapshot().presented?.endHour, 199 * hour)
  assert.equal(controller.getSnapshot().pending, false)
  close()
})

test('raw historical prices cannot erase existing technical curves while backend calculation is pending', async () => {
  const raw = prepared(btc, 599, { latestEnd: 1199 * hour, revision: 2, indicatorState: 'loading',
    bars: bars(504, 96).map(bar => ({ ...bar, indicatorsObserved: false, ema: null, vwap: null, bollUpper: null, bollMiddle: null, bollLower: null, roc: null, maroc: null, rsi6: null, rsi12: null, rsi24: null, atrPercent: null, bbw: null })) })
  const controller = new ChartController(transport({ history: async () => raw }), cached())
  const close = controller.open(btc, '1H'), original = controller.getSnapshot().presented
  controller.scroll(-600); await settled()
  assert.equal(controller.store.window(btc, '1H', 599 * hour)?.bars.length, 96)
  assert.equal(controller.getSnapshot().presented, original)
  assert.equal(controller.getSnapshot().pending, true)
  controller.ingestPrepared(prepared(btc, 599, { latestEnd: 1199 * hour, revision: 3 }))
  assert.equal(controller.getSnapshot().presented?.endHour, 599 * hour)
  assert.equal(controller.getSnapshot().pending, false)
  close()
})

test('initial prices display while optional statistics and native indicators prepare independently', async () => {
  const raw = prepared(btc, 199, { indicatorState: 'loading', oiState: 'loading', takerState: 'loading',
    bars: bars(104, 96).map(bar => ({ ...bar, indicatorsObserved: false, statisticsObserved: false, statisticsSources: 0,
      ema: null, vwap: null, bollUpper: null, bollMiddle: null, bollLower: null, roc: null, maroc: null, rsi6: null, rsi12: null, rsi24: null, atrPercent: null, bbw: null, oi: null, buy: null, sell: null })) })
  const controller = new ChartController(transport({ local: async () => raw }))
  const close = controller.open(btc, '1H'); await settled()
  assert.equal(controller.getSnapshot().presented?.bars.length, 96)
  assert.equal(controller.getSnapshot().presented?.indicatorState, 'loading')
  assert.equal(controller.getSnapshot().presented?.oiState, 'loading')
  assert.equal(controller.getSnapshot().pending, false)
  close()
})

test('cold selections bypass one held local read then coalesce at two concurrent series', async () => {
  const requests: Array<{ id: string; gate: ReturnType<typeof deferred<PreparedChartResponse | null>> }> = []
  const controller = new ChartController(transport({ local: id => { const gate = deferred<PreparedChartResponse | null>(); requests.push({ id, gate }); return gate.promise } }))
  controller.open(btc, '1H'); controller.open(eth, '1H')
  const close = controller.open('SOL-USDT-SWAP', '1H')
  assert.deepEqual(requests.map(request => request.id), [btc, eth])
  requests[1].gate.resolve(prepared(eth, 1199)); await settled()
  assert.deepEqual(requests.map(request => request.id), [btc, eth, 'SOL-USDT-SWAP'])
  requests[2].gate.resolve(prepared('SOL-USDT-SWAP', 1199)); await settled()
  assert.equal(controller.getSnapshot().presented?.instId, 'SOL-USDT-SWAP')
  requests[0].gate.resolve(prepared(btc, 1199)); await settled()
  assert.equal(controller.getSnapshot().presented?.instId, 'SOL-USDT-SWAP')
  close()
})

test('historical reads bypass a held old cursor and bounded read completion hydrates only the latest queued intent', async () => {
  const requests: Array<{ target: ChartTarget; gate: ReturnType<typeof deferred<PreparedChartResponse | null>> }> = []
  const controller = new ChartController(transport({ history: target => { const gate = deferred<PreparedChartResponse | null>(); requests.push({ target, gate }); return gate.promise } }), cached())
  const close = controller.open(btc, '1H')
  controller.scroll(-300); controller.scroll(-300); controller.scroll(-100)
  assert.equal(requests.length, 2)
  assert.equal(controller.getSnapshot().requested?.end, 499 * hour)
  requests[1].gate.resolve(null); await settled()
  assert.equal(requests.length, 3)
  assert.equal(requests[2].target.end, 499 * hour)
  requests[2].gate.resolve(prepared(btc, 499, { latestEnd: 1199 * hour, revision: 3 })); await settled()
  assert.equal(controller.getSnapshot().presented?.endHour, 499 * hour)
  requests[0].gate.resolve(null); await settled()
  close()
})

test('failed durable reads do not spin or schedule retries, and changed backend input allows a new read', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  const controller = new ChartController(transport({ history: async () => { reads += 1; throw new Error('SQLite unavailable') } }), cached())
  const close = controller.open(btc, '1H'); controller.scroll(-800); await settled()
  assert.equal(reads, 1)
  context.mock.timers.tick(120_000); await settled()
  assert.equal(reads, 1)
  controller.ingestPrepared(prepared(btc, 1199, { revision: 2 })); await settled()
  assert.equal(reads, 2)
  close(); context.mock.timers.reset()
})

test('only the current component release clears backend demand and cached navigation gets fresh tokens', async () => {
  const demands: Array<{ target: ChartTarget | null; id: string }> = []
  const controller = new ChartController(transport({ focus: (target, id) => { demands.push({ target, id }) } }), cached(5000))
  const first = controller.open(btc, '1H')
  controller.scroll(-1500)
  const target = controller.getSnapshot().requested!
  const second = controller.open(target.instId, target.timeframe, target.end)
  first(); await settled()
  assert.equal(demands.at(-1)?.target?.end, target.end)
  second(); await settled()
  assert.equal(demands.at(-1)?.target, null)
  assert.equal(new Set(demands.map(demand => demand.id)).size, demands.length)
})

test('new generations preserve historical wheel intent and paint until the requested generation is ready', async () => {
  const controller = new ChartController(transport(), cached(5000))
  const close = controller.open(btc, '1H')
  controller.scroll(-1500)
  const original = controller.getSnapshot().presented, target = controller.getSnapshot().requested!.end!
  controller.ingestPrepared(prepared(btc, 5999, { generation: 2, revision: 2, bars: [] }))
  assert.equal(controller.getSnapshot().requested?.end, target)
  assert.equal(controller.getSnapshot().presented, original)
  controller.scroll(-100)
  assert.equal(controller.getSnapshot().requested?.end, target - 100 * hour)
  controller.ingestPrepared(prepared(btc, target / hour - 100, { generation: 2, revision: 3, latestEnd: 5999 * hour }))
  assert.equal(controller.getSnapshot().presented?.endHour, target - 100 * hour)
  close()
})

test('an old durable generation cannot overwrite a newer subscribed chart', async () => {
  const gate = deferred<PreparedChartResponse | null>(), controller = new ChartController(transport({ local: () => gate.promise }))
  const close = controller.open(btc, '1H')
  controller.ingestPrepared(prepared(btc, 1199, { generation: 2, revision: 3 }))
  gate.resolve(prepared(btc, 1199, { generation: 1, revision: 99, bars: bars(1104, 96).map(bar => ({ ...bar, close: 100 })) }))
  await settled()
  assert.equal(controller.getSnapshot().presented?.generation, 2)
  assert.equal(controller.getSnapshot().presented?.bars.at(-1)?.close, 101)
  close()
})

test('a held full-frame read cannot rewind a newer forming overlay', async () => {
  const gate = deferred<PreparedChartResponse | null>(), base = prepared(btc, 1199)
  const live = { ...bars(1200, 1)[0], confirmed: false, close: 101.5 }
  const controller = new ChartController(transport({ local: () => gate.promise }))
  const close = controller.open(btc, '1H')
  controller.ingestPrepared({ ...base, revision: 2, liveBar: live, priceObservedAt: 200, realtimeState: 'live' })
  gate.resolve({ ...base, revision: 1, liveBar: { ...live, close: 100.5 }, priceObservedAt: 100 }); await settled()
  assert.equal(controller.getSnapshot().presented?.liveBar?.close, 101.5)
  assert.equal(controller.getSnapshot().presented?.priceObservedAt, 200)
  close()
})

test('forming notifications update the overlay without repeated reads or demand', async () => {
  let reads = 0, demands = 0
  const base = prepared(btc, 1199), controller = new ChartController(transport({ local: async () => { reads += 1; return base }, focus: () => { demands += 1 } }))
  const close = controller.open(btc, '1H'); await settled()
  const initial = controller.getSnapshot().presented!
  controller.ingestPrepared({ type: 'live', instId: btc, timeframe: '1H', generation: 1, revision: 2,
    endHour: base.endHour!, liveBar: { ...bars(1200, 1)[0], confirmed: false, close: 101.5 },
    realtimeState: 'live', priceObservedAt: 200, priceState: 'ready' })
  await settled()
  assert.equal(controller.getSnapshot().presented?.liveBar?.close, 101.5)
  assert.equal(controller.getSnapshot().presented?.bars, initial.bars)
  assert.equal(reads, 1); assert.equal(demands, 1)
  close()
})

test('source failures preserve usable prices and other panels and recover through notifications', async () => {
  const frame = prepared(btc, 1199, { bars: bars(1104, 96).map(bar => ({ ...bar, oi: null, oiObserved: false, takerObserved: true, statisticsObserved: false, statisticsSources: 2 })), oiState: 'loading' })
  const controller = new ChartController(transport({ local: async () => frame }))
  const close = controller.open(btc, '1H'); await settled()
  const retryAt = Date.now() + 60_000
  controller.ingestPrepared({ ...frame, revision: 2, oiState: 'error', oiStatus: { state: 'error', from: 1104 * hour, through: 1199 * hour, error: 'OI offline', retryAt } })
  assert.equal(controller.getSnapshot().presented?.oiStatus?.retryAt, retryAt)
  assert.equal(controller.getSnapshot().presented?.takerState, 'ready')
  assert.equal(controller.getSnapshot().pending, false)
  controller.ingestPrepared(prepared(btc, 1199, { revision: 3 }))
  assert.equal(controller.getSnapshot().presented?.oiState, 'ready')
  assert.equal(controller.getSnapshot().error, '')
  close()
})

test('price repair failure and retry time remain visible without frontend retries', async () => {
  const retryAt = Date.now() + 60_000, frame = prepared(btc, 199)
  const failed = { ...frame, bars: frame.bars.filter((_, index) => index !== 40), priceState: 'error' as const,
    priceStatus: { state: 'error' as const, from: 104 * hour, through: 199 * hour, error: 'Price endpoint offline', retryAt } }
  const controller = new ChartController(transport({ local: async () => failed }))
  const close = controller.open(btc, '1H'); await settled()
  assert.equal(controller.getSnapshot().presented?.bars.length, 95)
  assert.equal(controller.getSnapshot().presented?.priceState, 'error')
  assert.match(controller.getSnapshot().error, /Price endpoint offline/)
  assert.ok(controller.getSnapshot().error.includes(new Date(retryAt).toISOString()))
  controller.ingestPrepared({ ...frame, revision: 2, priceState: 'ready', priceStatus: { state: 'ready', from: 104 * hour, through: 199 * hour } })
  assert.equal(controller.getSnapshot().presented?.priceState, 'ready')
  assert.equal(controller.getSnapshot().error, '')
  close()
})

test('cold empty failures show their retry deadline and recover without frontend retries or initial drawable data', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0, demands = 0
  const controller = new ChartController(transport({ local: async () => { reads += 1; return null }, focus: () => { demands += 1 } }))
  const close = controller.open(btc, '1H'); await settled()
  try {
    controller.ingestPrepared(emptyFailure())
    assert.equal(controller.store.window(btc, '1H'), null)
    assert.equal(controller.getSnapshot().presented, null)
    assert.equal(controller.getSnapshot().pending, true)
    assert.match(controller.getSnapshot().error, /Cold price source offline/)
    assert.ok(controller.getSnapshot().error.includes(new Date(retryAt).toISOString()))
    context.mock.timers.tick(120_000); await settled()
    assert.equal(reads, 1); assert.equal(demands, 1)
    controller.ingestPrepared(emptyFailure({ revision: 11, priceState: 'loading', priceStatus: { state: 'loading', from: 104 * hour, through: 199 * hour } }))
    assert.match(controller.getSnapshot().error, /Cold price source offline/)
    controller.ingestPrepared(emptyFailure({ revision: 12, priceState: 'ready', priceStatus: { state: 'ready', from: 104 * hour, through: 199 * hour } }))
    assert.equal(controller.getSnapshot().error, '')
    assert.equal(controller.getSnapshot().presented, null)
    assert.equal(controller.getSnapshot().pending, true)
    controller.ingestPrepared(emptyFailure({ revision: 13 }))
    controller.ingestPrepared(prepared(btc, 199, { generation: 3, revision: 14, indicatorState: 'loading',
      bars: bars(104, 96).map(bar => ({ ...bar, indicatorsObserved: false })) }))
    assert.equal(controller.getSnapshot().error, '')
    assert.equal(controller.getSnapshot().presented?.bars.length, 96)
    assert.equal(controller.getSnapshot().presented?.indicatorState, 'loading')
    assert.equal(controller.getSnapshot().pending, false)
    assert.equal(reads, 1); assert.equal(demands, 1)
  } finally { close(); context.mock.timers.reset() }
})

for (const ingress of ['local', 'history', 'universe', 'push'] as const) for (const generation of [2, 3]) {
  test(`${ingress} drawable admission respects cold status generation and cursor revision fences (generation ${generation})`, async () => {
    const gate = deferred<PreparedChartResponse | null>(), universe = deferred<{ frames: PreparedChartResponse[] }>()
    let reads = 0
    const end = ingress === 'history' ? 199 * hour : null
    const controller = new ChartController(transport({
      ...(ingress === 'local' ? { local: async () => ++reads === 1 ? gate.promise : null } : {}),
      ...(ingress === 'history' ? { history: async () => ++reads === 1 ? gate.promise : null } : {}),
      ...(ingress === 'universe' ? { universe: () => universe.promise } : {}),
    }))
    const hydration = ingress === 'universe' ? controller.setUniverse([btc], '1H') : Promise.resolve()
    const close = controller.open(btc, '1H', end)
    try {
      controller.ingestPrepared(emptyFailure({ endHour: end }))
      const failure = controller.getSnapshot().error
      const stale = prepared(btc, 199, { generation, revision: generation === 2 ? 999 : 9,
        latestEnd: end === null ? 199 * hour : 1199 * hour })
      if (ingress === 'push') controller.ingestPrepared(stale)
      else if (ingress === 'universe') universe.resolve({ frames: [stale] })
      else gate.resolve(stale)
      await hydration; await settled()
      assert.equal(controller.store.window(btc, '1H', end) === null, true, 'Older drawable facts cannot bypass a status-only source watermark.')
      assert.equal(controller.getSnapshot().presented, null)
      assert.equal(controller.getSnapshot().pending, true)
      assert.equal(controller.getSnapshot().error, failure)
      controller.ingestPrepared(prepared(btc, 199, { generation: 3, revision: 11,
        latestEnd: end === null ? 199 * hour : 1199 * hour }))
      assert.equal(controller.getSnapshot().presented?.generation, 3)
      assert.equal(controller.getSnapshot().presented?.bars.length, 96)
      assert.equal(controller.getSnapshot().pending, false)
      assert.equal(controller.getSnapshot().error, '')
    } finally { close() }
  })
}

test('live drawable admission cannot mutate retained older prices after a status-only generation advance', async () => {
  const store = new PreparedChartStore()
  store.setUniverse([btc], '1H', btc)
  store.ingestLatest(prepared(btc, 1199, { generation: 2 }))
  const controller = new ChartController(transport(), store), close = controller.open(btc, '1H')
  try {
    controller.ingestPrepared(emptyFailure())
    const failure = controller.getSnapshot().error
    const update = { type: 'live' as const, instId: btc, timeframe: '1H' as const, generation: 2, revision: 999,
      endHour: 1199 * hour, liveBar: { ...bars(1200, 1)[0], confirmed: false, close: 101.5 } }
    controller.ingestPrepared(update)
    assert.equal(controller.getSnapshot().presented?.liveBar, undefined)
    assert.equal(controller.getSnapshot().error, failure)
    controller.ingestPrepared(prepared(btc, 1199, { generation: 3, revision: 11 }))
    controller.ingestPrepared({ ...update, generation: 3, revision: 12 })
    assert.equal(controller.getSnapshot().presented?.liveBar?.close, 101.5)
    assert.equal(controller.getSnapshot().error, '')
  } finally { close(); await settled() }
})

test('same-generation older history for a different cursor remains admissible under a selected source watermark', async () => {
  const controller = new ChartController(transport()), close = controller.open(btc, '1H', 699 * hour)
  try {
    controller.ingestPrepared(emptyFailure({ endHour: 699 * hour, latestEnd: 1199 * hour }))
    const failure = controller.getSnapshot().error
    controller.ingestPrepared(prepared(btc, 600, { generation: 2, revision: 999, latestEnd: 1199 * hour }))
    assert.equal(controller.store.window(btc, '1H', 600 * hour), null, 'Generation fences apply across cursors.')
    controller.ingestPrepared(prepared(btc, 600, { generation: 3, revision: 9, latestEnd: 1199 * hour }))
    assert.equal(controller.store.window(btc, '1H', 600 * hour)?.bars.length, 96, 'Independent historical observations keep their per-bar revision semantics.')
    assert.equal(controller.getSnapshot().presented, null)
    assert.equal(controller.getSnapshot().error, failure)
    controller.ingestPrepared(prepared(btc, 699, { generation: 3, revision: 11, latestEnd: 1199 * hour }))
    assert.equal(controller.getSnapshot().presented?.endHour, 699 * hour)
    assert.equal(controller.getSnapshot().error, '')
  } finally { close(); await settled() }
})

test('same-generation historical status has its own cursor revision after a newer latest frame', async () => {
  const controller = new ChartController(transport()), close = controller.open(btc, '1H')
  try {
    controller.ingestPrepared(prepared(btc, 1199, { generation: 3, revision: 20 }))
    controller.scroll(-500)
    const failure = emptyFailure({ endHour: 699 * hour, latestEnd: 1199 * hour, revision: 19,
      priceStatus: { state: 'error', from: 604 * hour, through: 699 * hour, error: 'Historical source failed', retryAt } })
    controller.ingestPrepared(failure)
    assert.match(controller.getSnapshot().error, /Historical source failed/)
    assert.ok(controller.getSnapshot().error.includes(new Date(retryAt).toISOString()))
    controller.ingestPrepared({ ...failure, revision: 18, priceState: 'ready', priceStatus: { state: 'ready', from: 604 * hour, through: 699 * hour } })
    assert.match(controller.getSnapshot().error, /Historical source failed/, 'The same cursor still rejects its own older lifecycle.')
    controller.ingestPrepared(prepared(btc, 699, { generation: 3, revision: 21, latestEnd: 1199 * hour }))
    assert.equal(controller.getSnapshot().error, '')
    assert.equal(controller.getSnapshot().presented?.endHour, 699 * hour)
  } finally { close(); await settled() }
})

test('status-only generation and revision fences survive recovery and a new selection clears its old lifecycle', async () => {
  const controller = new ChartController(transport())
  const close = controller.open(btc, '1H'); await settled()
  controller.ingestPrepared(emptyFailure())
  const failure = controller.getSnapshot().error
  controller.ingestPrepared(emptyFailure({ generation: 2, revision: 999, priceState: 'ready', priceStatus: { state: 'ready', from: 104 * hour, through: 199 * hour } }))
  controller.ingestPrepared(emptyFailure({ revision: 9, priceStatus: { state: 'error', from: 104 * hour, through: 199 * hour, error: 'Stale revision' } }))
  assert.equal(controller.getSnapshot().error, failure)
  controller.ingestPrepared(emptyFailure({ revision: 11, priceState: 'ready', priceStatus: { state: 'ready', from: 104 * hour, through: 199 * hour } }))
  controller.ingestPrepared(emptyFailure({ revision: 10 }))
  assert.equal(controller.getSnapshot().error, '')
  controller.ingestPrepared(emptyFailure({ revision: 12 }))
  const other = controller.open(eth, '1H')
  assert.equal(controller.getSnapshot().error, '')
  controller.ingestPrepared(emptyFailure({ revision: 13 }))
  assert.equal(controller.getSnapshot().error, '')
  const reopened = controller.open(btc, '1H')
  assert.equal(controller.getSnapshot().error, '')
  controller.ingestPrepared(emptyFailure({ generation: 2, revision: 1000 }))
  assert.equal(controller.getSnapshot().error, '')
  close(); other(); reopened(); await settled()
})

test('wrong historical cursors and latest notifications cannot replace a selected cursor source lifecycle', async () => {
  const controller = new ChartController(transport({ history: async () => null }), cached())
  const close = controller.open(btc, '1H')
  controller.scroll(-500); await settled()
  const end = controller.getSnapshot().requested!.end!
  const current = emptyFailure({ generation: 1, endHour: end, latestEnd: 1199 * hour,
    priceStatus: { state: 'error', from: end - 95 * hour, through: end, error: 'Selected cursor failed', retryAt } })
  controller.ingestPrepared(current)
  const failure = controller.getSnapshot().error
  controller.ingestPrepared({ ...current, revision: 11, endHour: end - hour,
    priceStatus: { state: 'error', from: end - 96 * hour, through: end - hour, error: 'Wrong cursor failed' } })
  controller.ingestPrepared({ ...current, revision: 12, endHour: 1199 * hour,
    priceStatus: { state: 'error', from: 1104 * hour, through: 1199 * hour, error: 'Latest cursor failed' } })
  assert.equal(controller.getSnapshot().error, failure)
  controller.ingestPrepared({ ...current, revision: 9, priceState: 'ready', priceStatus: { state: 'ready', from: end - 95 * hour, through: end } })
  assert.equal(controller.getSnapshot().error, failure)
  controller.ingestPrepared({ ...current, revision: 13, priceState: 'ready', priceStatus: { state: 'ready', from: end - 95 * hour, through: end } })
  assert.equal(controller.getSnapshot().error, '')
  controller.ingestPrepared({ ...current, revision: 14, endHour: end - hour })
  assert.equal(controller.getSnapshot().error, '')
  close(); await settled()
})

test('a newly proven listing floor clears a source lifecycle belonging to the old below-floor cursor', async () => {
  const controller = new ChartController(transport(), cached())
  const close = controller.open(btc, '1H')
  controller.scroll(-500)
  const end = controller.getSnapshot().requested!.end!
  controller.ingestPrepared(emptyFailure({ generation: 1, endHour: end, latestEnd: 1199 * hour, oldestHour: 1000 * hour, historyExhausted: true,
    priceStatus: { state: 'error', from: end - 95 * hour, through: end, error: 'Below-floor request failed', retryAt } }))
  assert.equal(controller.getSnapshot().requested?.end, 1000 * hour)
  assert.equal(controller.getSnapshot().error, '')
  close(); await settled()
})

test('opening a cached drawable failure retains its price error and retry deadline without an active lifecycle notification', async () => {
  const frame = prepared(btc, 199, { priceState: 'error', bars: bars(104, 96).filter((_, index) => index !== 40),
    priceStatus: { state: 'error', from: 104 * hour, through: 199 * hour, error: 'Cached source failure', retryAt } })
  const controller = new ChartController(transport({ universe: async () => ({ frames: [frame] }) }))
  await controller.setUniverse([btc], '1H')
  const close = controller.open(btc, '1H'); await settled()
  assert.equal(controller.getSnapshot().presented?.bars.length, 95)
  assert.match(controller.getSnapshot().error, /Cached source failure/)
  assert.ok(controller.getSnapshot().error.includes(new Date(retryAt).toISOString()))
  close()
})

for (const kind of ['local', 'history'] as const) {
  const end = kind === 'local' ? null : 199 * hour
  const failure = emptyFailure({ endHour: end })
  test(`empty ${kind} source status reaches a cold target without admitting a drawable frame`, async () => {
    let reads = 0
    const controller = new ChartController(transport({ [kind]: async () => { reads += 1; return failure } }))
    const close = controller.open(btc, '1H', end); await settled()
    assert.equal(controller.getSnapshot().presented, null)
    assert.equal(controller.store.snapshotMeta(btc, '1H'), null)
    assert.equal(controller.getSnapshot().pending, true)
    assert.match(controller.getSnapshot().error, /Cold price source offline/)
    assert.ok(controller.getSnapshot().error.includes(new Date(retryAt).toISOString()))
    assert.equal(reads, 1)
    close()
  })

  for (const recover of [false, true]) test(`held empty ${kind} replies cannot ${recover ? 'restore a recovered failure' : 'clear a newer pushed failure'} even with a higher revision`, async () => {
    const gate = deferred<PreparedChartResponse | null>()
    let reads = 0
    const controller = new ChartController(transport({ [kind]: async () => ++reads === 1 ? gate.promise : null }))
    const close = controller.open(btc, '1H', end)
    controller.ingestPrepared(failure)
    if (recover) controller.ingestPrepared({ ...failure, revision: 11, priceState: 'ready', priceStatus: { state: 'ready', from: 104 * hour, through: 199 * hour } })
    const expected = controller.getSnapshot().error
    gate.resolve(recover ? { ...failure, revision: 999 }
      : { ...failure, revision: 999, priceState: 'ready', priceStatus: { state: 'ready', from: 104 * hour, through: 199 * hour } })
    await settled()
    assert.equal(controller.getSnapshot().error, expected)
    assert.equal(controller.getSnapshot().presented, null)
    close()
  })
}

test('a held empty local failure from an earlier focus cannot follow a new selection of the same series', async () => {
  const gate = deferred<PreparedChartResponse | null>()
  let reads = 0
  const controller = new ChartController(transport({ local: async () => ++reads === 1 ? gate.promise : null }))
  controller.open(btc, '1H')
  controller.open(eth, '1H')
  const close = controller.open(btc, '1H')
  gate.resolve(emptyFailure()); await settled()
  assert.equal(controller.getSnapshot().requested?.instId, btc)
  assert.equal(controller.getSnapshot().error, '')
  assert.equal(controller.getSnapshot().presented, null)
  close()
})

test('a proven listing floor clamps the cursor while observed warmup nulls and unavailable statistics remain usable', async () => {
  const frame = prepared(btc, 199, { oldestHour: 180 * hour, historyExhausted: true, bars: bars(180, 20).map(bar => ({ ...bar, ema: null, oi: null, buy: null, sell: null })), indicatorState: 'unavailable', oiState: 'unavailable', takerState: 'unavailable' })
  const controller = new ChartController(transport({ local: async () => frame, history: async () => frame }))
  const close = controller.open(btc, '1H'); await settled()
  controller.scroll(-10000); await settled()
  assert.equal(controller.getSnapshot().requested?.end, 180 * hour)
  assert.equal(controller.getSnapshot().presented?.bars.length, 1)
  assert.equal(controller.getSnapshot().pending, false)
  close()
})
