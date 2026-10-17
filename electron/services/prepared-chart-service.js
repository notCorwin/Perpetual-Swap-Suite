import { Worker } from 'node:worker_threads'
import { statisticsMask } from './statistics-state.js'

const VISIBLE = 96
const WARMUP = 199
const LOCAL_HISTORY_BARS = 16_384
const SNAPSHOT_SCHEMA = 2
const FORMULA_VERSION = 'native-ema200-wilder-flat50-rsi6-12-24-boll20-2-base-vwap14-roc9-maroc9-v2'
const REFRESH_MS = 60_000
const priceFields = ['timestamp', 'open', 'high', 'low', 'close', 'volume', 'baseVolume', 'quoteVolume', 'confirmed']
const indicatorFields = ['ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24']
const intervalFor = timeframe => timeframe === '5m' ? 300_000 : timeframe === '15m' ? 900_000 : 3_600_000
const priceChanged = (left, right) => !left || priceFields.some(field => left[field] !== right[field])
const extremeHour = (rows, minimum = false) => {
  let result = minimum ? Infinity : -Infinity
  for (const hour of rows.keys()) result = minimum ? Math.min(result, hour) : Math.max(result, hour)
  return Number.isFinite(result) ? result : null
}
const sourcePresent = (row, source) => statisticsMask(row) & source
const sourceMissing = (row, source) => source === 1 ? row.oi === null : row.buy === null || row.sell === null
const expiryField = source => source === 1 ? 'statisticsOIExpiresAt' : 'statisticsTakerExpiresAt'
const sourceFresh = (row, source, now = Date.now()) => sourcePresent(row, source)
  && (!sourceMissing(row, source) || Number(row[expiryField(source)]) > now)
const seriesKey = (instId, timeframe) => `${instId}:${timeframe}`
const sourcePriority = value => value === 'background' || value === 'chartWarm' ? 'background' : 'foreground'
const sameRow = (left, right) => left && right && Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(field => Object.hasOwn(right, field) && Object.is(left[field], right[field]))

/** Durable source pages and canonical calculations are independent of UI focus. */
export class PreparedChartPipeline {
  constructor({ store, history, normalize, revision, instrument }) {
    Object.assign(this, { store, history, normalize, revision, instrument })
    this.series = new Map()
    this.nextGeneration = 0
    this.maxSeries = 8
    this.maxRows = 100_000
    this.tasks = new Map()
    this.calculations = new Map()
    this.nextCalculation = 0
    this.worker = null
    this.closed = false
    this.snapshots = new Map()
    this.localTasks = new Map()
    this.sourceVersions = new Map()
    this.listeners = new Set()
    this.universe = new Map()
    this.focusKey = null
    this.localQueue = new Map()
    this.remoteQueue = new Map()
    this.remoteAttempts = new Map()
    this.localRunning = null
    this.remoteRunning = null
    this.warmTimer = null
    this.refreshTimer = null
    this.calculationQueue = []
    this.activeCalculation = null
    this.frameVersions = new WeakMap()
  }

