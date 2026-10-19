import { HistorySync } from './history-sync.js'
import { DataAudit } from './data-audit.js'
import { CANDLE_INTERVALS, validateCandle } from './market-store.js'
import { statisticsMask, STATISTICS_OI as OI, STATISTICS_TAKER as TAKER, validTakerVolumes } from './statistics-state.js'

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
const mergedRanges = (ranges, interval) => {
  const result = []
  for (const value of [...ranges].sort((a, b) => a.from - b.from)) {
    const previous = result.at(-1)
    if (previous && value.from <= previous.through + interval) previous.through = Math.max(previous.through, value.through)
    else result.push({ ...value })
  }
  return result
}
const subtractRange = (ranges, observed, interval) => ranges.flatMap(value => {
  if (observed.from > value.through || observed.through < value.from) return [value]
  return [...(value.from < observed.from ? [{ from: value.from, through: observed.from - interval }] : []),
    ...(value.through > observed.through ? [{ from: observed.through + interval, through: value.through }] : [])]
})
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
  constructor({ store, metadata, get, awaitRealtimeCandle, parseCandle, persistCandles, persistStatistics, replaceCandles, instrument, onProgress, onLive, onAuditCheckpoint, now = Date.now }) {
    if (typeof replaceCandles !== 'function') throw new TypeError('MarketHistory needs a replacement mutation callback.')
    Object.assign(this, { store, metadata, get, awaitRealtimeCandle, parseCandle, persistCandles, persistStatistics, replaceCandles, instrument, onLive, now })
    this.closed = false
    this.closeTask = null
    this.controllers = new Set()
    this.latestTasks = new Map()
    this.seeds = new Map()
    this.repairs = new Map()
    this.coverageLeaseReads = new Map()
    const statistics = source => ({
      inspect: query => this.inspectSource(query),
      fetchGap: query => this.fetchStatistics(query, source),
    })
    this.sync = new HistorySync({
      metadata,
      store: {
        missingCandleRanges: (query, priority) => this.missingSource(query, priority),
        ...(typeof store.candleRevision === 'function' ? {
          coverageVersion: query => store.candleRevision(query.instrument, query.timeframe),
          ...(typeof store.candleChangesSince === 'function' ? { coverageChanges: (query, revision) => store.candleChangesSince(query.instrument, query.timeframe, revision) } : {}),
        } : {}),
        coverageLeases: query => this.coverageLeaseReads.get(`${rangeKey(query)}:${query.source}`) ?? [],
      },
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
    this.audit = new DataAudit({ metadata, now, onCheckpoint: onAuditCheckpoint,
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
    const rows = query.source === 'candles' ? await this.store.candles(query, priority) : await this.store.statistics(query, priority)
    const bit = query.source === 'oi' ? OI : TAKER
    const observations = this.seeds.get(keyOf(query.instrument, query.timeframe)), observedAt = this.now()
    const leases = []
    if (query.source !== 'candles') for (const row of rows) {
      const numericObservation = bit === OI ? nonnegative(row.oi) : validTakerVolumes(row)
      const expiresAt = Number(row[expiryField(bit)])
      if (!(statisticsMask(row) & bit) || numericObservation || expiresAt <= observedAt || !Number.isSafeInteger(expiresAt)) continue
      const previous = leases.at(-1)
      if (previous?.expiresAt === expiresAt && row.timestamp === previous.through + query.intervalMS) previous.through = row.timestamp
      else leases.push({ from: row.timestamp, through: row.timestamp, expiresAt })
    }
    const leaseKey = `${rangeKey(query)}:${query.source}`
    // Only the caller's immediately following coverageLeases lookup needs
    // these ranges. Retain bounded query metadata, never source candle rows.
    this.coverageLeaseReads.delete(leaseKey)
    this.coverageLeaseReads.set(leaseKey, leases)
    while (this.coverageLeaseReads.size > 512) this.coverageLeaseReads.delete(this.coverageLeaseReads.keys().next().value)
    const gaps = missing(rows, query.from, query.through, query.intervalMS,
      query.source === 'candles' ? row => pricePresent(row) && !observations?.has(row.timestamp) : row => sourcePresent(row, bit, observedAt))
    if (query.source === 'candles') for (const repair of this.repairs.values()) {
      if (repair.instrument !== query.instrument || repair.timeframe !== query.timeframe) continue
      for (const bounds of repair.remaining) if (bounds.from <= query.through && bounds.through >= query.from) gaps.push({ from: Math.max(bounds.from, query.from), through: Math.min(bounds.through, query.through) })
    }
    return mergedRanges(gaps, query.intervalMS)
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
    const seeded = [...(this.seeds.get(keyOf(instrument, timeframe))?.values() ?? [])].filter(row => row.timestamp >= from && row.timestamp <= through)
    if (seeded.length) return { records: seeded, cursor: null }
    const repairing = () => [...this.repairs.values()].some(repair => repair.instrument === instrument && repair.timeframe === timeframe
      && repair.remaining.some(bounds => bounds.from <= through && bounds.through >= from))
    if (!repairing() && await this.awaitRealtimeCandle?.(query) && !repairing()) {
      // HistorySync rechecks durable coverage after source work. Do not replay
      // an earlier streamed snapshot over a newer canonical correction.
      return { records: [], cursor: null }
    }
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
    // Statistics own their native timestamp slots independently of price history.
    // An empty response is a bounded direct observation, never an availability boundary.
    return Array.from({ length: (through - pageFrom) / interval + 1 }, (_, index) => {
      const timestamp = pageFrom + index * interval, value = byTimestamp.get(timestamp)
      return { instrument, timeframe, timestamp, ...(source === 'oi'
        ? { oi: numeric(value?.[1]) } : { sell: numeric(value?.[1]), buy: numeric(value?.[2]) }) }
    })
  }

  async write(rows, task) {
    if (task.source === 'candles') {
      const observations = this.seeds.get(keyOf(task.instrument, task.timeframe))
      const repairs = [...this.repairs.values()].filter(value => value.instrument === task.instrument && value.timeframe === task.timeframe
        && value.remaining.some(bounds => bounds.from <= task.through && bounds.through >= task.from))
      if (repairs.length) {
        const interval = CANDLE_INTERVALS[task.timeframe]
        const replacement = [...new Map(rows.map(row => [row.timestamp, observations?.get(row.timestamp) ?? row])).values()].sort((a, b) => a.timestamp - b.timestamp)
        // SQL ranges can be replaced independently. Never erase an unobserved slot
        // merely because the source returned a partial page around it.
        const runs = []
        for (const row of replacement) {
          const run = runs.at(-1)
          if (run && row.timestamp === run.at(-1).timestamp + interval) run.push(row)
          else runs.push([row])
        }
        for (const run of runs) {
          const bounds = { instrument: task.instrument, timeframe: task.timeframe, from: run[0].timestamp, through: run.at(-1).timestamp }
          await this.replaceCandles(bounds, run, task.priority)
          for (const repair of repairs) { repair.remaining = subtractRange(repair.remaining, bounds, interval); repair.written = repair.remaining.length === 0 }
        }
        for (const row of replacement) if (observations?.get(row.timestamp) === row) observations.delete(row.timestamp)
      } else {
        await this.persistCandles(task.instrument, rows, { priority: task.priority })
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
    const abort = () => { void this.sync.cancel(task.id).catch(() => undefined) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (signal?.aborted) { abort(); signal.throwIfAborted() }
      const result = await abortable(this.sync.waitFor(task.id), signal)
      if (!['completed', 'unavailable'].includes(result.status)) throw new Error(result.lastError || `History ${source} task was ${result.status}.`)
      return result
    } finally { signal?.removeEventListener('abort', abort) }
  }

  async ensurePrices(instId, timeframe, from, through, priority = 'foreground', signal) {
    await abortable(this.ready, signal)
    await this.request(instId, timeframe, 'candles', from, through, priority, signal)
    return { rows: await abortable(this.store.candles({ instrument: instId, timeframe, from, through }, priority), signal), floor: this.bounds(instId, timeframe).floor }
  }

  async ensureStatistics(instId, timeframe, from, through, priority = 'foreground', signal) {
    await abortable(this.ready, signal)
    await Promise.all(['oi', 'taker'].map(source => this.request(instId, timeframe, source, from, through, priority, signal)))
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
      const bounds = this.bounds(instId, timeframe)
      if (await this.awaitRealtimeCandle?.({ instrument: instId, timeframe, from: bounds.through, through: bounds.through, signal: controller.signal, priority })) return { live: null, floor: bounds.floor }
      const values = await this.get('/market/candles', { instId, bar: timeframe, limit: 2 }, controller.signal, priority)
      const parsed = values.map(value => this.parseCandle(instId, timeframe, value)).filter(Boolean)
      const live = parsed.filter(row => !row.confirmed).sort((a, b) => b.timestamp - a.timestamp)[0] ?? null
      if (live) await this.onLive?.(instId, timeframe, live)
      const confirmed = this.parsed(instId, timeframe, values)
      this.seeds.set(key, new Map(confirmed.map(row => [row.timestamp, row])))
      for (const row of confirmed) this.sync.invalidate({ instrument: instId, timeframe, source: 'candles', from: row.timestamp, through: row.timestamp })
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

  async removeTargets(instIds) { await this.ready; return this.sync.removeTargets(instIds) }

  async repair(issue, { signal }) {
    await this.ready
    this.assertOpen()
    signal.throwIfAborted()
    const interval = CANDLE_INTERVALS[issue.timeframe]
    const bounds = this.bounds(issue.instrument, issue.timeframe)
    const from = Math.max(bounds.floor ?? 0, Math.floor(issue.from / interval) * interval)
    const through = Math.min(bounds.through, Math.floor(issue.through / interval) * interval)
    if (from > through) throw new Error('The affected partition has no available completed source candles.')
    const target = { instrument: issue.instrument, timeframe: issue.timeframe, from, through }
    const key = rangeKey(target), repair = { ...target, written: false, remaining: [{ from, through }] }
    this.repairs.set(key, repair)
    this.sync.invalidate({ ...target, source: 'candles' })
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
