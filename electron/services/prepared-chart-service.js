import { Worker } from 'node:worker_threads'

const VISIBLE = 96
const WARMUP = 199
const PRICE_PAGE = 300
const STATISTICS_PAGE = 100
const HISTORY_PERIODS = 1_440
const priceFields = ['timestamp', 'open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'confirmed']
const indicatorFields = ['ema', 'vwap', 'logBBUpper', 'logBBMiddle', 'logBBLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24']
const intervalFor = timeframe => timeframe === '5m' ? 300_000 : timeframe === '15m' ? 900_000 : 3_600_000
const priceChanged = (left, right) => !left || priceFields.some(field => left[field] !== right[field])
const extremeHour = (rows, minimum = false) => {
  let result = minimum ? Infinity : -Infinity
  for (const hour of rows.keys()) result = minimum ? Math.min(result, hour) : Math.max(result, hour)
  return Number.isFinite(result) ? result : null
}
const sourcePresent = (row, source) => (row.statisticsVersion === 1 ? 3 : Number(row.statisticsVersion ?? 0) & 3) & source
const sourceMissing = (row, source) => source === 1 ? row.oi === null : row.buy === null || row.sell === null
const expiryField = source => source === 1 ? 'statisticsOIExpiresAt' : 'statisticsTakerExpiresAt'
const sourceFresh = (row, source, now = Date.now()) => sourcePresent(row, source)
  && (!sourceMissing(row, source) || Number(row[expiryField(source)]) > now)

/** Durable source pages and canonical calculations are independent of UI focus. */
export class PreparedChartPipeline {
  constructor({ store, get, parseCandle, normalize, persistCandles, persistStatistics, revision, liveCandles, instrument }) {
    Object.assign(this, { store, get, parseCandle, normalize, persistCandles, persistStatistics, revision, liveCandles, instrument })
    this.series = new Map()
    this.nextGeneration = 0
    this.maxSeries = 8
    this.maxRows = 100_000
    this.tasks = new Map()
    this.calculations = new Map()
    this.nextCalculation = 0
    this.worker = null
    this.closed = false
  }

  state(instId, timeframe) {
    const key = `${instId}:${timeframe}`
    let state = this.series.get(key)
    if (!state) {
      state = { key, instId, timeframe, intervalMS: intervalFor(timeframe), rows: new Map(), loaded: false, loading: null,
        priceVersion: 0, calculatedVersion: -1, calculation: null, indicators: new Map(), generation: ++this.nextGeneration, active: 0,
        floor: null, latestTask: null, latestAt: 0, live: null, liveVersion: 0, calculatedLiveVersion: -1 }
    }
    this.series.delete(key)
    this.series.set(key, state)
    return state
  }

  trim() {
    let rows = 0
    for (const state of this.series.values()) rows += state.rows.size
    for (const [key, state] of this.series) {
      if (this.series.size <= this.maxSeries && rows <= this.maxRows) break
      if (state.active || this.series.size === 1) continue
      rows -= state.rows.size
      this.series.delete(key)
    }
  }

  observe(rows, previous) {
    for (const [key, batch] of Map.groupBy(rows, row => `${row.instrument}:${row.timeframe}`)) {
      const state = this.series.get(key)
      if (!state) continue
      let changed = false, reseed = false
      const oldLatest = extremeHour(state.rows) ?? -Infinity
      for (const row of batch) {
        const old = previous.get(row.timestamp)
        if (priceChanged(old, row)) {
          changed = true
          if (state.loaded && row.timestamp <= oldLatest) reseed = true
        }
        if (state.loaded) state.rows.set(row.timestamp, this.normalize(row))
      }
      if (changed) state.priceVersion += 1
      if (reseed) state.generation = ++this.nextGeneration
    }
    this.trim()
  }

  async load(state) {
    if (state.loaded) return
    if (state.loading) return state.loading
    state.loading = (async () => {
      while (!this.closed) {
        const version = state.priceVersion
        const rows = await this.store.candles({ instrument: state.instId, timeframe: state.timeframe }, 'foreground')
        if (version !== state.priceVersion) continue
        state.rows = new Map(rows.filter(row => row.confirmed).map(row => [row.timestamp, this.normalize(row)]))
        state.loaded = true
        return
      }
      throw new Error('Prepared chart data service is closed.')
    })().finally(() => { state.loading = null })
    return state.loading
  }

  job(key, operation) {
    const pending = this.tasks.get(key)
    if (pending) return pending
    const task = Promise.resolve().then(() => {
      if (this.closed) throw new Error('Prepared chart data service is closed.')
      return operation()
    }).finally(() => { if (this.tasks.get(key) === task) this.tasks.delete(key) })
    this.tasks.set(key, task)
    return task
  }

  latest(state) { return extremeHour(state.rows) }

  async refreshLatest(state) {
    if (state.latestTask) return state.latestTask
    if (state.latestAt + 60_000 > Date.now()) return
    state.latestTask = (async () => {
      const values = await this.get('/market/candles', { instId: state.instId, bar: state.timeframe, limit: PRICE_PAGE })
      const rows = values.map(value => this.parseCandle(state.instId, state.timeframe, value)).filter(Boolean)
      const insufficientListing = state.floor !== null && Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS < state.floor + (VISIBLE - 1) * state.intervalMS
      if (!rows.some(row => row.confirmed) && this.latest(state) === null && !insufficientListing) throw new Error('OKX has not provided completed source candles.')
      await this.persistCandles(state.instId, rows.filter(row => row.confirmed))
      const live = rows.find(row => !row.confirmed) ?? null
      if (JSON.stringify(live) !== JSON.stringify(state.live)) { state.live = live; state.liveVersion += 1 }
      if (state.timeframe === '5m' && live) this.liveCandles.set(state.instId, live)
      state.latestAt = Date.now()
    })().finally(() => { state.latestTask = null })
    return state.latestTask
  }

  async priceBlock(state, block, through) {
    const step = state.intervalMS, from = block * PRICE_PAGE * step
    const end = Math.min(from + (PRICE_PAGE - 1) * step, through)
    return this.job(`price:${state.key}:${block}`, async () => {
      const missing = []
      for (let hour = Math.max(from, state.floor ?? from); hour <= end; hour += step) if (!state.rows.has(hour)) missing.push(hour)
      while (missing.length) {
        const cursor = missing.at(-1)
        const first = missing[0]
        const limit = Math.min(PRICE_PAGE, Math.floor((cursor - first) / step) + 1)
        const values = await this.get('/market/history-candles', { instId: state.instId, bar: state.timeframe, limit, after: cursor + step })
        const rows = values.map(value => this.parseCandle(state.instId, state.timeframe, value)).filter(row => row?.confirmed)
        if (!rows.length) {
          const oldest = extremeHour(state.rows, true)
          if (oldest !== null && cursor < oldest) {
            // An empty historical cursor, rather than the resident cache edge,
            // proves the provider boundary. Verify it before restricting scroll.
            for (let attempt = 0; attempt < 2; attempt += 1) {
              const check = await this.get('/market/history-candles', { instId: state.instId, bar: state.timeframe, limit: 1, after: cursor + step })
              if (check.some(value => this.parseCandle(state.instId, state.timeframe, value)?.confirmed)) throw new Error('OKX historical candle boundary is not stable; retry this range.')
            }
            state.floor = await this.discoverFloor(state, cursor, oldest)
            return
          }
          throw new Error('OKX did not provide the missing source candle range.')
        }
        await this.persistCandles(state.instId, rows)
        const before = missing.length
        for (let index = missing.length - 1; index >= 0; index -= 1) if (state.rows.has(missing[index]) || state.floor !== null && missing[index] < state.floor) missing.splice(index, 1)
        if (missing.length === before) throw new Error('OKX source candle cursor did not advance.')
      }
    })
  }

  async discoverFloor(state, emptyThrough, knownHour) {
    const step = state.intervalMS
    let lower = emptyThrough + step, upper = knownHour
    // An empty far-past cursor does not make the resident cache edge the
    // listing edge. Locate the first actual provider observation in between.
    for (let attempt = 0; lower < upper && attempt < 48; attempt += 1) {
      const middle = lower + Math.floor((upper - lower) / step / 2) * step
      const values = await this.get('/market/history-candles', { instId: state.instId, bar: state.timeframe, limit: 1, after: middle + step })
      const rows = values.map(value => this.parseCandle(state.instId, state.timeframe, value)).filter(row => row?.confirmed)
      if (!rows.length) lower = middle + step
      else {
        const earliest = Math.min(...rows.map(row => row.timestamp))
        if (earliest < lower || earliest > middle) throw new Error('OKX historical candle boundary changed during preparation.')
        await this.persistCandles(state.instId, rows)
        upper = earliest
      }
    }
    if (lower !== upper) throw new Error('Cannot determine the available source history boundary.')
    return upper
  }

  async ensurePrices(state, from, through) {
    const size = PRICE_PAGE * state.intervalMS
    while (true) {
      const blocks = new Set()
      for (let hour = Math.max(from, state.floor ?? from); hour <= through; hour += state.intervalMS) {
        if (!state.rows.has(hour)) blocks.add(Math.floor(hour / size))
      }
      if (!blocks.size) return
      // Fill stable blocks only through known/requested completed data. The
      // exchange may publish its latest completed candle slightly late.
      const latestClosed = Math.min(Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS, Math.max(through, this.latest(state) ?? through))
      for (const block of [...blocks].sort((left, right) => right - left)) await this.priceBlock(state, block, latestClosed)
      // A concurrent request can have shared a shorter live-tail block. Read
      // its committed rows before asking for any still-missing extension.
    }
  }

  async statisticsBlock(state, block, source) {
    const step = state.intervalMS, from = block * STATISTICS_PAGE * step
    const end = Math.min(from + (STATISTICS_PAGE - 1) * step, this.latest(state))
    if (end < from) return
    return this.job(`statistics:${state.key}:${block}:${source}`, async () => {
      const rows = []
      for (let hour = from; hour <= end; hour += step) {
        const row = state.rows.get(hour)
        if (row && !sourceFresh(row, source)) rows.push(row)
      }
      if (!rows.length) return
      const earliest = rows[0].timestamp, latest = rows.at(-1).timestamp
      const outsideRetention = latest < Date.now() - HISTORY_PERIODS * step
      let values = []
      if (!outsideRetention) {
        const path = source === 1 ? '/rubik/stat/contracts/open-interest-history' : '/rubik/stat/taker-volume-contract'
        const parameters = { instId: state.instId, period: state.timeframe, limit: STATISTICS_PAGE, begin: earliest - 1, end: latest + 1 }
        if (source === 2) parameters.unit = 1
        values = await this.get(path, parameters)
      }
      // Only successful source observations (including a known retention
      // boundary) become terminal nulls. Transport errors leave the page pending.
      await this.persistStatistics({ instId: state.instId }, state.timeframe, end, source, values, { from, through: end, intervalMS: step })
    })
  }

  async ensureStatistics(state, from, through) {
    const size = STATISTICS_PAGE * state.intervalMS
    const pages = new Map()
    for (let hour = from; hour <= through; hour += state.intervalMS) {
      const row = state.rows.get(hour)
      for (const source of [1, 2]) if (!sourceFresh(row, source)) {
        const block = Math.floor(hour / size)
        pages.set(`${block}:${source}`, { block, source })
      }
    }
    // A known complete 96-window must not wait for a page's four extra
    // observations. They will be prepared when a neighbor actually needs them.
    const completed = await Promise.allSettled([...pages.values()].map(({ block, source }) => this.statisticsBlock(state, block, source)))
    const failure = completed.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
  }

  calculate(candles, intervalMS) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./prepared-chart-worker.js', import.meta.url))
      this.worker.unref()
      this.worker.on('message', ({ id, bars, error }) => {
        const pending = this.calculations.get(id)
        if (!pending) return
        this.calculations.delete(id)
        if (!this.calculations.size) this.worker?.unref()
        if (error) pending.reject(new Error(error))
        else pending.resolve(bars)
      })
      this.worker.on('error', error => {
        for (const pending of this.calculations.values()) pending.reject(error)
        this.calculations.clear()
        this.worker = null
      })
    }
    const id = ++this.nextCalculation
    this.worker.ref()
    return new Promise((resolve, reject) => {
      this.calculations.set(id, { resolve, reject })
      this.worker.postMessage({ id, candles, intervalMS })
    })
  }

  async indicators(state) {
    if (state.calculation) return state.calculation
    const task = (async () => {
      while (state.calculatedVersion !== state.priceVersion || state.calculatedLiveVersion !== state.liveVersion) {
        const version = state.priceVersion, liveVersion = state.liveVersion
        const candles = [...state.rows.values()].map(row => Object.fromEntries(priceFields.map(field => [field, row[field]])))
        if (state.live && !state.rows.has(state.live.timestamp)) candles.push(state.live)
        const bars = await this.calculate(candles, state.intervalMS)
        if (version !== state.priceVersion || liveVersion !== state.liveVersion) continue
        state.indicators = new Map(bars.map(bar => [bar.hour, bar]))
        state.calculatedVersion = version
        state.calculatedLiveVersion = liveVersion
      }
    })().finally(() => { if (state.calculation === task) state.calculation = null })
    state.calculation = task
    return task
  }

  bar(state, hour) {
    const raw = state.rows.get(hour), indicator = state.indicators.get(hour)
    if (!raw || !indicator || !sourceFresh(raw, 1) || !sourceFresh(raw, 2)) return null
    if (!Number.isFinite(indicator.ema)) {
      // Null recursive indicators are truthful at a confirmed listing edge.
      // A merely resident edge or an unfilled internal gap is not a seed.
      if (state.floor === null || hour < state.floor || hour >= state.floor + WARMUP * state.intervalMS) return null
      for (let timestamp = state.floor; timestamp <= hour; timestamp += state.intervalMS) if (!state.rows.has(timestamp)) return null
    }
    return { ...indicator, oi: raw.oi, buy: raw.buy, sell: raw.sell, statisticsSources: 3, statisticsObserved: true,
      oiUnavailableReason: raw.oi === null ? hour < Date.now() - HISTORY_PERIODS * state.intervalMS ? 'outside-retention' : 'not-published' : undefined,
      takerUnavailableReason: raw.buy === null || raw.sell === null ? hour < Date.now() - HISTORY_PERIODS * state.intervalMS ? 'outside-retention' : 'not-published' : undefined }
  }

  async prepare(instId, timeframe, targetEnd) {
    if (!['5m', '15m', '1H'].includes(timeframe)) throw new Error('Unsupported chart timeframe.')
    if (targetEnd !== undefined && !Number.isFinite(targetEnd)) throw new Error('Invalid chart window end.')
    const state = this.state(instId, timeframe)
    state.active += 1
    try { return await this.prepareState(state, targetEnd) }
    finally { state.active -= 1; this.trim() }
  }

  async prepareState(state, targetEnd) {
    const { instId, timeframe, intervalMS: step } = state
    await this.load(state)
    const listedAt = Number(this.instrument(instId)?.listTime)
    if (Number.isFinite(listedAt) && listedAt > 0) state.floor = Math.max(state.floor ?? -Infinity, Math.floor(listedAt / step) * step)
    if (targetEnd === undefined) await this.refreshLatest(state)
    let latestEnd = this.latest(state)
    const ceiling = Math.floor(Date.now() / step) * step - step
    if (state.floor !== null && ceiling < state.floor + (VISIBLE - 1) * step) {
      // The listing timestamp proves that 96 completed periods cannot exist
      // yet. Do not ask the exchange to repair future, nonexistent candles.
      const availableCandles = latestEnd === null ? 0 : Math.max(0, Math.floor((Math.min(latestEnd, ceiling) - state.floor) / step) + 1)
      return { instId, timeframe, intervalMS: step, endHour: null, latestEnd, oldestHour: state.floor,
        historyExhausted: true, generation: state.generation, revision: this.revision(instId), bars: [],
        oiState: 'unavailable', takerState: 'unavailable', indicatorState: 'unavailable', error: '',
        unavailable: { reason: 'insufficient-history', availableCandles, requiredCandles: VISIBLE, retryAt: state.floor + VISIBLE * step + 1_000 } }
    }
    if (latestEnd === null && targetEnd === undefined) throw new Error('No completed source candles are available.')
    let end = Math.min(targetEnd === undefined ? latestEnd : Math.floor(targetEnd / step) * step, ceiling)
    if (state.floor !== null) end = Math.max(end, state.floor + (VISIBLE - 1) * step)
    if (latestEnd !== null && targetEnd === undefined) end = Math.min(end, latestEnd)
    await this.ensurePrices(state, Math.max(end - (VISIBLE - 1 + WARMUP) * step, state.floor ?? -Infinity), end)
    latestEnd = this.latest(state)
    if (state.floor !== null) {
      const clampedEnd = Math.min(latestEnd, Math.max(end, state.floor + (VISIBLE - 1) * step))
      if (clampedEnd !== end) {
        end = clampedEnd
        await this.ensurePrices(state, Math.max(end - (VISIBLE - 1 + WARMUP) * step, state.floor), end)
        latestEnd = this.latest(state)
      }
    }
    const first = end - (VISIBLE - 1) * step
    const available = []
    for (let hour = first; hour <= end; hour += step) {
      if (!state.rows.has(hour)) throw new Error('A complete 96-candle source window is not available.')
      available.push(state.rows.get(hour))
    }
    await this.ensureStatistics(state, first, end)
    await this.indicators(state)
    const generation = state.generation
    const central = available.map(row => this.bar(state, row.timestamp))
    if (central.some(bar => !bar)) throw new Error('Chart statistics have not completed preparation.')
    // Include only contiguous, fully observed neighbors. Prepared data may be
    // navigated immediately; unknown source rows never enter the renderer cache.
    const before = [], after = []
    for (let hour = first - step; before.length < 52; hour -= step) { const bar = this.bar(state, hour); if (!bar) break; before.unshift(bar) }
    for (let hour = end + step; after.length < 52; hour += step) { const bar = this.bar(state, hour); if (!bar) break; after.push(bar) }
    const oiState = central.every(bar => bar.oi !== null) ? 'ready' : 'unavailable'
    const takerState = central.every(bar => bar.buy !== null && bar.sell !== null) ? 'ready' : 'unavailable'
    const indicatorState = central.every(bar => indicatorFields.every(field => Number.isFinite(bar[field]))) ? 'ready' : 'unavailable'
    return { instId, timeframe, intervalMS: step, endHour: end, latestEnd, oldestHour: state.floor,
      historyExhausted: state.floor !== null && first <= state.floor, generation, revision: this.revision(instId),
      bars: [...before, ...central, ...after], oiState, takerState, indicatorState,
      liveBar: targetEnd === undefined && state.live ? state.indicators.get(state.live.timestamp) : undefined, error: '' }
  }

  async dispose() {
    this.closed = true
    for (const pending of this.calculations.values()) pending.reject(new Error('Prepared chart data service is closed.'))
    this.calculations.clear()
    const worker = this.worker
    this.worker = null
    if (worker) await worker.terminate()
  }
}
