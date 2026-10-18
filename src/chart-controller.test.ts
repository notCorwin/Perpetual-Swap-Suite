import assert from 'node:assert/strict'
import test from 'node:test'
import { ChartController, type ChartPreparation } from './chart-controller.ts'
import type { PreparedChartBar, PreparedChartResponse } from './chart-data.ts'
import { PreparedChartStore } from './chart-series-store.ts'
import { timeframeMilliseconds, type RadarTimeframe } from './timeframe.ts'

const hour = 3_600_000
const btc = 'BTC-USDT-SWAP'
const eth = 'ETH-USDT-SWAP'
const bars = (first: number, count: number): PreparedChartBar[] => Array.from({ length: count }, (_, index) => ({
  hour: (first + index) * hour, open: 100, high: 102, low: 99, close: 101,
  confirmed: true, statisticsSources: 3, statisticsObserved: true, indicatorsObserved: true,
  vwap: 100, ema: 100, bollUpper: 102, bollMiddle: 100, bollLower: 99,
  roc: 1, maroc: .5, rsi6: 50, rsi12: 51, rsi24: 52, oi: 1_000, buy: 20, sell: 30,
}))
const prepared = (instId: string, end: number, overrides: Partial<PreparedChartResponse> = {}): PreparedChartResponse => ({
  instId, timeframe: '1H', intervalMS: hour, endHour: end * hour, latestEnd: end * hour,
  oldestHour: null, historyExhausted: false, generation: 1, revision: 1,
  bars: bars(end - 95, 96), oiState: 'ready', takerState: 'ready', indicatorState: 'ready', error: '', ...overrides,
})
const nativePrepared = (instId: string, end: number, timeframe: RadarTimeframe, close: number): PreparedChartResponse => {
  const intervalMS = timeframeMilliseconds(timeframe)
  return prepared(instId, end, {
    timeframe, intervalMS, endHour: end * intervalMS, latestEnd: end * intervalMS,
    bars: bars(end - 95, 96).map(bar => ({ ...bar, hour: bar.hour / hour * intervalMS, close, high: close + 1 })),
  })
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve))
// Inspecting older candles explicitly admits durable history and its reserve.
// Returning to latest keeps that already requested work independent of focus.
const inspectHistory = async (controller: ChartController) => {
  controller.scroll(-1)
  await settled()
  controller.scroll(1)
  await settled()
}
const waitFor = async (predicate: () => boolean, timeout = 500) => {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('The chart controller did not reach the expected state.')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
function transportQueue() {
  const calls: Array<{ target: ChartPreparation; requestedAt: number; resolve: (response: PreparedChartResponse) => void; reject: (error: Error) => void }> = []
  let active = 0, maximumActive = 0
  const prepare = (target: ChartPreparation) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    return new Promise<PreparedChartResponse>((resolve, reject) => {
      calls.push({ target, requestedAt: Date.now(), resolve, reject })
    }).finally(() => { active -= 1 })
  }
  const transport = { prepare, local: async () => null, universe: async () => ({ frames: [] }) }
  return { calls, transport, maximumActive: () => maximumActive }
}
function cached(first = 1_000, count = 200) {
  const store = new PreparedChartStore()
  store.ingest(prepared(btc, first + count - 1, { bars: bars(first, count) }))
  return store
}

test('focused durable history is hydrated once and deep scrolling commits synchronously without provider work', async () => {
  const queue = transportQueue()
  let localReads = 0
  const store = new PreparedChartStore()
  const bulk = prepared(btc, 8_999, { bars: bars(199, 8_801) })
  store.ingest(prepared(btc, 8_999))
  const controller = new ChartController({ ...queue.transport, history: async () => { localReads += 1; return bulk } }, store)
  const close = controller.open(btc, '1H')
  const pending: boolean[] = []
  const unsubscribe = controller.subscribe(() => { pending.push(controller.getSnapshot().pending) })
  try {
    await inspectHistory(controller)
    assert.equal(localReads, 1)
    pending.length = 0
    assert.equal(queue.calls.length, 0, 'Resident history outside the prefetch horizon must not need a provider request.')
    for (const steps of [-1_200, -4_000, 3_000, -2_000, 4_200]) {
      const previous = controller.getSnapshot().presented!.endHour
      controller.scroll(steps)
      assert.equal(controller.getSnapshot().presented?.endHour, previous + steps * hour)
      assert.equal(controller.getSnapshot().pending, false)
    }
    assert.ok(pending.every(value => value === false), 'A cached cursor must publish a complete view atomically, without flashing Preparing.')
    assert.equal(localReads, 1, 'Wheel events must not repeatedly serialize the durable history.')
    assert.equal(queue.calls.length, 0)
  } finally { close(); unsubscribe() }
})

test('a durable historical read bypasses an unresolved same-series provider request', async () => {
  const queue = transportQueue()
  let reads = 0
  const controller = new ChartController({ ...queue.transport, history: async () => {
    reads += 1
    return reads === 1 ? null : prepared(btc, 599, { latestEnd: 1_199 * hour, bars: bars(199, 1_001) })
  } }, cached())
  const close = controller.open(btc, '1H')
  try {
    await inspectHistory(controller)
    assert.equal(queue.calls.length, 1, 'A provider prefetch is deliberately left unresolved.')
    controller.scroll(-600)
    await settled()
    assert.equal(reads, 2)
    assert.equal(controller.getSnapshot().presented?.endHour, 599 * hour)
    assert.equal(controller.getSnapshot().pending, false)
    assert.equal(queue.calls.length, 1, 'Saved history must not queue behind provider preparation.')
  } finally { close() }
})

test('a local history miss falls through to source repair without a local retry loop', async () => {
  const queue = transportQueue()
  let reads = 0
  const controller = new ChartController({ ...queue.transport, history: async () => { reads += 1; return null } })
  const close = controller.open(btc, '1H')
  try {
    await settled()
    assert.equal(reads, 1)
    assert.equal(queue.calls.length, 1)
    queue.calls[0].resolve(prepared(btc, 199, { bars: bars(0, 200), oldestHour: 0, historyExhausted: true }))
    await settled()
    assert.equal(controller.getSnapshot().pending, false)
    assert.equal(reads, 1, 'A successful latest frame must not serialize deep history before a scroll gesture.')
    await inspectHistory(controller)
    assert.equal(reads, 2, 'Explicit history navigation can read the newly durable revision once.')
    await settled()
    assert.equal(reads, 2)
  } finally { close() }
})