  state(instId, timeframe) {
    const key = seriesKey(instId, timeframe)
    let state = this.series.get(key)
    if (!state) {
      state = { key, instId, timeframe, intervalMS: intervalFor(timeframe), rows: new Map(), loaded: false, loading: null,
        priceVersion: 0, sourceVersion: 0, calculatedVersion: -1, calculation: null, indicators: new Map(), generation: this.snapshots.get(key)?.valid ? this.snapshots.get(key).frame.generation : ++this.nextGeneration, active: 0,
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

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  cached(key) {
    const snapshot = this.snapshots.get(key)
    if (!snapshot?.valid || snapshot.validUntil !== null && snapshot.validUntil <= Date.now() || snapshot.frame.unavailable?.retryAt <= Date.now()) return null
    return snapshot.frame
  }

  setUniverse(instIds, timeframe, focusInstId) {
    if (!['5m', '15m', '1H'].includes(timeframe) || !Array.isArray(instIds) || instIds.some(instId => typeof instId !== 'string' || !instId)) throw new Error('Invalid chart universe.')
    this.universe = new Map([...new Set(instIds)].map(instId => [seriesKey(instId, timeframe), { instId, timeframe }]))
    this.focusKey = focusInstId ? seriesKey(focusInstId, timeframe) : null
    for (const [key] of this.localQueue) if (!this.universe.has(key)) this.localQueue.delete(key)
    for (const [key] of this.remoteQueue) if (!this.universe.has(key)) this.remoteQueue.delete(key)
    for (const [key] of this.remoteAttempts) if (!this.universe.has(key)) this.remoteAttempts.delete(key)
    const frames = []
    for (const [key, target] of this.universe) {
      const frame = this.cached(key)
      if (frame) frames.push(frame)
      else this.queueLocal(target.instId, timeframe)
      this.queueRemote(target.instId, timeframe, false)
    }
    if (!this.localQueue.size && this.remoteQueue.size) {
      const first = this.universe.get(this.focusKey) ?? this.universe.values().next().value
      if (first) this.queueLocal(first.instId, first.timeframe)
    }
    this.scheduleRefresh()
    this.trimSnapshots()
    const remaining = frames.splice(16)
    const publishBatch = () => {
      if (this.closed) return
      for (const frame of remaining.splice(0, 16)) if (this.universe.has(seriesKey(frame.instId, frame.timeframe))) this.emit(frame)
      if (remaining.length) setImmediate(publishBatch)
    }
    if (remaining.length) setImmediate(publishBatch)
    return { frames }
  }

  emit(frame) {
    for (const listener of this.listeners) { try { listener(frame) } catch { /* Disconnected renderers do not stop preparation. */ } }
  }

  trimSnapshots() {
    let extra = [...this.snapshots.keys()].filter(key => !this.universe.has(key)).length
    for (const [key] of this.snapshots) {
      if (extra <= 16) break
      if (!this.universe.has(key)) { this.snapshots.delete(key); extra -= 1 }
    }
  }

  queueLocal(instId, timeframe, force = false) {
    if (this.closed) return
    const key = seriesKey(instId, timeframe), previous = this.localQueue.get(key)
    this.localQueue.set(key, { instId, timeframe, force: force || previous?.force || false })
    if (this.warmTimer === null) {
      this.warmTimer = setTimeout(() => { this.warmTimer = null; void this.drainLocal() }, 0)
      this.warmTimer.unref?.()
    }
  }

  drainLocal() {
    if (this.localRunning || this.closed) return this.localRunning
    const task = (async () => {
      while (this.localQueue.size && !this.closed) {
        const key = this.localQueue.has(this.focusKey) ? this.focusKey : this.localQueue.keys().next().value
        const target = this.localQueue.get(key)
        this.localQueue.delete(key)
        try { await this.local(target.instId, target.timeframe, { force: target.force, priority: key === this.focusKey ? 'foreground' : 'background' }) }
        catch { /* A local read failure leaves this candidate for independent source preparation. */ }
      }
    })().finally(() => {
      if (this.localRunning === task) this.localRunning = null
      if (!this.closed) { if (this.localQueue.size) void this.drainLocal(); else void this.drainRemote() }
    })
    this.localRunning = task
    return task
  }

  queueRemote(instId, timeframe, schedule = true) {
    if (this.closed) return
    const key = seriesKey(instId, timeframe)
    if ((this.remoteAttempts.get(key) ?? 0) <= Date.now()) this.remoteQueue.set(key, { instId, timeframe })
    if (!schedule) return
    if (!this.localRunning && !this.localQueue.size) {
      // Give a universe update its complete local pass before starting HTTP.
      if (this.warmTimer === null) this.queueLocal(instId, timeframe)
    }
    this.scheduleRefresh()
  }

  scheduleRefresh() {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    if (this.closed || !this.universe.size) return
    const next = Math.min(...[...this.universe.keys()].map(key => this.remoteAttempts.get(key) ?? Date.now() + REFRESH_MS))
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      for (const [key, target] of this.universe) if ((this.remoteAttempts.get(key) ?? 0) <= Date.now()) this.remoteQueue.set(key, target)
      if (!this.localRunning && !this.localQueue.size) void this.drainRemote()
    }, Math.max(1_000, next - Date.now()))
    this.refreshTimer.unref?.()
  }

  drainRemote() {
    if (this.remoteRunning || this.localRunning || this.localQueue.size || this.closed) return this.remoteRunning
    const task = (async () => {
      while (this.remoteQueue.size && !this.localQueue.size && !this.localRunning && !this.closed) {
        const key = this.remoteQueue.has(this.focusKey) ? this.focusKey : this.remoteQueue.keys().next().value
        const target = this.remoteQueue.get(key)
        this.remoteQueue.delete(key)
        this.remoteAttempts.set(key, Date.now() + REFRESH_MS)
        const state = this.state(target.instId, target.timeframe)
        state.active += 1
        this.trim()
        try {
          while (!this.closed) {
            const frame = await this.prepareState(state, undefined, { priority: 'chartWarm' })
            if (await this.saveCompact(state, this.compact(frame))) break
          }
        } catch {
          this.remoteAttempts.set(key, Date.now() + 5_000)
        } finally { state.active -= 1; this.trim() }
      }
    })().finally(() => {
      if (this.remoteRunning === task) this.remoteRunning = null
      this.scheduleRefresh()
      if (!this.closed && this.localQueue.size) void this.drainLocal()
    })
    this.remoteRunning = task
    return task
  }

  compact(frame) {
    const compact = frame.unavailable ? { ...frame, latestEnd: null }
      : { ...frame, latestEnd: frame.endHour, bars: frame.bars.filter(bar => bar.hour >= frame.endHour - 95 * frame.intervalMS && bar.hour <= frame.endHour) }
    this.frameVersions.set(compact, this.frameVersions.get(frame))
    return compact
  }

  produced(state, frame, sourceVersion = state.sourceVersion) {
    this.frameVersions.set(frame, { sourceVersion, liveVersion: state.liveVersion })
    return frame
  }

  async saveCompact(state, frame, version = this.frameVersions.get(frame), { persist = true } = {}) {
    if (!version || state.sourceVersion !== version.sourceVersion || state.liveVersion !== version.liveVersion || frame.generation !== state.generation) return null
    const watermark = await this.store.candleWatermark(state.instId, state.timeframe, 'background')
    if (this.closed || state.sourceVersion !== version.sourceVersion || state.liveVersion !== version.liveVersion || frame.generation !== state.generation) return null
    const existing = this.snapshots.get(state.key)
    if (existing?.valid && (existing.frame.generation > frame.generation || existing.frame.generation === frame.generation && existing.frame.revision > frame.revision)) return existing.frame
    // A lease may expire before its replacement observation is published.
    // Keep the previously presented close in memory while freshness work
    // revalidates it; never overwrite its expired durable lease with an older
    // window or make the prepared latest pointer move backward.
    if (existing?.valid && existing.frame.generation === frame.generation && existing.frame.endHour !== null && frame.endHour !== null && frame.endHour < existing.frame.endHour) return existing.frame
    const leases = frame.bars.flatMap(bar => {
      const row = state.rows.get(bar.hour)
      return [1, 2].filter(source => sourceMissing(row, source)).map(source => Number(row[expiryField(source)]) || 0)
    })
    const validUntil = leases.length ? Math.min(...leases) : null
    const snapshot = { schemaVersion: SNAPSHOT_SCHEMA, formulaVersion: FORMULA_VERSION, watermark, validUntil, frame }
    // Live candles are an in-memory overlay, never a durable observation.
    const { liveBar: _liveBar, ...confirmedFrame } = frame
    if (persist) await this.store.writeChartSnapshot(state.instId, state.timeframe, { ...snapshot, frame: confirmedFrame })
    if (this.closed || state.sourceVersion !== version.sourceVersion || state.liveVersion !== version.liveVersion || frame.generation !== state.generation) return null
    const changed = !existing?.valid || JSON.stringify(existing.frame) !== JSON.stringify(frame)
    this.snapshots.set(state.key, { ...snapshot, valid: true })
    this.trimSnapshots()
    if (changed) this.emit(frame)
    return frame
  }

  async restoreSnapshot(instId, timeframe, priority) {
    const key = seriesKey(instId, timeframe), version = this.sourceVersions.get(key) ?? 0
    const snapshot = await this.store.readChartSnapshot(instId, timeframe)
    const frame = snapshot?.frame
    if (snapshot?.schemaVersion !== SNAPSHOT_SCHEMA || snapshot.formulaVersion !== FORMULA_VERSION || snapshot.validUntil !== null && snapshot.validUntil <= Date.now() || !frame || frame.liveBar || frame.instId !== instId || frame.timeframe !== timeframe || frame.intervalMS !== intervalFor(timeframe)) return null
    if (frame.unavailable) {
      if (frame.unavailable.reason !== 'insufficient-history' || frame.unavailable.retryAt <= Date.now() || frame.bars?.length) return null
    } else if (!Number.isSafeInteger(frame.endHour) || frame.latestEnd !== frame.endHour || frame.bars?.length !== VISIBLE
      || frame.bars.some((bar, index) => bar.hour !== frame.endHour - (95 - index) * frame.intervalMS || !bar.confirmed || !bar.indicatorsObserved || !bar.statisticsObserved || bar.statisticsSources !== 3
        || ![bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(value) && value > 0)
        || ![...indicatorFields, 'oi', 'buy', 'sell'].every(field => bar[field] === null || Number.isFinite(bar[field])))) return null
    const watermark = await this.store.candleWatermark(instId, timeframe, priority)
    if (snapshot.watermark !== watermark || version !== (this.sourceVersions.get(key) ?? 0) || this.closed) return null
    const state = this.series.get(key)
    const restored = { ...frame, generation: state?.generation ?? ++this.nextGeneration, revision: this.revision(instId) }
    this.snapshots.set(key, { ...snapshot, frame: restored, valid: true })
    this.emit(restored)
    this.trimSnapshots()
    return restored
  }

  listingFloor(state) {
    const listedAt = Number(this.instrument(state.instId)?.listTime)
    if (Number.isFinite(listedAt) && listedAt > 0) state.floor = Math.max(state.floor ?? -Infinity, Math.floor(listedAt / state.intervalMS) * state.intervalMS)
  }

  insufficientHistory(state) {
    const { instId, timeframe, intervalMS: step } = state, ceiling = Math.floor(Date.now() / step) * step - step
    if (state.floor === null || ceiling >= state.floor + (VISIBLE - 1) * step) return null
    const latestEnd = this.latest(state)
    const availableCandles = latestEnd === null ? 0 : Math.max(0, Math.floor((Math.min(latestEnd, ceiling) - state.floor) / step) + 1)
    return { instId, timeframe, intervalMS: step, endHour: null, latestEnd: null, oldestHour: state.floor,
      historyExhausted: true, generation: state.generation, revision: this.revision(instId), bars: [],
      oiState: 'unavailable', takerState: 'unavailable', indicatorState: 'unavailable', error: '',
      unavailable: { reason: 'insufficient-history', availableCandles, requiredCandles: VISIBLE, retryAt: state.floor + VISIBLE * step + 1_000 } }
  }

  local(instId, timeframe, { force = false, priority = 'foreground', persist = true } = {}) {
    if (!['5m', '15m', '1H'].includes(timeframe)) return Promise.reject(new Error('Unsupported chart timeframe.'))
    if (this.closed) return Promise.reject(new Error('Prepared chart data service is closed.'))
    const key = seriesKey(instId, timeframe), cached = this.cached(key)
    if (priority === 'foreground') this.focusKey = key
    if (cached && !force) return Promise.resolve(cached)
    if (this.localTasks.has(key)) return this.localTasks.get(key)
    const task = (async () => {
      if (!this.snapshots.has(key)) {
        const saved = await this.restoreSnapshot(instId, timeframe, priority)
        if (saved && !force) return saved
      }
      const state = this.state(instId, timeframe)
      state.active += 1
      this.trim()
      try {
        await this.load(state, priority)
        this.listingFloor(state)
        while (!this.closed) {
          const version = state.sourceVersion
          let frame = this.insufficientHistory(state)
          if (!frame) {
            const hours = [...state.rows.keys()].sort((left, right) => right - left)
            if (hours.length < VISIBLE) return null
            // Source absence remains an explicit observation while its lease
            // is revalidated independently. Unknown source holes never qualify.
            let count = 0, prior = null, end = null
            for (const hour of hours) {
              const row = state.rows.get(hour)
              count = prior === null || prior - hour === state.intervalMS ? count : 0
              count = sourceFresh(row, 1) && sourceFresh(row, 2) ? count + 1 : 0
              prior = hour
              if (count === VISIBLE) { end = hour + 95 * state.intervalMS; break }
            }
            if (end === null) return this.cached(key)
            await this.indicators(state, priority)
            const bars = Array.from({ length: VISIBLE }, (_, index) => this.bar(state, end - (95 - index) * state.intervalMS))
            if (version !== state.sourceVersion) continue
            if (bars.some(bar => !bar)) return this.cached(key)
            frame = { instId, timeframe, intervalMS: state.intervalMS, endHour: end, latestEnd: end, oldestHour: state.floor,
              historyExhausted: state.floor !== null && bars[0].hour <= state.floor, generation: state.generation, revision: this.revision(instId), bars,
              oiState: bars.every(bar => bar.oi !== null) ? 'ready' : 'unavailable', takerState: bars.every(bar => bar.buy !== null && bar.sell !== null) ? 'ready' : 'unavailable',
              indicatorState: bars.every(bar => indicatorFields.every(field => Number.isFinite(bar[field]))) ? 'ready' : 'unavailable',
              liveBar: state.live && state.live.timestamp === end + state.intervalMS ? state.indicators.get(state.live.timestamp) : undefined, error: '' }
          }
          const saved = await this.saveCompact(state, this.produced(state, frame, version), undefined, { persist })
          if (saved) return saved
        }
        return null
      } finally { state.active -= 1; this.trim() }
    })().finally(() => { if (this.localTasks.get(key) === task) this.localTasks.delete(key) })
    this.localTasks.set(key, task)
    return task
  }

  /** Hydrate focused navigation from durable observations without admitting source work. */
  async localHistory(instId, timeframe, targetEnd) {
    if (!['5m', '15m', '1H'].includes(timeframe)) throw new Error('Unsupported chart timeframe.')
    if (targetEnd !== undefined && !Number.isFinite(targetEnd)) throw new Error('Invalid chart window end.')
    if (this.closed) throw new Error('Prepared chart data service is closed.')
    return this.job(`local-history:${seriesKey(instId, timeframe)}:${targetEnd ?? 'latest'}`, async () => {
      const state = this.state(instId, timeframe), step = state.intervalMS
      state.active += 1
      this.trim()
      try {
        while (!this.closed) {
          await this.load(state, 'foreground')
          if (this.closed) throw new Error('Prepared chart data service is closed.')
          this.listingFloor(state)
          const version = state.sourceVersion, liveVersion = state.liveVersion, generation = state.generation
          await this.indicators(state, 'foreground')
          if (!state.loaded || version !== state.sourceVersion || liveVersion !== state.liveVersion || generation !== state.generation) continue
          const ceiling = Math.floor(Date.now() / step) * step - step
          let count = 0, prior = null, latestEnd = null
          for (const hour of [...state.rows.keys()].sort((left, right) => right - left)) {
            if (hour > ceiling || state.floor !== null && hour < state.floor) continue
            const bar = this.bar(state, hour)
            count = bar ? prior !== null && prior - hour === step ? count + 1 : 1 : 0
            prior = hour
            if (count === VISIBLE) { latestEnd = hour + (VISIBLE - 1) * step; break }
          }
          if (latestEnd === null) return null
          const end = targetEnd === undefined ? latestEnd : Math.min(Math.floor(targetEnd / step) * step, ceiling)
          const first = end - (VISIBLE - 1) * step
          if (state.floor !== null && first < state.floor) return null
          const central = Array.from({ length: VISIBLE }, (_, index) => this.bar(state, first + index * step))
          if (central.some(bar => !bar)) return null
          const before = [], after = [], remaining = LOCAL_HISTORY_BARS - VISIBLE
          for (let hour = first - step; before.length < remaining && (state.floor === null || hour >= state.floor); hour -= step) {
            const bar = this.bar(state, hour)
            if (!bar) break
            before.push(bar)
          }
          for (let hour = end + step; before.length + after.length < remaining && hour <= ceiling; hour += step) {
            const bar = this.bar(state, hour)
            if (!bar) break
            after.push(bar)
          }
          const bars = [...before.reverse(), ...central, ...after]
          return this.produced(state, { instId, timeframe, intervalMS: step, endHour: end, latestEnd, oldestHour: state.floor,
            historyExhausted: state.floor !== null && bars[0].hour <= state.floor, generation, revision: this.revision(instId), bars,
            oiState: central.every(bar => bar.oi !== null) ? 'ready' : 'unavailable',
            takerState: central.every(bar => bar.buy !== null && bar.sell !== null) ? 'ready' : 'unavailable',
            indicatorState: central.every(bar => indicatorFields.every(field => Number.isFinite(bar[field]))) ? 'ready' : 'unavailable',
            liveBar: end === latestEnd && state.live?.timestamp === end + step ? state.indicators.get(state.live.timestamp) : undefined, error: '' }, version)
        }
        throw new Error('Prepared chart data service is closed.')
      } finally { state.active -= 1; this.trim() }
    })
  }

  observe(rows, previous) {
    for (const [key, batch] of Map.groupBy(rows, row => `${row.instrument}:${row.timeframe}`)) {
      const state = this.series.get(key)
      this.sourceVersions.set(key, (this.sourceVersions.get(key) ?? 0) + 1)
      const snapshot = this.snapshots.get(key)
      let changed = false, reseed = false
      const oldLatest = Math.max(state ? extremeHour(state.rows) ?? -Infinity : -Infinity, snapshot?.frame?.endHour ?? -Infinity)
      for (const row of batch) {
        const old = previous.get(row.timestamp)
        if (priceChanged(old, row)) {
          changed = true
          if (row.timestamp <= oldLatest) reseed = true
        }
        if (state?.loaded) state.rows.set(row.timestamp, this.normalize(row))
      }
      if (state) {
        state.sourceVersion += 1
        if (changed) state.priceVersion += 1
        if (state.live && state.live.timestamp <= (this.latest(state) ?? -Infinity)) this.updateLive(state, null)
        if (reseed) state.generation = ++this.nextGeneration
      }
      if (snapshot && reseed) snapshot.valid = false
      if (this.universe.has(key) || snapshot) this.queueLocal(batch[0].instrument, batch[0].timeframe, true)
    }
    this.trim()
  }

  async load(state, priority = 'foreground') {
    if (state.loaded) return
    return this.reload(state, priority)
  }

  async reload(state, priority = 'foreground') {
    // A source task resolves only after its durable write. If an earlier read
    // is still running, wait for it and then perform a new read of that commit.
    if (state.loading) { await state.loading; return this.reload(state, priority) }
    const task = (async () => {
      while (!this.closed) {
        const version = state.sourceVersion
        const rows = await this.store.candles({ instrument: state.instId, timeframe: state.timeframe }, sourcePriority(priority))
        if (version !== state.sourceVersion) continue
        const next = new Map(rows.filter(row => row.confirmed).map(row => [row.timestamp, this.normalize(row)]))
        const oldLatest = this.latest(state)
        let changed = false, prices = false, reseed = false
        for (const [hour, row] of next) {
          const previous = state.rows.get(hour)
          if (!sameRow(previous, row)) changed = true
          if (priceChanged(previous, row)) {
            prices = true
            if (oldLatest !== null && hour <= oldLatest) reseed = true
          }
        }
        for (const hour of state.rows.keys()) if (!next.has(hour)) { changed = true; prices = true; reseed = true }
        state.rows = next
        state.loaded = true
        if (changed) {
          state.sourceVersion += 1
          this.sourceVersions.set(state.key, (this.sourceVersions.get(state.key) ?? 0) + 1)
        }
        if (prices) state.priceVersion += 1
        if (reseed) {
          state.generation = ++this.nextGeneration
          const snapshot = this.snapshots.get(state.key)
          if (snapshot) snapshot.valid = false
        }
        if (state.live && state.live.timestamp <= (this.latest(state) ?? -Infinity)) this.updateLive(state, null)
        return
      }
      throw new Error('Prepared chart data service is closed.')
    })().finally(() => { if (state.loading === task) state.loading = null })
    state.loading = task
    return task
  }

  invalidate(instId, timeframe) {
    const key = seriesKey(instId, timeframe), state = this.series.get(key)
    this.sourceVersions.set(key, (this.sourceVersions.get(key) ?? 0) + 1)
    const snapshot = this.snapshots.get(key)
    if (snapshot) snapshot.valid = false
    else this.snapshots.set(key, { valid: false })
    if (state) {
      state.sourceVersion += 1
      state.priceVersion += 1
      state.generation = ++this.nextGeneration
      state.rows.clear()
      state.loaded = false
      state.floor = null
      state.indicators.clear()
      state.latestAt = 0
    }
    if (this.universe.has(key) || snapshot) this.queueLocal(instId, timeframe, true)
  }

  updateLive(state, candle) {
    if (candle && state.live && (candle.timestamp < state.live.timestamp
      || candle.timestamp === state.live.timestamp && candle.volume < state.live.volume)) return false
    const live = candle && !candle.confirmed && candle.timestamp > (this.latest(state) ?? -Infinity) ? candle : null
    if (sameRow(state.live, live) || state.live === live) return false
    state.live = live
    state.liveVersion += 1
    return true
  }

  async setLive(instId, timeframe, candle) {
    if (this.closed) return null
    if (!['5m', '15m', '1H'].includes(timeframe)) throw new Error('Unsupported chart timeframe.')
    if (candle && (candle.confirmed || candle.instrument !== instId || candle.timeframe !== timeframe || !Number.isSafeInteger(candle.timestamp) || candle.timestamp % intervalFor(timeframe))) throw new Error('Invalid forming candle.')
    const state = this.state(instId, timeframe)
    if (!this.updateLive(state, candle)) return this.cached(state.key)
    state.active += 1
    try {
      await this.load(state, 'background')
      while (!this.closed) {
        const version = state.sourceVersion, liveVersion = state.liveVersion
        await this.indicators(state, 'foreground')
        if (version !== state.sourceVersion || liveVersion !== state.liveVersion) continue
        const snapshot = this.snapshots.get(state.key)
        if (!snapshot?.valid) return this.local(instId, timeframe, { force: true, persist: false })
        const liveBar = state.live?.timestamp === snapshot.frame.endHour + state.intervalMS ? state.indicators.get(state.live.timestamp) : undefined
        const frame = { ...snapshot.frame, liveBar, revision: this.revision(instId) }
        // The confirmed snapshot and watermark stay unchanged. A forming tick
        // publishes an in-memory projection without a Parquet/snapshot write.
        this.snapshots.set(state.key, { ...snapshot, frame })
        this.emit(frame)
        return frame
      }
      return null
    } finally { state.active -= 1; this.trim() }
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

  applyFloor(state, result) {
    const floor = result?.floor
    if (Number.isSafeInteger(floor) && floor >= 0 && floor % state.intervalMS === 0) state.floor = Math.max(state.floor ?? 0, floor)
  }

  async refreshLatest(state, priority = 'prepared') {
    if (state.latestTask) return state.latestTask
    if (state.latestAt + REFRESH_MS > Date.now()) return
    state.latestTask = (async () => {
      const result = await this.history.latest(state.instId, state.timeframe, sourcePriority(priority))
      if (this.closed) throw new Error('Prepared chart data service is closed.')
      this.applyFloor(state, result)
      await this.reload(state, priority)
      if (result?.live && (!state.live || result.live.timestamp >= state.live.timestamp)) this.updateLive(state, result.live)
      state.latestAt = Date.now()
    })().finally(() => { state.latestTask = null })
    return state.latestTask
  }

  async ensurePrices(state, from, through, priority = 'prepared') {
    let missing = false
    for (let hour = Math.max(from, state.floor ?? from); hour <= through; hour += state.intervalMS) {
      const row = state.rows.get(hour)
      if (!row || !Number.isFinite(row.baseVolume)) { missing = true; break }
    }
    if (!missing) return
    await this.job(`price:${state.key}:${from}:${through}`, async () => {
      const result = await this.history.ensurePrices(state.instId, state.timeframe, from, through, sourcePriority(priority))
      if (this.closed) throw new Error('Prepared chart data service is closed.')
      this.applyFloor(state, result)
      await this.reload(state, priority)
      for (let hour = Math.max(from, state.floor ?? from); hour <= through; hour += state.intervalMS) {
        if (!Number.isFinite(state.rows.get(hour)?.baseVolume)) throw new Error('The history task did not provide complete source candle coverage.')
      }
    })
  }

  async ensureStatistics(state, from, through, priority = 'prepared') {
    const missing = []
    for (let hour = from; hour <= through; hour += state.intervalMS) {
      const row = state.rows.get(hour)
      if (row && (!sourceFresh(row, 1) || !sourceFresh(row, 2))) missing.push(hour)
    }
    if (!missing.length) return
    const first = missing[0], end = missing.at(-1)
    await this.job(`statistics:${state.key}:${first}:${end}`, async () => {
      await this.history.ensureStatistics(state.instId, state.timeframe, first, end, sourcePriority(priority))
      if (this.closed) throw new Error('Prepared chart data service is closed.')
      await this.reload(state, priority)
    })
  }

  drainCalculations() {
    if (this.activeCalculation !== null || this.closed || !this.calculationQueue.length) return
    if (!this.worker) {
      this.worker = new Worker(new URL('./prepared-chart-worker.js', import.meta.url))
      this.worker.unref()
      this.worker.on('message', ({ id, bars, error }) => {
        const pending = this.calculations.get(id)
        if (!pending) return
        this.calculations.delete(id)
        this.activeCalculation = null
        if (error) pending.reject(new Error(error))
        else pending.resolve(bars)
        this.drainCalculations()
        if (!this.calculations.size) this.worker?.unref()
      })
      this.worker.on('error', error => {
        for (const pending of this.calculations.values()) pending.reject(error)
        this.calculations.clear()
        this.calculationQueue = []
        this.activeCalculation = null
        this.worker = null
      })
    }
    const index = this.calculationQueue.findIndex(id => this.calculations.get(id)?.priority === 'foreground')
    const [id] = this.calculationQueue.splice(index < 0 ? 0 : index, 1)
    const pending = this.calculations.get(id)
    this.activeCalculation = id
    this.worker.ref()
    this.worker.postMessage({ id, candles: pending.candles, intervalMS: pending.intervalMS })
  }

  calculate(candles, intervalMS, priority = 'foreground') {
    if (this.closed) return Promise.reject(new Error('Prepared chart data service is closed.'))
    const id = ++this.nextCalculation
    return new Promise((resolve, reject) => {
      this.calculations.set(id, { resolve, reject, candles, intervalMS, priority })
      this.calculationQueue.push(id)
      this.drainCalculations()
    })
  }

  async indicators(state, priority = 'foreground') {
    if (state.calculation) return state.calculation
    const task = (async () => {
      while (state.calculatedVersion !== state.priceVersion || state.calculatedLiveVersion !== state.liveVersion) {
        const version = state.priceVersion, liveVersion = state.liveVersion
        const candles = [...state.rows.values()].map(row => Object.fromEntries(priceFields.map(field => [field, row[field]])))
        if (state.live && !state.rows.has(state.live.timestamp)) candles.push(state.live)
        const bars = await this.calculate(candles, state.intervalMS, priority)
        if (version !== state.priceVersion || liveVersion !== state.liveVersion) continue
        state.indicators = new Map(bars.map(bar => [bar.hour, bar]))
        state.calculatedVersion = version
        state.calculatedLiveVersion = liveVersion
      }
    })().finally(() => { if (state.calculation === task) state.calculation = null })
    state.calculation = task
    return task
  }

  // Every consumer projects the same full-history calculation. A list window
  // only truncates the result; it can never choose a different recursive seed.
  async projectSeries(instId, timeframe) {
    const state = this.state(instId, timeframe)
    state.active += 1
    try {
      await this.load(state, 'background')
      while (!this.closed) {
        const version = state.sourceVersion
        await this.indicators(state, 'background')
        if (version !== state.sourceVersion) continue
        const end = this.latest(state), bars = []
        for (let hour = end; hour !== null && state.rows.has(hour); hour -= state.intervalMS) {
          const row = state.rows.get(hour), indicator = state.indicators.get(hour)
          if (!indicator) break
          bars.push({ ...indicator, oi: row.oi, buy: row.buy, sell: row.sell })
        }
        return { end, bars: bars.reverse() }
      }
      throw new Error('Prepared chart data service is closed.')
    } finally { state.active -= 1; this.trim() }
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
      oiUnavailableReason: raw.oi === null ? 'not-published' : undefined,
      takerUnavailableReason: raw.buy === null || raw.sell === null ? 'not-published' : undefined }
  }

  async prepare(instId, timeframe, targetEnd) {
    if (!['5m', '15m', '1H'].includes(timeframe)) throw new Error('Unsupported chart timeframe.')
    if (targetEnd !== undefined && !Number.isFinite(targetEnd)) throw new Error('Invalid chart window end.')
    if (targetEnd === undefined) {
      const local = await this.local(instId, timeframe)
      if (local) { this.queueRemote(instId, timeframe); return local }
    }
    const state = this.state(instId, timeframe)
    state.active += 1
    this.trim()
    try {
      while (!this.closed) {
        const frame = await this.prepareState(state, targetEnd)
        if (targetEnd === undefined) {
          const saved = await this.saveCompact(state, this.compact(frame))
          if (saved) return saved
        } else {
          if (this.universe.has(state.key)) this.queueLocal(instId, timeframe, true)
          return frame
        }
      }
      throw new Error('Prepared chart data service is closed.')
    }
    finally { state.active -= 1; this.trim() }
  }

  async prepareState(state, targetEnd, { priority = 'prepared' } = {}) {
    const { instId, timeframe, intervalMS: step } = state
    await this.load(state, priority === 'chartWarm' ? 'background' : 'foreground')
    this.listingFloor(state)
    const unavailable = this.insufficientHistory(state)
    if (unavailable) return this.produced(state, unavailable)
    if (targetEnd === undefined) await this.refreshLatest(state, priority)
    let latestEnd = this.latest(state)
    const ceiling = Math.floor(Date.now() / step) * step - step
    if (state.floor !== null && ceiling < state.floor + (VISIBLE - 1) * step) {
      // The listing timestamp proves that 96 completed periods cannot exist
      // yet. Do not ask the exchange to repair future, nonexistent candles.
      const availableCandles = latestEnd === null ? 0 : Math.max(0, Math.floor((Math.min(latestEnd, ceiling) - state.floor) / step) + 1)
      return this.produced(state, { instId, timeframe, intervalMS: step, endHour: null, latestEnd, oldestHour: state.floor,
        historyExhausted: true, generation: state.generation, revision: this.revision(instId), bars: [],
        oiState: 'unavailable', takerState: 'unavailable', indicatorState: 'unavailable', error: '',
        unavailable: { reason: 'insufficient-history', availableCandles, requiredCandles: VISIBLE, retryAt: state.floor + VISIBLE * step + 1_000 } })
    }
    if (latestEnd === null && targetEnd === undefined) throw new Error('No completed source candles are available.')
    let end = Math.min(targetEnd === undefined ? latestEnd : Math.floor(targetEnd / step) * step, ceiling)
    if (state.floor !== null) end = Math.max(end, state.floor + (VISIBLE - 1) * step)
    if (latestEnd !== null && targetEnd === undefined) end = Math.min(end, latestEnd)
    await this.ensurePrices(state, Math.max(end - (VISIBLE - 1 + WARMUP) * step, state.floor ?? -Infinity), end, priority)
    latestEnd = this.latest(state)
    if (state.floor !== null) {
      const clampedEnd = Math.min(latestEnd, Math.max(end, state.floor + (VISIBLE - 1) * step))
      if (clampedEnd !== end) {
        end = clampedEnd
        await this.ensurePrices(state, Math.max(end - (VISIBLE - 1 + WARMUP) * step, state.floor), end, priority)
        latestEnd = this.latest(state)
      }
    }
    const first = end - (VISIBLE - 1) * step
    const available = []
    for (let hour = first; hour <= end; hour += step) {
      if (!state.rows.has(hour) || !Number.isFinite(state.rows.get(hour).baseVolume)) throw new Error('A complete 96-candle source window is not available.')
      available.push(state.rows.get(hour))
    }
    await this.ensureStatistics(state, first, end, priority)
    if (!state.loaded) return this.prepareState(state, targetEnd, { priority })
    do { await this.indicators(state, priority === 'chartWarm' ? 'background' : 'foreground') }
    while (state.calculatedVersion !== state.priceVersion || state.calculatedLiveVersion !== state.liveVersion)
    if (!state.loaded) return this.prepareState(state, targetEnd, { priority })
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
    return this.produced(state, { instId, timeframe, intervalMS: step, endHour: end, latestEnd, oldestHour: state.floor,
      historyExhausted: state.floor !== null && first <= state.floor, generation, revision: this.revision(instId),
      bars: [...before, ...central, ...after], oiState, takerState, indicatorState,
      liveBar: targetEnd === undefined && state.live?.timestamp === end + step ? state.indicators.get(state.live.timestamp) : undefined, error: '' })
  }

  async dispose() {
    this.closed = true
    if (this.warmTimer !== null) clearTimeout(this.warmTimer)
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
    this.localQueue.clear()
    this.remoteQueue.clear()
    this.listeners.clear()
    for (const pending of this.calculations.values()) pending.reject(new Error('Prepared chart data service is closed.'))
    this.calculations.clear()
    this.calculationQueue = []
    this.activeCalculation = null
    const worker = this.worker
    this.worker = null
    if (worker) await worker.terminate()
    await Promise.allSettled([this.localRunning, this.remoteRunning, ...this.localTasks.values(), ...this.tasks.values()].filter(Boolean))
  }
}
