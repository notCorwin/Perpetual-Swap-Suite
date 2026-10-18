import { HistorySync } from './history-sync.js'
import { DataAudit } from './data-audit.js'
import { CANDLE_INTERVALS, validateCandle } from './market-store.js'
import { statisticsMask, STATISTICS_OI as OI, STATISTICS_TAKER as TAKER, validTakerVolumes } from './statistics-state.js'

const DAY = 86_400_000
const keyOf = (instrument, timeframe) => `${instrument}:${timeframe}`
const rangeKey = value => `${keyOf(value.instrument, value.timeframe)}:${value.from}:${value.through}`
const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const expiryField = source => source === OI ? 'statisticsOIExpiresAt' : 'statisticsTakerExpiresAt'
const pricePresent = row => row.confirmed === true && nonnegative(row.baseVolume) && nonnegative(row.quoteVolume)
const sourcePresent = (row, source, now) => {
  if (!(statisticsMask(row) & source)) return false
  const valid = source === OI ? nonnegative(row.oi) : validTakerVolumes(row)
  return valid || Number(row[expiryField(source)]) > now
}
const missing = (rows, from, through, interval, present) => {
  const stamps = new Set(rows.filter(present).map(row => row.timestamp)), result = []
  let first = null
  for (let stamp = from; stamp <= through; stamp += interval) {
    if (!stamps.has(stamp)) first ??= stamp
    else if (first !== null) { result.push({ from: first, through: stamp - interval }); first = null }
  }
  if (first !== null) result.push({ from: first, through })
  return result
}
const abortable = (promise, signal) => {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** OKX source adaptation; HistorySync alone schedules durable observations. */
export class MarketHistory {
  constructor({ store, metadata, get, parseCandle, persistCandles, persistStatistics, replaceCandles, instrument, onProgress, onLive, now = Date.now }) {
    if (typeof replaceCandles !== 'function') throw new TypeError('MarketHistory needs a replacement mutation callback.')
    Object.assign(this, { store, metadata, get, parseCandle, persistCandles, persistStatistics, replaceCandles, instrument, onLive, now })
    this.closed = false
    this.closeTask = null
    this.controllers = new Set()
    this.latestTasks = new Map()
    this.seeds = new Map()
    this.repairs = new Map()
    const statistics = source => ({
      inspect: query => this.inspectSource(query),
      fetchGap: query => this.fetchStatistics(query, source),
    })
    this.sync = new HistorySync({
      metadata,
      store: { missingCandleRanges: (query, priority) => this.missingSource(query, priority) },
      sources: {
        candles: { inspect: query => this.inspectSource(query), fetchGap: query => this.fetchPrices(query) },
        oi: statistics('oi'),
        taker: statistics('taker'),
      },
      write: (rows, task) => this.write(rows, task),
      onProgress,
      now,
      // MarketService.get already meters each independent OKX endpoint family.
      minRequestIntervalMS: 0,
      maxConcurrentTasks: 8,
      maxConcurrentPerSource: { candles: 4, oi: 2, taker: 2 },
    })
    this.audit = new DataAudit({ metadata, now,
      inspect: async (target, { signal }) => {
        signal.throwIfAborted()
        const bounds = this.bounds(target.instrument, target.timeframe)
        const query = { ...target, from: Math.max(target.from, bounds.floor ?? 0), through: Math.min(target.through, bounds.through) }
        // Full-file findings extend to midnight. Verification must still stop
        // at the latest completed period rather than inventing future gaps.
        if (query.from > query.through) return { issues: [], checkedRows: 0, files: 0, missingRanges: [] }
        const result = await store.inspectCandles(query, 'background')
        signal.throwIfAborted()
        return result
      },
      repair: (issue, options) => this.repair(issue, options) })
    this.ready = this.sync.start().then(() => this)
  }

  assertOpen() { if (this.closed) throw new Error('MarketHistory is closed.') }

  bounds(instId, timeframe) {
    const interval = CANDLE_INTERVALS[timeframe]
    if (!interval) throw new TypeError('Unsupported history timeframe.')
    const listing = numeric(this.instrument?.(instId)?.listTime)
    return {
      interval,
      floor: listing !== null && listing > 0 ? Math.ceil(listing / interval) * interval : undefined,
      through: Math.floor(this.now() / interval) * interval - interval,
    }
  }

  inspectSource(query) {
    const { floor, through } = this.bounds(query.instrument, query.timeframe)
    const availableFrom = floor
    return {
      ...(availableFrom === undefined ? {} : { availableFrom }),
      availableThrough: through,
      reason: 'Outside the instrument completed-candle history.',
    }
  }

  async missingSource(query, priority) {
    const repair = query.source === 'candles' && this.repairs.get(rangeKey(query))
    if (repair && !repair.written) return [{ from: query.from, through: query.through }]
    const rows = await this.store.candles(query, priority)
    const bit = query.source === 'oi' ? OI : TAKER
    const observations = this.seeds.get(keyOf(query.instrument, query.timeframe))
    return missing(rows, query.from, query.through, query.intervalMS,
      query.source === 'candles' ? row => pricePresent(row) && !observations?.has(row.timestamp) : row => pricePresent(row) && sourcePresent(row, bit, this.now()))
  }

  parsed(instId, timeframe, values) {
    if (!Array.isArray(values)) throw new TypeError('OKX history must contain an array.')
    return values.map(value => this.parseCandle(instId, timeframe, value)).filter(Boolean).filter(row => row.confirmed).map(row => {
      validateCandle(row)
      if (!pricePresent(row)) throw new TypeError('A historical source candle needs base and quote volume.')
      return row
    })
  }

  async fetchPrices(query) {
    const { instrument, timeframe, from, through, signal, priority } = query
    const interval = CANDLE_INTERVALS[timeframe]
    const repair = [...this.repairs.values()].find(value => value.instrument === instrument && value.timeframe === timeframe
      && from >= value.from && through <= value.through && !value.written)
    if (repair) {
      const rows = new Map()
      let cursor = through + interval
      while (cursor > from) {
        signal.throwIfAborted()
        const page = this.parsed(instrument, timeframe, await this.get('/market/history-candles', { instId: instrument, bar: timeframe, limit: Math.min(300, (cursor - from) / interval), after: cursor }, signal, priority))
          .filter(row => row.timestamp >= from && row.timestamp <= through)
        if (!page.length) throw new Error('The repair source did not return the complete affected range.')
        for (const row of page) rows.set(row.timestamp, row)
        const oldest = Math.min(...page.map(row => row.timestamp))
        if (oldest >= cursor) throw new Error('The repair history cursor did not advance.')
        cursor = oldest
      }
      const records = [...rows.values()].sort((a, b) => a.timestamp - b.timestamp)
      if (missing(records, from, through, interval, pricePresent).length) throw new Error('The repair source did not return the complete affected range.')
      repair.records = records
      return { records, cursor: null }
    }
    const seeded = [...(this.seeds.get(keyOf(instrument, timeframe))?.values() ?? [])].filter(row => row.timestamp >= from && row.timestamp <= through)
    if (seeded.length) return { records: seeded, cursor: null }
    const cursor = Math.min(numeric(query.cursor) ?? through + interval, through + interval)
    const values = await this.get('/market/history-candles', { instId: instrument, bar: timeframe, limit: Math.min(300, (cursor - from) / interval), after: cursor }, signal, priority)
    const rows = this.parsed(instrument, timeframe, values).filter(row => row.timestamp < cursor)
    return { records: rows, cursor: rows.length ? Math.min(...rows.map(row => row.timestamp)) : null }
  }

  async fetchStatistics(query, source) {
    const { instrument, timeframe, from, through, signal, priority } = query
    const interval = CANDLE_INTERVALS[timeframe]
    const pageFrom = Math.max(from, through - 99 * interval)
    const path = source === 'oi' ? '/rubik/stat/contracts/open-interest-history' : '/rubik/stat/taker-volume-contract'
    // OKX excludes both boundaries. Ask each source about the actual page;
    // a shared local retention cutoff cannot establish its availability.
    const values = await this.get(path, { instId: instrument, period: timeframe, limit: 100,
      begin: pageFrom - interval, end: through + interval, ...(source === 'taker' ? { unit: 1 } : {}) }, signal, priority)
    if (!Array.isArray(values)) throw new TypeError('OKX statistics must contain an array.')
    const byTimestamp = new Map()
    for (const value of values) {
      const timestamp = numeric(value?.[0])
      if (!Number.isSafeInteger(timestamp) || timestamp % interval !== 0) throw new TypeError('OKX statistics need timestamps on the native period grid.')
      if (timestamp < pageFrom || timestamp > through) continue
      const observation = source === 'oi' ? [timestamp, numeric(value[1])] : [timestamp, numeric(value[1]), numeric(value[2])]
      if (observation.slice(1).some(amount => !nonnegative(amount))) throw new TypeError('OKX statistics need finite nonnegative quantities.')
      const previous = byTimestamp.get(timestamp)
      if (previous && previous.some((amount, index) => amount !== observation[index])) throw new TypeError('OKX statistics contain conflicting observations for one period.')
      byTimestamp.set(timestamp, observation)
    }
    // Network work starts independently. Only merging this page waits for its
    // durable price rows, never for an entire multi-day history target.
    // This bounded page is a dependency of an already admitted source, even
    // when that source is backfilling. Let it finish alongside foreground
    // qualification instead of holding the statistics lane behind bulk work.
    const { rows } = await this.ensurePrices(instrument, timeframe, pageFrom, through, 'foreground', signal)
    return rows.filter(pricePresent).map(row => {
      const value = byTimestamp.get(row.timestamp)
      return source === 'oi' ? { ...row, oi: numeric(value?.[1]) }
        : { ...row, sell: numeric(value?.[1]), buy: numeric(value?.[2]) }
    })
  }

  async write(rows, task) {
    if (task.source === 'candles') {
      const repair = this.repairs.get(rangeKey(task))
      const observations = this.seeds.get(keyOf(task.instrument, task.timeframe))
      if (repair && !repair.written) {
        // A corrupt/incompatible partition is replaced only after the entire
        // affected completed day has been obtained, never page by page.
        const range = { instrument: task.instrument, timeframe: task.timeframe, from: repair.replaceFrom, through: repair.replaceThrough }
        // The latest endpoint may revise a slot while its historical repair
        // is in flight. Commit that explicit observation in the same complete
        // replacement, so shared task coverage advances without losing it.
        const replacement = (repair.records ?? rows).map(row => observations?.get(row.timestamp) ?? row)
        if (missing(replacement, task.from, task.through, CANDLE_INTERVALS[task.timeframe], pricePresent).length) throw new Error('A complete repair range is required before replacing the partition.')
        await this.replaceCandles(range, replacement, task.priority)
        for (const row of replacement) if (observations?.get(row.timestamp) === row) observations.delete(row.timestamp)
        repair.written = true
      } else {
        await this.persistCandles(task.instrument, rows, { priority: task.priority })
        // Only consumption of that explicit observation clears the refresh.
        // An older HTTP page already in flight must not swallow its revision.
        for (const row of rows) if (observations?.get(row.timestamp) === row) observations.delete(row.timestamp)
      }
      return
    }
    const source = task.source === 'oi' ? OI : TAKER
    const from = Math.min(...rows.map(row => row.timestamp)), through = Math.max(...rows.map(row => row.timestamp))
    const values = rows.map(row => source === OI ? [row.timestamp, row.oi] : [row.timestamp, row.sell, row.buy])
    await this.persistStatistics(this.instrument?.(task.instrument) ?? { instId: task.instrument }, task.timeframe, through, source, values,
      { from, through, intervalMS: CANDLE_INTERVALS[task.timeframe] }, task.priority)
  }

  async request(instId, timeframe, source, from, through, priority, signal) {
    this.assertOpen()
    signal?.throwIfAborted()
    const task = await this.sync.enqueue({ instrument: instId, timeframe, source, from, through, priority })
    const result = await abortable(this.sync.waitFor(task.id), signal)
    if (!['completed', 'unavailable'].includes(result.status)) throw new Error(result.lastError || `History ${source} task was ${result.status}.`)
    return result
  }

  async ensurePrices(instId, timeframe, from, through, priority = 'foreground', signal) {
    await abortable(this.ready, signal)
    await this.request(instId, timeframe, 'candles', from, through, priority, signal)
    return { rows: await abortable(this.store.candles({ instrument: instId, timeframe, from, through }, priority), signal), floor: this.bounds(instId, timeframe).floor }
  }

  async ensureStatistics(instId, timeframe, from, through, priority = 'foreground', signal) {
    await abortable(this.ready, signal)
    await Promise.all(['candles', 'oi', 'taker'].map(source => this.request(instId, timeframe, source, from, through, priority, signal)))
    return { rows: await abortable(this.store.candles({ instrument: instId, timeframe, from, through }, priority), signal) }
  }

  latest(instId, timeframe, priority = 'foreground') {
    this.assertOpen()
    const key = keyOf(instId, timeframe)
    if (this.latestTasks.has(key)) return this.latestTasks.get(key)
    const controller = new AbortController()
    this.controllers.add(controller)
    const task = (async () => {
      await this.ready
      const values = await this.get('/market/candles', { instId, bar: timeframe, limit: 2 }, controller.signal, priority)
      const parsed = values.map(value => this.parseCandle(instId, timeframe, value)).filter(Boolean)
      const live = parsed.filter(row => !row.confirmed).sort((a, b) => b.timestamp - a.timestamp)[0] ?? null
      if (live) await this.onLive?.(instId, timeframe, live)
      const confirmed = this.parsed(instId, timeframe, values)
      this.seeds.set(key, new Map(confirmed.map(row => [row.timestamp, row])))
      const { floor } = this.bounds(instId, timeframe)
      // A latest response proves only the observations it actually contains.
      // Empty/forming-only responses never invent a range to the local clock;
      // history targets and window requests own all gap coverage decisions.
      for (const row of confirmed.sort((a, b) => a.timestamp - b.timestamp)) {
        await this.request(instId, timeframe, 'candles', row.timestamp, row.timestamp, 'foreground', controller.signal)
      }
      return { live, floor }
    })().finally(() => {
      this.controllers.delete(controller)
      this.seeds.delete(key)
      if (this.latestTasks.get(key) === task) this.latestTasks.delete(key)
    })
    this.latestTasks.set(key, task)
    return task
  }

  async target(instId, { historyDays = 30, asOf = this.now() } = {}) {
    await this.ready
    this.assertOpen()
    return Promise.all(Object.keys(CANDLE_INTERVALS).flatMap(timeframe => ['candles', 'oi', 'taker'].map(source => this.sync.enqueueTarget({
      instrument: instId, timeframe, source, historyDays, warmupCandles: 200, asOf, priority: 'background',
    }))))
  }

  async repair(issue, { signal }) {
    await this.ready
    this.assertOpen()
    signal.throwIfAborted()
    const interval = CANDLE_INTERVALS[issue.timeframe]
    const wholeDay = issue.reason === 'corrupt-file' || issue.reason === 'invalid-schema'
    const bounds = this.bounds(issue.instrument, issue.timeframe)
    const from = Math.max(bounds.floor ?? 0, wholeDay ? Math.floor(issue.from / DAY) * DAY : Math.floor(issue.from / interval) * interval)
    const through = Math.min(bounds.through, wholeDay ? Math.floor(issue.through / DAY) * DAY + DAY - interval : Math.floor(issue.through / interval) * interval)
    if (from > through) throw new Error('The affected partition has no available completed source candles.')
    const target = { instrument: issue.instrument, timeframe: issue.timeframe, from, through }
    const key = rangeKey(target), repair = { ...target, written: false, records: null,
      replaceFrom: wholeDay ? Math.floor(issue.from / DAY) * DAY : from,
      replaceThrough: wholeDay ? Math.floor(issue.through / DAY) * DAY + DAY - interval : through }
    this.repairs.set(key, repair)
    let task
    const abort = () => { if (task) void this.sync.cancel(task.id).catch(() => undefined) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      task = await this.sync.enqueue({ ...target, source: 'candles', priority: 'foreground' })
      if (signal.aborted) { abort(); signal.throwIfAborted() }
      if (task.status === 'unavailable') await this.sync.resume(task.id)
      const result = await abortable(this.sync.waitFor(task.id), signal)
      signal.throwIfAborted()
      if (!repair.written || !['completed', 'unavailable'].includes(result.status)) throw new Error(result.lastError || 'The source could not repair the complete affected range.')
    } finally {
      signal.removeEventListener('abort', abort)
      this.repairs.delete(key)
    }
  }

  close() {
    if (this.closeTask) return this.closeTask
    this.closed = true
    for (const controller of this.controllers) controller.abort()
    this.closeTask = (async () => {
      // Abort audit waiters first, then the source lane; both preserve durable
      // checkpoints and finish admitted writes before the owner closes stores.
      const audit = this.audit.close()
      await this.sync.close()
      await audit
      await Promise.allSettled(this.latestTasks.values())
    })()
    return this.closeTask
  }
}