test('a bulk prefetch does not immediately transfer the same durable history again', async () => {
  const queue = transportQueue()
  let reads = 0
  const controller = new ChartController({ ...queue.transport, history: async () => { reads += 1; return null } }, cached())
  const close = controller.open(btc, '1H')
  try {
    await inspectHistory(controller)
    assert.equal(reads, 1)
    queue.calls[0].resolve(prepared(btc, 1_094, { latestEnd: 1_199 * hour, bars: bars(199, 1_001) }))
    await settled()
    assert.equal(reads, 1, 'The bulk preparation response already hydrated this durable revision.')
    controller.scroll(-200)
    assert.equal(controller.getSnapshot().pending, false)
    assert.equal(reads, 1)
  } finally { close() }
})

test('a newly selected contract hydrates beside an unresolved local read with bounded concurrency', async () => {
  const queue = transportQueue(), store = cached()
  store.ingest(prepared(eth, 1_199))
  const reads: { target: ChartPreparation; resolve: (value: PreparedChartResponse | null) => void }[] = []
  const controller = new ChartController({ ...queue.transport, history: target => new Promise(resolve => { reads.push({ target, resolve }) }) }, store)
  const closeBTC = controller.open(btc, '1H')
  controller.scroll(-1)
  const closeETH = controller.open(eth, '1H')
  controller.scroll(-1)
  let closeSOL = () => {}
  try {
    assert.equal(reads.length, 2)
    assert.equal(reads[1].target.instId, eth)
    store.ingest(prepared('SOL-USDT-SWAP', 1_199))
    closeSOL = controller.open('SOL-USDT-SWAP', '1H')
    controller.scroll(-1)
    assert.equal(reads.length, 2, 'Further local selections coalesce behind the two admitted reads.')
    assert.equal(queue.calls.length, 0, 'Waiting to preload local data must not start provider work.')
    reads[1].resolve(prepared(eth, 1_199, { bars: bars(199, 1_001) }))
    await settled()
    assert.equal(reads.length, 3)
    assert.equal(reads[2].target.instId, 'SOL-USDT-SWAP')
    reads[2].resolve(prepared('SOL-USDT-SWAP', 1_199, { bars: bars(199, 1_001) }))
    await settled()
    controller.scroll(-100)
    assert.equal(controller.getSnapshot().presented?.instId, 'SOL-USDT-SWAP')
    assert.equal(controller.getSnapshot().presented?.endHour, 1_098 * hour)
    reads[0].resolve(prepared(btc, 1_199, { bars: bars(199, 1_001) }))
    await settled()
    assert.equal(controller.getSnapshot().presented?.instId, 'SOL-USDT-SWAP')
    assert.ok(queue.calls.every(call => (call.target.historyBars ?? 96) > 96), 'Fast cached input may prefetch, but never needs foreground preparation.')
  } finally { closeBTC(); closeETH(); closeSOL() }
})

test('revisiting a market preloads again after history eviction while compact latest stays ready', async () => {
  const queue = transportQueue(), store = new PreparedChartStore({ maxSeries: 1 })
  const reads: string[] = []
  const controller = new ChartController({ ...queue.transport,
    universe: async ids => ({ frames: ids.map(id => prepared(id, 1_199)) }),
    history: async target => { reads.push(target.instId); return prepared(target.instId, 1_199, { bars: bars(199, 1_001) }) },
  }, store)
  controller.setUniverse([btc, eth], '1H')
  await settled()
  const closeBTC = controller.open(btc, '1H')
  await inspectHistory(controller)
  const firstEpoch = store.historyEpoch(btc, '1H')
  const closeETH = controller.open(eth, '1H')
  await inspectHistory(controller)
  assert.equal(store.historyEpoch(btc, '1H'), 0)
  assert.ok(store.window(btc, '1H'), 'Compact latest survives history eviction.')
  const revisitBTC = controller.open(btc, '1H')
  try {
    await inspectHistory(controller)
    assert.deepEqual(reads, [btc, eth, btc])
    assert.ok(store.historyEpoch(btc, '1H') > firstEpoch)
    controller.scroll(-100)
    assert.equal(controller.getSnapshot().presented?.endHour, 1_099 * hour)
    assert.equal(controller.getSnapshot().pending, false)
    assert.ok(queue.calls.every(call => (call.target.historyBars ?? 96) > 96), 'Cached navigation may replenish its reserve without blocking the selected window.')
  } finally { closeBTC(); closeETH(); revisitBTC() }
})

test('a same-generation statistics correction refreshes deep cached bars without reloading for identical notifications', async () => {
  const queue = transportQueue(), store = new PreparedChartStore()
  let revision = 1, reads = 0
  const bulk = () => prepared(btc, 1_199, { revision, bars: bars(199, 1_001).map(bar => ({ ...bar, oi: revision === 1 ? null : 9_999 })) })
  store.ingest(prepared(btc, 1_199))
  const controller = new ChartController({ ...queue.transport, history: async () => { reads += 1; return bulk() } }, store)
  const close = controller.open(btc, '1H')
  try {
    await inspectHistory(controller)
    assert.equal(store.window(btc, '1H', 599 * hour)?.bars.at(-1)?.oi, null)
    controller.scroll(-600)
    assert.equal(controller.getSnapshot().presented?.endHour, 599 * hour)
    revision = 2
    const latest = prepared(btc, 1_199, { revision })
    controller.ingestPrepared(latest)
    await settled()
    assert.equal(reads, 2)
    assert.equal(store.window(btc, '1H', 599 * hour)?.bars.at(-1)?.oi, 9_999)
    controller.ingestPrepared(latest)
    await settled()
    assert.equal(reads, 2, 'Identical data revisions must not serialize history again.')
  } finally { close() }
})

