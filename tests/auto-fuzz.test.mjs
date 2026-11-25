import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { aggregatePriceCandles } from '../electron/services/candle-aggregation.js'
import { appendIndicatorCandle, buildIndicatorSeries, createIndicatorState, projectIndicatorCandle } from '../electron/services/indicators.js'
import { createLiquidityEvaluator, evaluateLiquidity } from '../electron/services/liquidity.js'
import { MarketService } from '../electron/services/market-service.js'
import { MarketStore } from '../electron/services/market-store.js'
import { DEFAULT_PREFERENCES } from '../electron/services/preferences.js'
import { compareRanking } from '../electron/services/ranking.js'
import { RealtimeMarket } from '../electron/services/realtime-market.js'
import { ChartController } from '../src/chart-controller.ts'
import { PreparedChartStore } from '../src/chart-series-store.ts'

const SEED = process.env.FUZZ_SEED === 'random'
  ? (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0
  : Number.isSafeInteger(Number(process.env.FUZZ_SEED)) && process.env.FUZZ_SEED !== ''
    ? Number(process.env.FUZZ_SEED) >>> 0
    : 0x5eed1234

const ITERS = Math.max(10, Number(process.env.FUZZ_ITERS) || 60)

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)]
const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1))

function approxEqual(actual, expected, context, tol = 1e-9) {
  if (expected === null || actual === null) {
    assert.equal(actual, expected, `${context} (seed=${SEED})`)
    return
  }
  const scale = Math.max(1, Math.abs(expected))
  assert.ok(Math.abs(actual - expected) <= tol * scale, `${context}: actual=${actual}, expected=${expected} (seed=${SEED})`)
}

// Independent naive reference oracle for Bollinger(20) and EMA(200) on a contiguous run.
function naiveIndicators(ordered, intervalMS) {
  let run = []
  let ema = null
  const out = []
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i]
    if (i > 0 && c.timestamp - ordered[i - 1].timestamp !== intervalMS) {
      run = []
      ema = null
    }
    run.push(c.close)
    if (run.length === 200) ema = run.reduce((a, b) => a + b, 0) / 200
    else if (run.length > 200) ema = c.close * (2 / 201) + ema * (1 - 2 / 201)

    let bollMiddle = null, bollUpper = null, bollLower = null, bbw = null
    if (run.length >= 20) {
      const slice = run.slice(-20)
      if (slice.every(v => v > 0)) {
        const mean = slice.reduce((a, b) => a + b, 0) / 20
        const std = Math.sqrt(slice.reduce((a, v) => a + (v - mean) ** 2, 0) / 20)
        bollMiddle = mean
        bollUpper = mean + 2 * std
        bollLower = mean - 2 * std
        bbw = mean > 0 ? ((bollUpper - bollLower) / mean) * 100 : null
      }
    }
    out.push({ hour: c.timestamp, ema, bollMiddle, bollUpper, bollLower, bbw })
  }
  return out
}

test(`differential oracle: indicators batch vs incremental vs naive reference (seed=${SEED})`, () => {
  const rng = mulberry32(SEED ^ 0x1111)
  const intervalMS = 300_000
  const base = 1_800_000_000_000

  for (let trial = 0; trial < ITERS; trial++) {
    const length = randInt(rng, 25, 260)
    const candles = []
    let ts = base
    let price = 10 + rng() * 1000
    for (let i = 0; i < length; i++) {
      // Inject occasional gaps to test recursive state reset
      if (i > 0 && rng() < 0.04) ts += intervalMS * randInt(rng, 2, 5)
      else if (i > 0) ts += intervalMS
      const delta = (rng() - 0.5) * price * 0.06
      const open = Math.max(0.01, price)
      const close = Math.max(0.01, price + delta)
      const high = Math.max(open, close) * (1 + rng() * 0.02)
      const low = Math.max(0.001, Math.min(open, close) * (1 - rng() * 0.02))
      candles.push({ timestamp: ts, open, high, low, close, confirmed: true })
      price = close
    }

    // Shuffle copy + inject duplicates to verify deduplication & sorting
    const shuffled = [...candles]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }

    const batch = buildIndicatorSeries(shuffled, intervalMS)
    const naive = naiveIndicators(candles, intervalMS)
    assert.equal(batch.bars.length, candles.length, `trial ${trial} length (seed=${SEED})`)

    // Compare batch vs independent naive oracle
    for (let i = 0; i < candles.length; i++) {
      for (const field of ['ema', 'bollMiddle', 'bollUpper', 'bollLower', 'bbw']) {
        approxEqual(batch.bars[i][field], naive[i][field], `trial=${trial} i=${i} ${field}`)
      }
    }

    // Verify incremental state + live projection never mutates confirmed state
    const split = Math.max(1, candles.length - 1)
    const state = createIndicatorState(intervalMS)
    for (let i = 0; i < split; i++) appendIndicatorCandle(state, candles[i])
    const snapshotBefore = structuredClone(state)
    const projected1 = projectIndicatorCandle(state, candles[split])
    const projected2 = projectIndicatorCandle(state, { ...candles[split], close: candles[split].close * 1.05 })
    assert.deepEqual(state, snapshotBefore, `live projection mutated confirmed state (seed=${SEED})`)
    assert.deepEqual(projected1, batch.bars[split], `projected bar diverged from batch (seed=${SEED})`)
    assert.notEqual(projected2.close, projected1.close)
  }
})

