import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

// Run this same file against each checkout. Fixture setup, warmup, and semantic
// checks are outside the measured region; there is no network, disk, or GUI work.
// node scripts/energy-work-benchmark.mjs --source-root .build/baseline --rounds 32
// node scripts/energy-work-benchmark.mjs --source-root . --rounds 32
// Compare correctness.digest before comparing CPU; timings have no CI threshold.
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const intervalMS = 900_000
const clockStart = Date.UTC(2026, 9, 18, 12, 0, 10)
const latestHour = Math.floor(clockStart / intervalMS) * intervalMS - intervalMS
const indicatorFields = ['ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24']
const blankIndicators = Object.fromEntries(indicatorFields.map(field => [field, null]))

const integer = (value, name, minimum, maximum) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}.`)
  return value
}
const round = value => Math.round(value * 1000) / 1000
const semanticFrame = ({ revision: _revision, ...frame }) => frame
const semanticJSON = value => JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : child)

function candle(contract, index, rows) {
  const close = 100 + contract * 3 + index * .01 + (index % 17 - 8) * .002
  return { instrument: `ENERGY${String(contract).padStart(3, '0')}-USDT-SWAP`, timeframe: '15m',
    timestamp: latestHour - (rows - 1 - index) * intervalMS,
    open: close - .02, high: close + .06, low: close - .05, close,
    volume: 100 + index % 7, baseVolume: 100 + index % 7, quoteVolume: close * (100 + index % 7),
    oi: 5000 + index, buy: 60 + index % 7, sell: 40, statisticsVersion: 1, confirmed: true }
}

function tick(state, sequence) {
  const previous = state.rows.get(state.latestHour), close = previous.close + sequence * .001
  state.live = { ...previous, timestamp: state.latestHour + intervalMS, confirmed: false,
    open: previous.close, high: Math.max(previous.close, close) + .01,
    low: Math.min(previous.close, close) - .01, close, volume: 100 + sequence,
    baseVolume: 100 + sequence, quoteVolume: close * (100 + sequence) }
  state.observedAt = clockStart
}

const expectedBar = (row, calculated) => ({ ...blankIndicators, ...calculated,
  hour: row.timestamp, open: row.open, high: row.high, low: row.low, close: row.close, confirmed: row.confirmed,
  oi: row.oi, buy: row.buy, sell: row.sell, statisticsSources: 3,
  statisticsObserved: true, oiObserved: true, takerObserved: true,
  indicatorsObserved: Boolean(calculated), oiUnavailableReason: undefined, takerUnavailableReason: undefined })

/** Fixed work, deterministic inputs, and process CPU (including worker threads).
 * The workload exercises frame projection directly; it does not claim to measure
 * whole-app energy, renderer paint, WebSocket parsing, or network consumption.
 */
export async function runPreparedFrameBenchmark(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? repositoryRoot)
  const contracts = integer(options.contracts ?? 287, 'contracts', 1, 1000)
  const rows = integer(options.rows ?? 1536, 'rows', 512, 4096)
  const rounds = integer(options.rounds ?? 4, 'rounds', 1, 1000)
  const warmupRounds = integer(options.warmupRounds ?? 2, 'warmupRounds', 1, 100)
  const [{ PreparedChartPipeline }, { buildIndicatorSeries, projectIndicatorCandle }] = await Promise.all([
    import(pathToFileURL(resolve(sourceRoot, 'electron/services/prepared-chart-service.js')).href),
    import(pathToFileURL(resolve(sourceRoot, 'electron/services/indicators.js')).href),
  ])
  const pipeline = new PreparedChartPipeline({ store: {}, history: {}, normalize: row => row,
    revision: () => 0, instrument: () => undefined, streaming: () => true })
  const actualNow = Date.now, clock = { now: clockStart }
  Date.now = () => clock.now
  try {
    const states = Array.from({ length: contracts }, (_, contract) => {
      const source = Array.from({ length: rows }, (_, index) => candle(contract, index, rows))
      const calculated = buildIndicatorSeries(source, intervalMS)
      const state = pipeline.state(source[0].instrument, '15m')
      Object.assign(state, { rows: new Map(source.map(row => [row.timestamp, row])),
        indicators: new Map(calculated.bars.map(bar => [bar.hour, bar])), indicatorState: calculated.state,
        latestHour, floor: source[0].timestamp, loaded: true, indicatorVersion: 1 })
      return state
    })
    for (let sequence = 1; sequence <= warmupRounds; sequence += 1) for (const state of states) {
      tick(state, sequence)
      pipeline.frame(state)
    }

    const digest = createHash('sha256')
    let checkedFrames = 0, checkedBars = 0
    const record = (phase, state, frame) => {
      digest.update(semanticJSON({ phase, frame: semanticFrame(frame) }))
      checkedFrames += 1
      checkedBars += frame.bars.length
      assert.equal(frame.instId, state.instId)
      assert.equal(frame.bars.length, 96)
      const expectedRows = [...state.rows.values()].filter(row => row.timestamp <= frame.endHour && row.timestamp >= frame.endHour - 95 * intervalMS).sort((a, b) => a.timestamp - b.timestamp)
      // Full visible values, including all indicators, must agree with the
      // original immutable source and its independently calculated full prefix.
      if (phase !== 'leased-statistic' && phase !== 'expired-statistic') {
        assert.deepEqual(frame.bars, expectedRows.map(row => expectedBar(row, state.indicators.get(row.timestamp))))
        assert.equal(frame.oiState, 'ready')
        assert.equal(frame.takerState, 'ready')
      }
      assert.equal(frame.indicatorState, 'ready')
      if (frame.liveBar) {
        assert.deepEqual(frame.liveBar, expectedBar(state.live, projectIndicatorCandle(state.indicatorState, state.live)))
        assert.equal(frame.realtimeState, 'live')
      }
    }
    for (const state of states) record('warm', state, pipeline.frame(state))

    const previousBars = states.map(state => pipeline.frame(state).bars)
    const heapBefore = process.memoryUsage().heapUsed
    const cpuBefore = process.cpuUsage(), startedAt = performance.now()
    let frames = 0, reusedBarArrays = 0, liveCloseSum = 0
    for (let sequence = 1; sequence <= rounds; sequence += 1) {
      for (let index = 0; index < states.length; index += 1) {
        const state = states[index]
        tick(state, sequence)
        const frame = pipeline.frame(state)
        if (frame.bars === previousBars[index]) reusedBarArrays += 1
        previousBars[index] = frame.bars
        liveCloseSum += frame.liveBar.close
        frames += 1
      }
    }
    const elapsedMS = performance.now() - startedAt, cpu = process.cpuUsage(cpuBefore)
    const heapAfter = process.memoryUsage().heapUsed
    for (const state of states) record('final', state, pipeline.frame(state))

    // Untimed invalidation probes keep the digest sensitive to navigation,
    // corrected prices/indicators, statistic observations and lease expiry.
    const state = states[0]
    record('history', state, pipeline.frame(state, latestHour - 128 * intervalMS))
    const corrected = { ...state.rows.get(latestHour - intervalMS), close: state.rows.get(latestHour - intervalMS).close + .1 }
    corrected.high = Math.max(corrected.high, corrected.close)
    state.rows.set(corrected.timestamp, corrected)
    const recalculated = buildIndicatorSeries([...state.rows.values()], intervalMS)
    state.indicators = new Map(recalculated.bars.map(bar => [bar.hour, bar]))
    state.indicatorState = recalculated.state
    state.sourceVersion += 1; state.priceVersion += 1; state.indicatorVersion += 1; state.generation += 1
    record('correction', state, pipeline.frame(state))
    const finalRow = state.rows.get(latestHour)
    state.rows.set(latestHour, { ...finalRow, oi: null, statisticsVersion: 11, statisticsOIExpiresAt: clock.now + 100 })
    state.sourceVersion += 1; state.oiVersion += 1
    const leased = pipeline.frame(state)
    record('leased-statistic', state, leased)
    assert.equal(leased.oiState, 'unavailable')
    assert.equal(leased.bars.at(-1).oi, null)
    assert.equal(leased.bars.at(-1).oiObserved, true)
    clock.now += 100
    const expired = pipeline.frame(state)
    record('expired-statistic', state, expired)
    assert.equal(expired.oiState, 'loading')
    assert.equal(expired.bars.at(-1).oiObserved, false)
    state.rows.set(latestHour, finalRow)
    state.sourceVersion += 1; state.oiVersion += 1
    record('restored-statistic', state, pipeline.frame(state))

    return { benchmark: 'prepared chart live-frame work', sourceRoot,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      workload: { contracts, confirmedRowsPerContract: rows, visibleBars: 96, rounds, warmupRounds,
        frames, generatedIndicators: indicatorFields, fixedClock: new Date(clockStart).toISOString() },
      measurement: { userCPUMS: round(cpu.user / 1000), systemCPUMS: round(cpu.system / 1000),
        totalCPUMS: round((cpu.user + cpu.system) / 1000), elapsedMS: round(elapsedMS),
        cpuMicrosecondsPerFrame: round((cpu.user + cpu.system) / frames),
        heapBeforeBytes: heapBefore, heapAfterBytes: heapAfter, heapDeltaBytes: heapAfter - heapBefore },
      work: { reusedBarArrays, liveCloseSum },
      correctness: { checkedFrames, checkedBars, digest: digest.digest('hex'), passed: true },
      limitations: 'A deterministic CPU workload, not a whole-app energy measurement. Heap delta may include garbage collection. Setup, warmup, and correctness checks are excluded; no timing threshold.' }
  } finally {
    Date.now = actualNow
    await pipeline.dispose()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    'source-root': { type: 'string', default: repositoryRoot }, contracts: { type: 'string', default: '287' },
    rows: { type: 'string', default: '1536' }, rounds: { type: 'string', default: '4' },
    'warmup-rounds': { type: 'string', default: '2' }, report: { type: 'string' },
  } })
  const report = await runPreparedFrameBenchmark({ sourceRoot: values['source-root'], contracts: Number(values.contracts),
    rows: Number(values.rows), rounds: Number(values.rounds), warmupRounds: Number(values['warmup-rounds']) })
  const output = `${JSON.stringify(report, null, 2)}\n`
  if (values.report) { const path = resolve(values.report); await mkdir(dirname(path), { recursive: true }); await writeFile(path, output) }
  process.stdout.write(output)
}