test('a newer compact revision cannot certify an older bulk read still in flight', async () => {
  const queue = transportQueue(), store = new PreparedChartStore()
  const reads: ((value: PreparedChartResponse) => void)[] = []
  store.ingest(prepared(btc, 1_199))
  const controller = new ChartController({ ...queue.transport, history: () => new Promise(resolve => { reads.push(resolve) }) }, store)
  const close = controller.open(btc, '1H')
  try {
    controller.scroll(-1)
    controller.ingestPrepared(prepared(btc, 1_199, { revision: 2 }))
    reads[0](prepared(btc, 1_199, { bars: bars(199, 1_001) }))
    await settled()
    assert.equal(reads.length, 2, 'The stale bulk read must not consume the newer durable revision notification.')
    reads[1](prepared(btc, 1_199, { revision: 2, bars: bars(199, 1_001).map(bar => ({ ...bar, oi: 9_999 })) }))
    await settled()
    assert.equal(store.window(btc, '1H', 599 * hour)?.bars.at(-1)?.oi, 9_999)
    assert.equal(controller.getSnapshot().pending, false)
  } finally { close() }
})

test('an initial chart becomes visible only as one complete prepared window', async () => {
  const queue = transportQueue()
  const controller = new ChartController(queue.transport)
  const published: number[] = []
  const unsubscribe = controller.subscribe(() => { published.push(controller.getSnapshot().presented?.bars.length ?? 0) })
  const close = controller.open(btc, '1H')
  try {
    assert.equal(controller.getSnapshot().presented, null)
    assert.equal(controller.getSnapshot().pending, true)
    await settled()
    queue.calls[0].resolve(prepared(btc, 199))
    await settled()
    assert.equal(controller.getSnapshot().presented?.endHour, 199 * hour)
    assert.equal(controller.getSnapshot().pending, false)
    assert.ok(published.every(length => length === 0 || length === 96))
  } finally { close(); unsubscribe() }
})

test('cached scrolling commits synchronously while a background request remains in flight', () => {
  const queue = transportQueue()
  const controller = new ChartController(queue.transport, cached())
  const close = controller.open(btc, '1H')
  try {
    const original = controller.getSnapshot().presented
    controller.scroll(-10)
    const view = controller.getSnapshot()
    assert.equal(view.requested?.end, 1_189 * hour)
    assert.equal(view.presented?.endHour, 1_189 * hour)
    assert.equal(view.pending, false)
    assert.notEqual(view.presented, original)
    assert.equal(queue.maximumActive(), 1)
  } finally { close() }
})

test('accelerating scrolling starts a bounded bulk prefetch before the ready edge without waiting for input to stop', async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  const queue = transportQueue()
  const controller = new ChartController(queue.transport, cached(1_000, 1_200))
  const close = controller.open(btc, '1H')
  try {
    assert.equal(queue.calls.length, 0, 'Distant history does not need network preparation while idle.')
    controller.scroll(-1)
    assert.equal(queue.calls.length, 0)
    now += 16
    controller.scroll(-24)
    assert.equal(queue.calls.length, 1)
    assert.equal(queue.calls[0].target.end, 1_094 * hour, 'The next page overlaps the earliest resident window.')
    assert.ok(queue.calls[0].target.historyBars! > 96)
    assert.ok(queue.calls[0].target.historyBars! <= 4_096)
    assert.ok(controller.getSnapshot().presented!.endHour - 1_095 * hour > 1_000 * hour, 'Fast input gets more than a thousand candles of runway.')
    for (let frame = 0; frame < 40; frame += 1) {
      now += 16
      controller.scroll(-10)
      assert.equal(controller.getSnapshot().pending, false)
    }
    assert.equal(queue.calls.length, 1, 'Ongoing input shares its in-flight prefetch.')
    now += 1_500
    queue.calls[0].resolve(prepared(btc, 1_094, { generation: 2, latestEnd: 2_199 * hour, bars: bars(199, 2_001) }))
    await settled()
    assert.equal(controller.getSnapshot().pending, false)
    const end = controller.getSnapshot().presented!.endHour
    controller.scroll(-800)
    assert.equal(controller.getSnapshot().presented?.endHour, end - 800 * hour)
    assert.equal(controller.getSnapshot().pending, false, 'Crossing the former edge reads the prefetched generation synchronously.')
  } finally { close() }
})

test('moving uncached cursors do not starve downloads behind repeated local history misses', async () => {
  const queue = transportQueue()
  const reads: ((value: PreparedChartResponse | null) => void)[] = []
  const controller = new ChartController({ ...queue.transport, history: () => new Promise(resolve => { reads.push(resolve) }) }, cached(1_000, 1_200))
  const close = controller.open(btc, '1H')
  try {
    controller.scroll(-1_500)
    controller.scroll(-20)
    assert.equal(queue.calls.length, 0, 'The first durable read can still satisfy the selected cursor.')
    reads[0](null)
    await settled()
    assert.equal(reads.length, 2, 'The current cursor can independently check durable storage.')
    assert.equal(queue.calls.length, 1, 'Source work starts despite the moving cursor and unresolved second local read.')
    assert.equal(queue.calls[0].target.end, 679 * hour)
    controller.scroll(-20)
    reads[1](null)
    await settled()
    assert.equal(queue.calls.length, 1, 'Continuous movement coalesces into the bounded source lane.')
  } finally { close() }
})

test('measured slow preparation increases the reserve for later scrolling', async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  const queue = transportQueue()
  const controller = new ChartController(queue.transport, cached())
  const close = controller.open(btc, '1H')
  controller.scroll(-1)
  controller.scroll(1)
  try {
    now += 8_000
    queue.calls[0].resolve(prepared(btc, 1_094, { latestEnd: 1_199 * hour, bars: bars(199, 1_001) }))
    await settled()
    assert.equal(queue.calls.length, 1, 'The expanded cache has enough idle reserve.')
    now += 1_000
    controller.scroll(-20)
    assert.equal(queue.calls.length, 2, 'An eight-second source response moves the trigger beyond the initial network budget.')
    assert.equal(queue.calls[1].target.end, 293 * hour)
    assert.ok(queue.calls[1].target.historyBars! > queue.calls[0].target.historyBars!)
    assert.equal(controller.getSnapshot().pending, false)
  } finally { close() }
})