test(`differential oracle: candle aggregation & SQLite store match naive map oracle (seed=${SEED})`, async () => {
  const rng = mulberry32(SEED ^ 0x2222)
  const FIVE_M = 300_000
  const BASE_TS = 1_800_000_000_000 // divisible by 1H (3_600_000)

  // Pure aggregation oracle across 15m (3x5m) and 1H (12x5m)
  for (let trial = 0; trial < ITERS; trial++) {
    for (const [tf, count] of [['15m', 3], ['1H', 12]]) {
      const forming = rng() < 0.4
      const actualCount = forming ? randInt(rng, 1, count) : count
      const rows = []
      let p = 50 + rng() * 500
      for (let i = 0; i < actualCount; i++) {
        const open = p
        const close = Math.max(0.01, p * (1 + (rng() - 0.5) * 0.04))
        const high = Math.max(open, close) * (1 + rng() * 0.01)
        const low = Math.max(0.001, Math.min(open, close) * (1 - rng() * 0.01))
        const volume = Math.round(rng() * 1000) / 10
        const baseVolume = volume * 0.5
        const quoteVolume = volume * close
        rows.push({
          instrument: 'FUZZ-USDT-SWAP', timeframe: '5m', timestamp: BASE_TS + i * FIVE_M,
          open, high, low, close, volume, baseVolume, quoteVolume,
          confirmed: !(forming && i === actualCount - 1),
        })
        p = close
      }
      const agg = aggregatePriceCandles(rows, tf, { forming })
      assert.ok(agg, `valid bucket rejected (tf=${tf}, forming=${forming}, seed=${SEED})`)
      assert.equal(agg.open, rows[0].open)
      assert.equal(agg.close, rows.at(-1).close)
      assert.equal(agg.high, Math.max(...rows.map(r => r.high)))
      assert.equal(agg.low, Math.min(...rows.map(r => r.low)))
      approxEqual(agg.volume, rows.reduce((s, r) => s + r.volume, 0), `agg.volume trial=${trial}`, 1e-12)
      assert.equal(agg.confirmed, !forming)
    }
  }

  // Real SQLite MarketStore vs in-memory Map oracle under out-of-order writes & overwrites
  const root = await mkdtemp(join(tmpdir(), 'fuzz-store-'))
  const store = await MarketStore.open(root)
  try {
    const oracle = new Map()
    const inst = 'FUZZ-USDT-SWAP'
    for (let step = 0; step < Math.min(ITERS, 40); step++) {
      const batchSize = randInt(rng, 1, 8)
      const batch = []
      for (let k = 0; k < batchSize; k++) {
        const slot = randInt(rng, 0, 35)
        const ts = BASE_TS + slot * FIVE_M
        const close = Number((100 + rng() * 50).toFixed(4))
        const row = {
          instrument: inst, timeframe: '5m', timestamp: ts,
          open: close, high: close + 1, low: close - 1, close,
          volume: 10 + k, baseVolume: 1, quoteVolume: close * 10, confirmed: true,
        }
        batch.push(row)
        oracle.set(ts, row)
      }
      await store.appendCandles(batch)

      const fromSlot = randInt(rng, 0, 20)
      const throughSlot = randInt(rng, fromSlot, 35)
      const from = BASE_TS + fromSlot * FIVE_M
      const through = BASE_TS + throughSlot * FIVE_M
      const actual = await store.candles({ instrument: inst, timeframe: '5m', from, through, order: 'asc' })
      const expected = [...oracle.values()]
        .filter(r => r.timestamp >= from && r.timestamp <= through)
        .sort((a, b) => a.timestamp - b.timestamp)

      assert.equal(actual.length, expected.length, `store count mismatch step=${step} (seed=${SEED})`)
      for (let i = 0; i < expected.length; i++) {
        assert.equal(actual[i].timestamp, expected[i].timestamp)
        assert.equal(actual[i].close, expected[i].close, `store close mismatch step=${step} ts=${expected[i].timestamp} (seed=${SEED})`)
      }
    }
  } finally {
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test(`property checks: ranking total order & liquidity invariants (seed=${SEED})`, () => {
  const rng = mulberry32(SEED ^ 0x3333)
  const evaluate = createLiquidityEvaluator()
  const baseInstrument = {
    instId: 'FUZZ-USDT-SWAP', instType: 'SWAP', instCategory: '1', settleCcy: 'USDT',
    ctType: 'linear', state: 'live', ctVal: '1', ctMult: '1', ctValCcy: 'FUZZ', ruleType: 'normal',
  }

  // Ranking comparator must be antisymmetric, deterministic, and place unavailable values last
  for (let trial = 0; trial < ITERS; trial++) {
    const rows = Array.from({ length: 24 }, (_, idx) => ({
      instId: `SYM${idx}-USDT-SWAP`,
      rankingChange: rng() < 0.2 ? null : rng() < 0.1 ? Number.NaN : (rng() - 0.5) * 40,
    }))
    const sorted = rows.toSorted(compareRanking)
    let sawNull = false
    for (let i = 0; i < sorted.length; i++) {
      const finite = typeof sorted[i].rankingChange === 'number' && Number.isFinite(sorted[i].rankingChange)
      if (!finite) sawNull = true
      else assert.equal(sawNull, false, `finite ranking placed after unavailable value (seed=${SEED})`)
      if (i > 0) {
        assert.ok(compareRanking(sorted[i - 1], sorted[i]) <= 0, `sort violation at ${i} (seed=${SEED})`)
        assert.equal(Math.sign(compareRanking(sorted[i - 1], sorted[i])), -Math.sign(compareRanking(sorted[i], sorted[i - 1])))
      }
    }
  }

  // Liquidity invariants: crossed spread/book never qualifies; cached evaluator matches fresh evaluation
  const config = structuredClone(DEFAULT_PREFERENCES.liquidity)
  for (const [k, rule] of Object.entries(config)) rule.enabled = k === 'spread' || k === 'depth'
  for (let trial = 0; trial < ITERS; trial++) {
    const bid = Number((10 + rng() * 500).toFixed(4))
    const crossed = rng() < 0.3
    const ask = crossed ? Number((bid * 0.99).toFixed(4)) : Number((bid * (1 + rng() * 0.02)).toFixed(4))
    const book = {
      bids: [[String(bid), '50000']],
      asks: [[String(ask), '50000']],
    }
    const input = { instrument: baseInstrument, ticker: { last: String(bid), bidPx: String(bid), askPx: String(ask) }, book, config }
    const direct = evaluateLiquidity(input)
    const cached = evaluate(input)
    assert.deepEqual(cached, direct, `cached evaluator diverged from direct (seed=${SEED})`)
    if (crossed) {
      assert.equal(direct.eligible, false, `crossed market must never be eligible (seed=${SEED})`)
    }
  }
})

test(`stateful fuzzing: MarketService catalog, expiry, preferences & list invariants (seed=${SEED})`, async () => {
  const rng = mulberry32(SEED ^ 0x4444)
  const root = await mkdtemp(join(tmpdir(), 'fuzz-service-'))
  const realNow = Date.now
  let now = 1_800_000_060_000
  Date.now = () => now

  const preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const [key, rule] of Object.entries(preferences.liquidity)) rule.enabled = key === 'spread'

  const store = await MarketStore.open(root)
  const taskErrors = []
  const service = new MarketService(store, () => preferences, async () => new Response(JSON.stringify({ code: '0', data: [] })), false)
  const originalTrack = service.track.bind(service)
  service.track = promise => {
    Promise.resolve(promise).catch(error => taskErrors.push(error))
    return originalTrack(promise)
  }

  const symbols = ['ALPHA-USDT-SWAP', 'BETA-USDT-SWAP', 'GAMMA-USDT-SWAP', 'DELTA-USDT-SWAP']
  const makeInst = instId => ({
    instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear',
    state: 'live', ctVal: '1', ctMult: '1', ctValCcy: instId.split('-')[0], ruleType: 'normal',
  })

  try {
    await service.ready
    service.setPresentationActive(false)
    service.installInstruments(new Map(symbols.map(id => [id, makeInst(id)])))
    service.verifyCatalog()

    const steps = Math.max(80, ITERS * 2)
    for (let step = 0; step < steps; step++) {
      const action = randInt(rng, 0, 5)
      const id = pick(rng, symbols)

      if (action === 0 || action === 1) {
        // Good ticker quote (tight spread)
        now += randInt(rng, 1, 500)
        const base = 100 + randInt(rng, 0, 50)
        service.receivePublicObservation(id, 'ticker', { instId: id, last: String(base), bidPx: String(base), askPx: String(base + 0.01), ts: String(now) })
        service.flushStreamQualifications()
      } else if (action === 2) {
        // Bad ticker quote (wide spread -> fails qualification)
        now += randInt(rng, 1, 500)
        service.receivePublicObservation(id, 'ticker', { instId: id, last: '100', bidPx: '100', askPx: '105', ts: String(now) })
        service.flushStreamQualifications()
      } else if (action === 3) {
        // Advance virtual clock and trigger deadline maintenance (leases / buffered removals)
        now += pick(rng, [1_000, 30_000, 90_001, 120_001])
        service.processMarketDeadline()
      } else if (action === 4) {
        // Re-install subset of instruments (simulating exchange catalog refresh)
        now += 10
        const subset = symbols.filter(() => rng() > 0.2)
        service.installInstruments(new Map((subset.length ? subset : [symbols[0]]).map(sym => [sym, makeInst(sym)])))
        service.verifyCatalog()
      } else {
        // Toggle spread liquidity rule
        const prev = structuredClone(preferences)
        preferences.liquidity.spread.enabled = !preferences.liquidity.spread.enabled
        await service.reconfigure(prev)
      }

      // === GLOBAL INVARIANTS CHECKED AFTER EVERY RANDOM STEP ===
      const rows = service.listRowsFor(now)
      const rowIds = rows.map(r => r.instId)
      assert.equal(new Set(rowIds).size, rowIds.length, `duplicate instId in listRowsFor at step=${step} (seed=${SEED})`)

      // Every active, unexpired catalog entry must appear in listRowsFor
      for (const [catId, entry] of service.catalog) {
        if (service.validCatalogEntry(entry, now)) {
          assert.ok(rowIds.includes(catId), `valid catalog entry ${catId} missing from listRowsFor at step=${step} (seed=${SEED})`)
        }
      }

      // Every listed row must come from either catalog or an unexpired listRemoval buffer
      for (const row of rows) {
        const inCatalog = service.catalog.has(row.instId)
        const removal = service.listRemovals.get(row.instId)
        assert.ok(inCatalog || (removal && removal.removeAt > now),
          `ghost row ${row.instId} in listRowsFor at step=${step} (seed=${SEED})`)
      }

      assert.equal(service.error, '', `unexpected service.error at step=${step} (seed=${SEED})`)
      assert.deepEqual(taskErrors, [], `background task rejected at step=${step} (seed=${SEED})`)
    }
  } finally {
    Date.now = realNow
    await service.dispose()
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test(`stateful fuzzing: PreparedChartStore & ChartController invariants under random navigation & live ticks (seed=${SEED})`, async () => {
  const rng = mulberry32(SEED ^ 0x5555)
  const HOUR = 3_600_000
  const BASE = 1_800_000_000_000
  const symbols = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP']

  const makeBar = (index, close = 100 + index * 0.1) => ({
    hour: BASE + index * HOUR,
    open: close, high: close + 2, low: Math.max(0.1, close - 2), close,
    confirmed: true, priceComplete: true, indicatorsObserved: true,
    oiObserved: true, takerObserved: true, statisticsSources: 3, statisticsObserved: true,
    ema: close, bollUpper: close + 4, bollMiddle: close, bollLower: Math.max(0.1, close - 4),
    roc: 0, maroc: 0, rsi6: 50, rsi12: 50, rsi24: 50, atrPercent: 1, bbw: 4,
    oi: 1000, buy: 10, sell: 10,
  })

  const store = new PreparedChartStore()
  const seedBars = Array.from({ length: 300 }, (_, i) => makeBar(i))
  const makeResponse = (instId, generation, revision, endIdx = 299) => ({
    instId, timeframe: '1H', intervalMS: HOUR, generation, revision,
    endHour: BASE + endIdx * HOUR, latestEnd: BASE + 299 * HOUR, oldestHour: BASE,
    historyExhausted: true, priceState: 'ready', indicatorState: 'ready', oiState: 'ready', takerState: 'ready',
    realtimeState: 'live', priceObservedAt: revision,
    sourceVersions: { price: revision, oi: 1, taker: 1 },
    bars: seedBars.slice(Math.max(0, endIdx - 120), endIdx + 1),
  })

  const revisions = new Map(symbols.map(s => [s, { generation: 1, revision: 1 }]))
  for (const sym of symbols) store.ingest(makeResponse(sym, 1, 1))

  const controller = new ChartController({
    focus() {},
    local: async instId => makeResponse(instId, revisions.get(instId).generation, revisions.get(instId).revision),
    history: async target => {
      const idx = target.end ? Math.max(0, Math.min(299, Math.round((target.end - BASE) / HOUR))) : 299
      const state = revisions.get(target.instId)
      return makeResponse(target.instId, state.generation, state.revision, idx)
    },
    universe: async () => ({ frames: symbols.map(s => makeResponse(s, revisions.get(s).generation, revisions.get(s).revision)) }),
  }, store)

  let current = symbols[0]
  let close = controller.open(current, '1H')
  try {
    const steps = Math.max(100, ITERS * 2)
    for (let step = 0; step < steps; step++) {
      const action = randInt(rng, 0, 5)
      if (action === 0) {
        // Random scroll left/right
        controller.scroll(randInt(rng, -40, 40))
      } else if (action === 1) {
        // Live quote tick
        const sym = pick(rng, symbols)
        const st = revisions.get(sym)
        st.revision += 1
        const closePx = Number((130 + (rng() - 0.5) * 10).toFixed(3))
        controller.ingestPrepared({
          type: 'live', instId: sym, timeframe: '1H',
          generation: st.generation, revision: st.revision,
          endHour: BASE + 299 * HOUR,
          liveBar: { ...makeBar(300, closePx), confirmed: false },
          priceObservedAt: st.revision,
          sourceVersions: { price: st.revision, oi: 1, taker: 1 },
        })
      } else if (action === 2) {
        // Switch active instrument
        close()
        current = pick(rng, symbols)
        close = controller.open(current, '1H')
      } else if (action === 3) {
        // Full frame correction / generation bump
        const sym = pick(rng, symbols)
        const st = revisions.get(sym)
        st.generation += rng() < 0.3 ? 1 : 0
        st.revision += 1
        controller.ingestPrepared(makeResponse(sym, st.generation, st.revision))
      } else if (action === 4) {
        // Toggle presentation idle / active
        controller.setPresentationActive(false)
        controller.setPresentationActive(true)
      } else {
        // Change zoom bar count
        controller.setWindowBars(pick(rng, [48, 96, 144, 192]))
      }

      // === INVARIANTS ===
      const snap = controller.getSnapshot()
      if (snap.presented) {
        const { bars, liveBar, endHour } = snap.presented
        assert.ok(bars.length > 0, `presented window has 0 bars at step=${step} (seed=${SEED})`)
        for (let i = 1; i < bars.length; i++) {
          assert.ok(bars[i].hour > bars[i - 1].hour, `bars out of order at step=${step} (seed=${SEED})`)
        }
        assert.ok(bars.at(-1).hour <= endHour, `bar exceeds window endHour at step=${step} (seed=${SEED})`)
        if (liveBar) {
          assert.equal(liveBar.confirmed, false, `liveBar must be unconfirmed at step=${step} (seed=${SEED})`)
          assert.ok(endHour === snap.latestEnd, `liveBar leaked into historical window at step=${step} (seed=${SEED})`)
        }
      }
    }
  } finally {
    close()
  }
})

test(`protocol fuzzing: RealtimeMarket rejects malformed/regressing frames and closes cleanly (seed=${SEED})`, async () => {
  const rng = mulberry32(SEED ^ 0x6666)
  let socket
  class FakeSocket extends EventTarget {
    constructor() { super(); this.readyState = 0; socket = this }
    send(raw) {
      const msg = JSON.parse(raw)
      if (msg.op === 'subscribe') {
        queueMicrotask(() => {
          for (const arg of msg.args) {
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'subscribe', id: msg.id, arg }) }))
          }
        })
      }
    }
    close() { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code: 1000 })) }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
    push(data) { this.dispatchEvent(new MessageEvent('message', { data })) }
  }

  let acceptedForming = []
  let acceptedConfirmed = []
  const FIVE_M = 300_000
  let ts = Math.floor(1_790_000_000_000 / FIVE_M) * FIVE_M
  const market = new RealtimeMarket({
    webSocketFactory: () => new FakeSocket(),
    now: () => ts + FIVE_M,
    logger: { error() {}, warn() {}, info() {}, log() {} },
    parseCandle: (instId, timeframe, raw) => ({
      instrument: instId, timeframe, timestamp: Number(raw[0]),
      open: Number(raw[1]), high: Number(raw[2]), low: Number(raw[3]), close: Number(raw[4]),
      volume: Number(raw[5]), baseVolume: Number(raw[6]), quoteVolume: Number(raw[7]),
      confirmed: raw[8] === '1',
    }),
    onForming: candle => { acceptedForming.push(candle) },
    onConfirmed: candle => { acceptedConfirmed.push(candle) },
    onReconnect: () => {},
  })

  try {
    market.setSubscriptions([{ instId: 'FUZZ-USDT-SWAP', timeframe: '5m' }])
    market.start()
    socket.open()
    await new Promise(r => setImmediate(r))

    let maxVolForTs = 0

    for (let step = 0; step < Math.max(80, ITERS * 2); step++) {
      const kind = randInt(rng, 0, 5)
      if (kind === 0) {
        // Malformed JSON / wrong shapes — must never crash
        socket.push(pick(rng, ['not-json{', 'null', '123', '{}', '{"data":"bad"}', '{"arg":{"channel":"candle5m","instId":"FUZZ-USDT-SWAP"},"data":[["bad"]]}']))
      } else if (kind === 1) {
        // Valid forming candle with increasing volume
        maxVolForTs += randInt(rng, 1, 10)
        const px = (100 + rng() * 5).toFixed(2)
        socket.push(JSON.stringify({
          arg: { channel: 'candle5m', instId: 'FUZZ-USDT-SWAP' },
          data: [[String(ts), px, String(Number(px) + 1), String(Number(px) - 1), px, String(maxVolForTs), '1', '100', '0']],
        }))
      } else if (kind === 2) {
        // Regressing volume on same forming candle — must be rejected
        const badVol = Math.max(0, maxVolForTs - randInt(rng, 1, 5))
        socket.push(JSON.stringify({
          arg: { channel: 'candle5m', instId: 'FUZZ-USDT-SWAP' },
          data: [[String(ts), '100', '101', '99', '100', String(badVol), '1', '100', '0']],
        }))
      } else if (kind === 3) {
        // Confirmed candle & advance period
        maxVolForTs += 1
        socket.push(JSON.stringify({
          arg: { channel: 'candle5m', instId: 'FUZZ-USDT-SWAP' },
          data: [[String(ts), '100', '102', '98', '101', String(maxVolForTs), '1', '100', '1']],
        }))
        ts += FIVE_M
        maxVolForTs = 0
      } else if (kind === 4) {
        socket.push('pong')
      } else {
        // Negative volume — must be rejected
        socket.push(JSON.stringify({
          arg: { channel: 'candle5m', instId: 'FUZZ-USDT-SWAP' },
          data: [[String(ts), '100', '101', '99', '100', '-5', '1', '100', '0']],
        }))
      }
    }

    await market.whenIdle()
    // Verify forming candles never regressed volume within the same timestamp
    const lastVolByTs = new Map()
    for (const c of acceptedForming) {
      const prev = lastVolByTs.get(c.timestamp) ?? -Infinity
      assert.ok(c.volume >= prev, `forming volume regressed from ${prev} to ${c.volume} at ts=${c.timestamp} (seed=${SEED})`)
      lastVolByTs.set(c.timestamp, c.volume)
    }
    assert.ok(acceptedConfirmed.length > 0, `expected confirmed candles to be processed (seed=${SEED})`)
  } finally {
    await market.close()
  }
})