test('an uncached jump beyond a slow prefetch starts foreground work immediately with bounded concurrency', async () => {
  const queue = transportQueue()
  const controller = new ChartController(queue.transport, cached())
  const close = controller.open(btc, '1H')
  controller.scroll(-1)
  controller.scroll(1)
  try {
    assert.equal(queue.calls.length, 1)
    controller.scroll(-1_000)
    assert.equal(queue.calls.length, 2, 'A distant cursor must not wait for the unrelated prefetch response.')
    assert.equal(queue.calls[1].target.end, 199 * hour)
    controller.scroll(-20)
    controller.scroll(-20)
    assert.equal(queue.calls.length, 2, 'Later misses coalesce behind the bounded foreground lane.')
    queue.calls[1].resolve(prepared(btc, 199, { latestEnd: 1_199 * hour, bars: bars(0, 200), oldestHour: 0, historyExhausted: true }))
    await settled()
    assert.equal(controller.getSnapshot().presented?.endHour, 159 * hour)
    assert.equal(controller.getSnapshot().pending, false, 'The requested chart completes while the obsolete prefetch remains unresolved.')
    assert.equal(queue.maximumActive(), 2)
  } finally { close() }
})

test('rapid uncached scrolling preserves the complete frame and prepares only the latest queued cursor', async () => {
  const queue = transportQueue()
  const controller = new ChartController(queue.transport, cached())
  const close = controller.open(btc, '1H')
  controller.scroll(-1)
  controller.scroll(1)
  try {
    const original = controller.getSnapshot().presented
    controller.scroll(-600)
    controller.scroll(100)
    controller.scroll(-200)
    assert.equal(controller.getSnapshot().requested?.end, 499 * hour)
    assert.equal(controller.getSnapshot().presented, original)
    assert.equal(controller.getSnapshot().pending, true)
    assert.equal(queue.calls.length, 1, 'Same-series provider work coalesces behind its current history request.')
    queue.calls[0].resolve(prepared(btc, 999, { latestEnd: 1_199 * hour }))
    await settled()
    assert.equal(queue.calls[1].target.end, 499 * hour)
    assert.ok(queue.calls.every(call => call.target.end !== 599 * hour && call.target.end !== 699 * hour))
    assert.equal(controller.getSnapshot().presented, original, 'A completed background range must not move the requested cursor.')
    queue.calls[1].resolve(prepared(btc, 499, { latestEnd: 1_199 * hour, revision: 2 }))
    await settled()
    assert.equal(controller.getSnapshot().presented?.endHour, 499 * hour)
    assert.equal(controller.getSnapshot().pending, false)
    assert.equal(queue.maximumActive(), 1)
  } finally { close() }
})

test('reversing to latest cancels obsolete intent without replaying it when older data arrives', async () => {
  const queue = transportQueue()
  const controller = new ChartController(queue.transport, cached())
  const close = controller.open(btc, '1H')
  controller.scroll(-1)
  controller.scroll(1)
  try {
    const latest = controller.getSnapshot().presented
    controller.scroll(-600)
    controller.scroll(600)
    assert.equal(controller.getSnapshot().requested?.end, null)
    assert.equal(controller.getSnapshot().presented, latest)
    assert.equal(controller.getSnapshot().pending, false)
    queue.calls[0].resolve(prepared(btc, 999, { latestEnd: 1_199 * hour }))
    await settled()
    assert.equal(controller.getSnapshot().requested?.end, null)
    assert.equal(controller.getSnapshot().presented, latest)
    assert.ok(queue.calls.every(call => call.target.end !== 599 * hour))
  } finally { close() }
})

test('a proven history boundary clamps the cursor once and never replays discarded scrolling', async () => {
  const queue = transportQueue()
  const controller = new ChartController(queue.transport, cached(1_104, 96))
  const close = controller.open(btc, '1H')
  try {
    controller.scroll(-10_000)
    assert.equal(controller.getSnapshot().requested?.end, 95 * hour, 'The resident cache edge must not clamp uncached intent.')
    queue.calls[0].resolve(prepared(btc, 1_105, { latestEnd: 1_199 * hour, oldestHour: 1_010 * hour, historyExhausted: true }))
    await settled()
    assert.equal(controller.getSnapshot().requested?.end, 1_105 * hour)
    assert.equal(controller.getSnapshot().presented?.endHour, 1_105 * hour)
    assert.equal(controller.getSnapshot().pending, false)
    controller.scroll(-10_000)
    await settled()
    assert.equal(controller.getSnapshot().requested?.end, 1_105 * hour)
    assert.equal(controller.getSnapshot().presented?.endHour, 1_105 * hour)
  } finally { close() }
})

test('late failures and an old component release cannot replace or deactivate a new instrument', async () => {
  const queue = transportQueue()
  const controller = new ChartController(queue.transport, cached())
  const closeBTC = controller.open(btc, '1H')
  controller.scroll(-1)
  controller.scroll(1)
  const previous = controller.getSnapshot().presented
  const closeETH = controller.open(eth, '1H')
  closeBTC()
  try {
    assert.equal(controller.getSnapshot().requested?.instId, eth)
    assert.equal(controller.getSnapshot().presented, previous)
    queue.calls[0].reject(new Error('Old BTC background failure'))
    await settled()
    assert.equal(controller.getSnapshot().error, '')
    assert.equal(queue.calls[1].target.instId, eth)
    queue.calls[1].resolve(prepared(eth, 299))
    await settled()
    assert.equal(controller.getSnapshot().presented?.instId, eth)
    assert.equal(controller.getSnapshot().pending, false)
    assert.equal(controller.getSnapshot().error, '')
  } finally { closeETH() }
})

test('a preparation failure retries the current target without publishing partial data', async () => {
  const queue = transportQueue()
  const controller = new ChartController(queue.transport)
  const close = controller.open(btc, '1H')
  try {
    await settled()
    queue.calls[0].reject(new Error('Temporary source failure'))
    await settled()
    assert.equal(controller.getSnapshot().pending, true)
    assert.equal(controller.getSnapshot().presented, null)
    assert.equal(controller.getSnapshot().error, 'Temporary source failure')
    await waitFor(() => queue.calls.length >= 2, 2_500)
    assert.equal(queue.calls[1].target.instId, btc)
    assert.equal(queue.calls[1].target.end, null)
    queue.calls[1].resolve(prepared(btc, 199))
    await settled()
    assert.equal(controller.getSnapshot().pending, false)
    assert.equal(controller.getSnapshot().presented?.bars.length, 96)
    assert.equal(controller.getSnapshot().error, '')
  } finally { close() }
})

test('explicitly unavailable observations are ready and do not wait for fabricated numeric values', async () => {
  const queue = transportQueue()
  const controller = new ChartController(queue.transport)
  const close = controller.open(btc, '1H')
  try {
    await settled()
    queue.calls[0].resolve(prepared(btc, 199, { bars: bars(104, 96).map(bar => ({ ...bar, oi: null, buy: null, sell: null, ema: null })) }))
    await settled()
    const view = controller.getSnapshot()
    assert.equal(view.pending, false)
    assert.equal(view.presented?.oiState, 'unavailable')
    assert.equal(view.presented?.takerState, 'unavailable')
    assert.equal(view.presented?.indicatorState, 'unavailable')
    assert.equal(view.presented?.bars.length, 96)
  } finally { close() }
})

test('a new calculation generation from prefetch retains the painted frame until its requested window is rebuilt', async () => {
  const queue = transportQueue()
  const controller = new ChartController(queue.transport, cached())
  const close = controller.open(btc, '1H')
  controller.scroll(-1)
  controller.scroll(1)
  try {
    const previous = controller.getSnapshot().presented!
    queue.calls[0].resolve(prepared(btc, 999, { generation: 2, latestEnd: 1_199 * hour }))
    await settled()
    assert.equal(controller.getSnapshot().requested?.end, null)
    assert.equal(controller.getSnapshot().presented, previous)
    assert.equal(controller.getSnapshot().pending, true)
    assert.equal(controller.store.window(btc, '1H'), null, 'Windows from different indicator anchors cannot be joined.')
    assert.equal(queue.calls[1].target.end, null)
    queue.calls[1].resolve(prepared(btc, 1_199, { generation: 2, revision: 2, bars: bars(1_104, 96).map(bar => ({ ...bar, ema: 200 })) }))
    await settled()
    const next = controller.getSnapshot().presented!
    assert.notEqual(next, previous)
    assert.equal(next.endHour, previous.endHour)
    assert.ok(next.bars.every(bar => bar.ema === 200))
    assert.ok(previous.bars.every(bar => bar.ema === 100))
    assert.equal(controller.getSnapshot().pending, false)
  } finally { close() }
})

test('latest mode follows pushed frames atomically and never polls a successfully prepared idle chart', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const queue = transportQueue()
  const store = new PreparedChartStore()
  store.ingest(prepared(btc, 199, { bars: bars(0, 200), oldestHour: 0, historyExhausted: true }))
  const controller = new ChartController(queue.transport, store)
  const close = controller.open(btc, '1H')
  try {
    const previous = controller.getSnapshot().presented
    context.mock.timers.tick(60_000)
    await settled()
    assert.equal(queue.calls.length, 0, 'Elapsed idle time must not request the latest window again.')
    assert.equal(controller.getSnapshot().presented, previous)
    assert.equal(controller.getSnapshot().pending, false)
    controller.ingestPrepared(prepared(btc, 200, { revision: 2, oldestHour: 0, historyExhausted: true }))
    await settled()
    assert.equal(controller.getSnapshot().presented?.endHour, 200 * hour)
    assert.equal(controller.getSnapshot().presented?.bars.length, 96)
    assert.equal(controller.getSnapshot().pending, false)
    assert.equal(previous?.endHour, 199 * hour, 'The previously painted frame remains immutable.')
    context.mock.timers.tick(600_000)
    await settled()
    assert.equal(queue.calls.length, 0, 'Successful pushed frames must not restart periodic preparation.')
  } finally { close() }
})

test('forming-only subscription deltas update the visible overlay without history reads or preparation', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const queue = transportQueue()
  let localCalls = 0, historyCalls = 0
  const controller = new ChartController({ ...queue.transport,
    local: async () => { localCalls += 1; return null },
    history: async () => { historyCalls += 1; return null },
    universe: async () => ({ frames: [prepared(btc, 199)] }),
  })
  await controller.setUniverse([btc], '1H')
  const close = controller.open(btc, '1H')
  try {
    const previous = controller.getSnapshot().presented!
    controller.ingestPrepared({ type: 'live', instId: btc, timeframe: '1H', generation: 1, revision: 2, endHour: 199 * hour,
      liveBar: { ...bars(200, 1)[0], confirmed: false, close: 101.5 } })
    const current = controller.getSnapshot().presented!
    assert.equal(current.bars, previous.bars)
    assert.equal(current.liveBar?.close, 101.5)
    assert.equal(controller.getSnapshot().pending, false)
    controller.ingestPrepared({ type: 'live', instId: btc, timeframe: '1H', generation: 2, revision: 3, endHour: 199 * hour, liveBar: null })
    assert.equal(controller.getSnapshot().presented, current, 'A delta cannot replace the completed calculation generation.')
    controller.ingestPrepared({ type: 'live', instId: btc, timeframe: '1H', generation: 1, revision: 3, endHour: 199 * hour, liveBar: null })
    assert.equal(controller.getSnapshot().presented?.liveBar, undefined)
    context.mock.timers.tick(600_000)
    await settled()
    assert.equal(localCalls, 0)
    assert.equal(historyCalls, 0)
    assert.equal(queue.calls.length, 0)
  } finally { close() }
})

test('a pushed persisted correction hydrates deep cached history without moving its cursor', async () => {
  const queue = transportQueue()
  const store = new PreparedChartStore()
  store.ingest(prepared(btc, 199, { bars: bars(0, 200), oldestHour: 0, historyExhausted: true }))
  let reads = 0
  const pending: Array<(response: PreparedChartResponse) => void> = []
  const controller = new ChartController({ ...queue.transport, history: async () => {
    reads += 1
    if (reads === 1) return prepared(btc, 199, { bars: bars(0, 200), oldestHour: 0, historyExhausted: true })
    return new Promise<PreparedChartResponse>(resolve => { pending.push(resolve) })
  } }, store)
  const close = controller.open(btc, '1H')
  try {
    await settled()
    controller.scroll(-10)
    const previous = controller.getSnapshot().presented!
    assert.equal(previous.endHour, 189 * hour)
    controller.ingestPrepared(prepared(btc, 199, { generation: 2, revision: 2, oldestHour: 0, historyExhausted: true }))
    await settled()
    assert.equal(pending.length, 1, 'A pushed new generation admits one durable history read.')
    assert.equal(controller.getSnapshot().presented, previous)
    assert.equal(controller.getSnapshot().requested?.end, 189 * hour)
    assert.equal(queue.calls.length, 0, 'Persisted corrections must not wait for provider preparation.')
    pending[0](prepared(btc, 199, {
      generation: 2, revision: 2, oldestHour: 0, historyExhausted: true,
      bars: bars(0, 200).map(bar => ({ ...bar, ema: 200, oi: 2_000 })),
    }))
    await settled()
    const next = controller.getSnapshot().presented!
    assert.notEqual(next, previous)
    assert.equal(controller.getSnapshot().requested?.end, 189 * hour)
    assert.equal(next.endHour, previous.endHour)
    assert.equal(next.bars.length, 96)
    assert.ok(next.bars.every(bar => bar.ema === 200 && bar.oi === 2_000))
    assert.ok(previous.bars.every(bar => bar.ema === 100 && bar.oi === 1_000))
    assert.equal(controller.getSnapshot().pending, false)
    assert.equal(reads, 2)
    assert.equal(queue.calls.length, 0)
  } finally { close() }
})

test('prefetch cooldown resumes prefetch at its deadline without refreshing the successful current target', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const queue = transportQueue(), controller = new ChartController(queue.transport, cached())
  const close = controller.open(btc, '1H')
  controller.scroll(-1)
  try {
    const original = controller.getSnapshot().presented
    assert.equal(queue.calls.length, 1)
    const first = queue.calls[0].target
    assert.notEqual(first.end, null)
    queue.calls[0].reject(new Error('Background history source is temporarily unavailable.'))
    await settled()
    context.mock.timers.tick(4_999)
    await settled()
    assert.equal(queue.calls.length, 1)
    context.mock.timers.tick(1)
    await settled()
    assert.equal(queue.calls.length, 2)
    assert.deepEqual(queue.calls[1].target, first, 'Cooldown expiry retries the missing reserve, not the current latest target.')
    assert.equal(controller.getSnapshot().presented, original)
    queue.calls[1].resolve(prepared(btc, first.end! / hour, { latestEnd: 1_199 * hour, bars: bars(199, 1_001) }))
    await settled()
    context.mock.timers.tick(60_000)
    await settled()
    assert.equal(queue.calls.length, 2, 'Successful reserve preparation leaves no idle polling timer.')
  } finally { close() }
})

test('a pushed recovery cancels an outstanding failed-target retry', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const queue = transportQueue(), controller = new ChartController(queue.transport)
  const close = controller.open(btc, '1H')
  try {
    await settled()
    queue.calls[0].reject(new Error('Source is temporarily unavailable.'))
    await settled()
    controller.ingestPrepared(prepared(btc, 199, { oldestHour: 104 * hour, historyExhausted: true }))
    await settled()
    assert.equal(controller.getSnapshot().error, '')
    assert.equal(controller.getSnapshot().pending, false)
    context.mock.timers.tick(60_000)
    await settled()
    assert.equal(queue.calls.length, 1, 'A complete pushed frame satisfies the demand and retires its retry timer.')
  } finally { close() }
})

test('a listing with insufficient history stops preparation until its meaningful recheck time', async () => {
  const queue = transportQueue()
  const store = new PreparedChartStore()
  store.ingest(prepared(btc, 199, { bars: bars(0, 200), oldestHour: 0, historyExhausted: true }))
  const controller = new ChartController(queue.transport, store)
  const closeBTC = controller.open(btc, '1H')
  const previous = controller.getSnapshot().presented
  const closeETH = controller.open(eth, '1H')
  try {
    await settled()
    const unavailable = { reason: 'insufficient-history' as const, availableCandles: 40, requiredCandles: 96 as const, retryAt: Date.now() + 100 }
    queue.calls[0].resolve(prepared(eth, 39, { bars: [], endHour: null, oldestHour: 0, historyExhausted: true, unavailable }))
    await settled()
    assert.equal(controller.getSnapshot().pending, false)
    assert.deepEqual(controller.getSnapshot().unavailable, unavailable)
    assert.equal(controller.getSnapshot().presented, previous, 'The prior immutable chart stays intact without pretending to show the new listing.')
    assert.equal(controller.getSnapshot().error, '')
    assert.ok(queue.calls.slice(1).every(call => call.requestedAt >= unavailable.retryAt), 'An unavailable result must not immediately enter the retry pump.')
    assert.equal(controller.store.snapshotMeta(eth, '1H'), null, 'An empty unavailable result is not prepared chart data.')
    await waitFor(() => queue.calls.length > 1, 1_000)
    assert.equal(queue.calls[1].target.instId, eth)
    assert.ok(queue.calls[1].requestedAt >= unavailable.retryAt)
    queue.calls[1].resolve(prepared(eth, 199))
    await settled()
    assert.equal(controller.getSnapshot().unavailable, null)
    assert.equal(controller.getSnapshot().pending, false)
    assert.equal(controller.getSnapshot().presented?.instId, eth)
    assert.equal(controller.getSnapshot().presented?.bars.length, 96)
  } finally { closeBTC(); closeETH() }
})

test('a stale unavailable response cannot replace the latest requested range', async () => {
  const queue = transportQueue()
  const controller = new ChartController(queue.transport, cached())
  const close = controller.open(btc, '1H')
  controller.scroll(-1)
  controller.scroll(1)
  try {
    const previous = controller.getSnapshot().presented
    controller.scroll(-600)
    queue.calls[0].resolve(prepared(btc, 999, { bars: [], endHour: null, latestEnd: 1_199 * hour,
      unavailable: { reason: 'insufficient-history', availableCandles: 40, requiredCandles: 96, retryAt: Date.now() + 60_000 } }))
    await settled()
    assert.equal(controller.getSnapshot().requested?.end, 599 * hour)
    assert.equal(controller.getSnapshot().unavailable, null)
    assert.equal(controller.getSnapshot().pending, true)
    assert.equal(controller.getSnapshot().presented, previous)
    assert.equal(queue.calls[1].target.end, 599 * hour)
    queue.calls[1].resolve(prepared(btc, 599, { latestEnd: 1_199 * hour }))
    await settled()
    assert.equal(controller.getSnapshot().presented?.endHour, 599 * hour)
    assert.equal(controller.getSnapshot().unavailable, null)
    assert.equal(controller.getSnapshot().pending, false)
  } finally { close() }
})

test('all candidate native timeframes switch synchronously beyond the history LRU without selection IPC', async () => {
  const queue = transportQueue()
  const ids = Array.from({ length: 283 }, (_, index) => `NAV${index}-USDT-SWAP`)
  const timeframes = ['5m', '15m', '1H'] as const
  let universeCalls = 0, localCalls = 0, historyCalls = 0
  const controller = new ChartController({
    ...queue.transport,
    local: async () => { localCalls += 1; return null },
    history: async () => { historyCalls += 1; return null },
    universe: async () => { universeCalls += 1; return { frames: ids.flatMap((id, index) => timeframes.map(frame => nativePrepared(id, 199, frame, 200 + index))) } },
  }, new PreparedChartStore({ maxSeries: 1 }))
  await controller.setUniverse(ids, '1H')
  ids.forEach((id, index) => controller.store.ingest(nativePrepared(id, 199, '1H', 200 + index)))
  assert.equal(controller.store.size, 1, 'Deep history must actually exceed its LRU capacity.')
  assert.equal(controller.store.latestSize, 849, 'All native latest frames remain pinned independently of history.')
  const releases: Array<() => void> = []
  try {
    for (const timeframe of timeframes) {
      await controller.setUniverse(ids.toReversed(), timeframe)
      for (const [index, id] of ids.entries()) {
        releases.push(controller.open(id, timeframe))
        const view = controller.getSnapshot()
        assert.equal(view.presented?.instId, id)
        assert.equal(view.presented?.timeframe, timeframe)
        assert.equal(view.presented?.bars.length, 96)
        assert.ok(view.presented?.bars.every(bar => bar.close === 200 + index))
        assert.equal(view.pending, false)
      }
    }
    releases.push(controller.open(ids[0], '1H'))
    assert.equal(controller.getSnapshot().presented?.instId, ids[0])
    assert.equal(controller.getSnapshot().pending, false)
    assert.equal(localCalls, 0)
    assert.equal(historyCalls, 0, 'Selection and timeframe changes do not serialize deep history.')
    await controller.setUniverse(ids.toReversed(), '1H')
    await settled()
    assert.equal(universeCalls, 1, 'Live list reordering must not serialize the whole prepared universe again.')
    assert.equal(queue.calls.length, 0, 'Warm latest selection does not request history or provider preparation.')
  } finally { releases.forEach(release => release()) }
})

test('a superseded universe handshake cannot overwrite retained frames or their generation proof', async () => {
  const queue = transportQueue()
  const replies: Array<(response: { frames: PreparedChartResponse[] }) => void> = []
  const controller = new ChartController({ ...queue.transport, universe: () => new Promise(resolve => { replies.push(resolve) }) })
  const oldHandshake = controller.setUniverse([btc, eth], '1H')
  const currentHandshake = controller.setUniverse([eth], '15m')
  replies[1]({ frames: [nativePrepared(eth, 199, '15m', 200)] })
  await currentHandshake
  const close = controller.open(eth, '15m')
  try {
    const current = controller.getSnapshot().presented!
    replies[0]({ frames: [
      { ...nativePrepared(eth, 199, '15m', 300), generation: 999 },
      nativePrepared(btc, 199, '1H', 400),
    ] })
    await oldHandshake
    assert.equal(controller.getSnapshot().presented, current)
    assert.equal(controller.store.window(btc, '1H'), null, 'Removed membership cannot be resurrected by an old handshake.')
    controller.ingestPrepared({ ...nativePrepared(eth, 199, '15m', 201), generation: 2 })
    assert.ok(controller.getSnapshot().presented?.bars.every(bar => bar.close === 201), 'The discarded reply cannot poison the current generation watermark.')
    assert.equal(queue.calls.length, 0)
  } finally { close() }
})

test('a failed universe handshake can retry unchanged membership without restarting a successful subscription', async () => {
  const queue = transportQueue()
  let handshakes = 0
  const controller = new ChartController({ ...queue.transport, universe: async () => {
    handshakes += 1
    if (handshakes === 1) throw new Error('Desktop temporarily unavailable')
    return { frames: [nativePrepared(btc, 199, '1H', 200)] }
  } })
  await controller.setUniverse([btc], '1H')
  assert.equal(controller.store.window(btc, '1H'), null)
  await controller.setUniverse([btc], '1H')
  assert.equal(handshakes, 2, 'An actual failed subscription handshake must remain retryable.')
  const close = controller.open(btc, '1H')
  try {
    assert.equal(controller.getSnapshot().pending, false)
    await controller.setUniverse([btc], '15m')
    assert.equal(handshakes, 2, 'Healthy membership does not resubscribe when changing native periods.')
    assert.equal(queue.calls.length, 0)
  } finally { close() }
})

test('a held full-frame handshake cannot rewind or resurrect a newer subscribed forming overlay', async () => {
  const queue = transportQueue()
  const replies: Array<(response: { frames: PreparedChartResponse[] }) => void> = []
  const controller = new ChartController({ ...queue.transport, universe: () => new Promise(resolve => { replies.push(resolve) }) })
  const stale = prepared(btc, 199, { liveBar: { ...bars(200, 1)[0], confirmed: false, close: 100.5 } })
  const firstHandshake = controller.setUniverse([btc], '1H')
  controller.ingestPrepared(prepared(btc, 199))
  const close = controller.open(btc, '1H')
  try {
    controller.ingestPrepared({ type: 'live', instId: btc, timeframe: '1H', generation: 1, revision: 1, endHour: 199 * hour,
      liveBar: { ...bars(200, 1)[0], confirmed: false, close: 101.5 } })
    const current = controller.getSnapshot().presented!
    replies[0]({ frames: [stale] })
    await firstHandshake
    assert.equal(controller.getSnapshot().presented?.liveBar, current.liveBar, 'The newer socket observation owns an otherwise identical confirmed frame.')
    assert.equal(controller.getSnapshot().presented?.liveBar?.close, 101.5)

    const secondHandshake = controller.setUniverse([btc, eth], '1H')
    controller.ingestPrepared({ type: 'live', instId: btc, timeframe: '1H', generation: 1, revision: 1, endHour: 199 * hour, liveBar: null })
    replies[1]({ frames: [stale] })
    await secondHandshake
    assert.equal(controller.getSnapshot().presented?.liveBar, undefined, 'A late full response cannot resurrect an overlay already cleared by the subscription.')
    assert.equal(controller.getSnapshot().presented?.bars.length, 96)
    assert.equal(controller.getSnapshot().pending, false)
    assert.equal(queue.calls.length, 0)
  } finally { close() }
})

test('a local ready selection commits while an old history request remains unresolved', async () => {
  const queue = transportQueue()
  const controller = new ChartController({ ...queue.transport, local: async id => id === eth ? prepared(eth, 299) : null }, cached())
  controller.setUniverse([btc, eth], '1H')
  const closeBTC = controller.open(btc, '1H')
  controller.scroll(-1)
  controller.scroll(1)
  const closeETH = controller.open(eth, '1H')
  try {
    assert.equal(queue.calls[0].target.instId, btc)
    assert.notEqual(controller.getSnapshot().presented?.instId, eth, 'No old candles are mislabeled as the requested instrument.')
    await settled()
    assert.equal(controller.getSnapshot().presented?.instId, eth)
    assert.equal(controller.getSnapshot().presented?.bars.length, 96)
    assert.equal(controller.getSnapshot().pending, false)
    assert.equal(queue.calls.length, 1, 'The local lane must neither await nor duplicate provider work.')
  } finally { closeBTC(); closeETH() }
})

test('an uncached different instrument can prepare beside an unresolved old history job', async () => {
  const queue = transportQueue()
  const controller = new ChartController(queue.transport, cached())
  controller.setUniverse([btc, eth], '1H')
  const closeBTC = controller.open(btc, '1H')
  controller.scroll(-1)
  controller.scroll(1)
  const closeETH = controller.open(eth, '1H')
  try {
    await settled()
    assert.equal(queue.calls[0].target.instId, btc)
    assert.equal(queue.calls[1].target.instId, eth)
    assert.equal(queue.calls[1].target.end, null)
    assert.equal(queue.maximumActive(), 2)
    queue.calls[1].resolve(prepared(eth, 299))
    await settled()
    assert.equal(controller.getSnapshot().presented?.instId, eth)
    assert.equal(controller.getSnapshot().presented?.bars.length, 96)
    assert.equal(controller.getSnapshot().pending, false)
  } finally { closeBTC(); closeETH() }
})

test('local selection and latest intent remain independent of a held old foreground request', async () => {
  const queue = transportQueue()
  const controller = new ChartController({ ...queue.transport, local: async id => id === eth ? prepared(eth, 299) : null })
  controller.setUniverse([btc], '1H')
  const closeBTC = controller.open(btc, '1H')
  await settled()
  const closeETH = controller.open(eth, '1H')
  try {
    await settled()
    const ready = controller.getSnapshot().presented!
    assert.equal(ready.instId, eth)
    assert.equal(controller.getSnapshot().pending, false)
    controller.setUniverse([btc], '1H')
    controller.ingestPrepared(prepared(eth, 299, { generation: 2, bars: bars(204, 96).map(bar => ({ ...bar, ema: 200 })) }))
    assert.ok(controller.getSnapshot().presented?.bars.every(bar => bar.ema === 200), 'The active contract remains pinned even outside the navigation candidate list.')
    queue.calls[0].resolve(prepared(btc, 199))
    await settled()
    assert.equal(controller.getSnapshot().requested?.instId, eth)
    assert.equal(controller.getSnapshot().presented?.instId, eth)
    assert.ok(ready.bars.every(bar => bar.ema === 100))
  } finally { closeBTC(); closeETH() }
})

test('cold selections bypass a held old local read and coalesce after two admitted series', async () => {
  const queue = transportQueue()
  const sol = 'SOL-USDT-SWAP'
  const localCalls: Array<{ instId: string; resolve: (response: PreparedChartResponse | null) => void }> = []
  const controller = new ChartController({
    ...queue.transport,
    local: instId => new Promise(resolve => { localCalls.push({ instId, resolve }) }),
  })
  controller.setUniverse([btc, eth, sol], '1H')
  const closeBTC = controller.open(btc, '1H')
  const closeETH = controller.open(eth, '1H')
  const closeSOL = controller.open(sol, '1H')
  try {
    assert.deepEqual(localCalls.map(call => call.instId), [btc, eth])
    localCalls[1].resolve(prepared(eth, 199))
    await settled()
    assert.deepEqual(localCalls.map(call => call.instId), [btc, eth, sol], 'The next local read starts while the first contract remains blocked.')
    assert.equal(controller.getSnapshot().requested?.instId, sol)
    assert.equal(controller.getSnapshot().presented, null, 'A completed obsolete local read must not paint its instrument for the current request.')
    localCalls[2].resolve(prepared(sol, 299))
    await settled()
    assert.equal(controller.getSnapshot().presented?.instId, sol)
    assert.equal(controller.getSnapshot().presented?.bars.length, 96)
    assert.equal(controller.getSnapshot().pending, false)
    assert.ok(queue.calls.every(call => call.target.instId === sol))
    localCalls[0].resolve(prepared(btc, 199))
    await settled()
    assert.equal(controller.getSnapshot().presented?.instId, sol, 'A late obsolete read cannot replace the selected chart.')
  } finally { closeBTC(); closeETH(); closeSOL() }
})

test('cold provider selections bypass a held old demand with bounded independent series', async () => {
  const queue = transportQueue(), sol = 'SOL-USDT-SWAP'
  const controller = new ChartController(queue.transport)
  const closeBTC = controller.open(btc, '1H')
  await settled()
  const closeETH = controller.open(eth, '1H')
  await settled()
  const closeSOL = controller.open(sol, '1H')
  try {
    await settled()
    assert.deepEqual(queue.calls.map(call => call.target.instId), [btc, eth], 'Two independent cold contracts can prepare without awaiting the first response.')
    queue.calls[1].resolve(prepared(eth, 299, { oldestHour: 204 * hour, historyExhausted: true }))
    await settled()
    assert.deepEqual(queue.calls.map(call => call.target.instId), [btc, eth, sol], 'The final queued selection uses the freed lane while BTC remains blocked.')
    assert.equal(controller.getSnapshot().presented, null)
    queue.calls[2].resolve(prepared(sol, 399, { oldestHour: 304 * hour, historyExhausted: true }))
    await settled()
    assert.equal(controller.getSnapshot().presented?.instId, sol)
    assert.equal(controller.getSnapshot().pending, false)
    queue.calls[0].reject(new Error('Obsolete blocked contract failed'))
    await settled()
    assert.equal(controller.getSnapshot().presented?.instId, sol)
    assert.equal(controller.getSnapshot().error, '')
    assert.equal(queue.maximumActive(), 2)
  } finally { closeBTC(); closeETH(); closeSOL() }
})
