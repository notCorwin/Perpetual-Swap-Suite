import { Worker } from 'node:worker_threads'
import { statisticsMask } from './statistics-state.js'
import { appendIndicatorCandle, projectIndicatorCandle } from './indicators.js'
import { bandwidthExpansion } from './market-metrics.js'

const VISIBLE = 96
const WARMUP = 199
const LOCAL_HISTORY_BARS = 16_384
const SNAPSHOT_SCHEMA = 2
const CHECKPOINT_SCHEMA = 1
const FORMULA_VERSION = 'native-ema200-wilder-flat50-rsi6-12-24-boll20-2-base-vwap14-roc9-maroc9-v2'
const SOURCE_RETRY_MS = 5_000
const CONFIRMATION_GRACE_MS = 1_000
const REMOTE_CONCURRENCY = 4
const LOCAL_CONCURRENCY = 4
const RESTORE_CONCURRENCY = 16
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
const bandwidth = bar => !bar || ![bar.bollUpper, bar.bollMiddle, bar.bollLower].every(Number.isFinite) || bar.bollMiddle <= 0
  ? null : (bar.bollUpper - bar.bollLower) / bar.bollMiddle * 100
const nullableNumber = value => value === null || Number.isFinite(value)
const positive = value => Number.isFinite(value) && value > 0

/** Durable source pages and canonical calculations are independent of UI focus. */
export class PreparedChartPipeline {
  constructor({ store, history, normalize, revision, instrument, streaming = () => false }) {
    Object.assign(this, { store, history, normalize, revision, instrument, streaming })
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
    this.warmUniverse = new Map()
    this.requestedUniverse = new Map()
    this.requestedIDs = null
    this.preferredTimeframe = null
    this.focusKey = null
    this.localQueue = new Map()
    this.restoreQueue = new Map()
    this.restoreTasks = new Map()
    this.restoredKeys = new Set()
    this.restoreRunning = null
    this.restoreActive = new Set()
    this.restoreFinish = null
    this.canonicalQueue = []
    this.canonicalActive = 0
    this.canonicalTasks = new Set()
    this.remoteQueue = new Map()
    this.remoteAttempts = new Map()
    this.localRunning = null
    this.localFinish = null
    this.localActive = new Set()
    this.remoteRunning = null
    this.remoteFinish = null
    this.remoteActive = new Set()
    this.warmTimer = null
    this.refreshTimer = null
    this.calculationQueue = []
    this.activeCalculation = null
    this.frameVersions = new WeakMap()
    // Full navigation histories remain an LRU. A subscribed series retains only
    // its recursive indicator seed and a bounded source tail between ticks.
    this.liveStates = new Map()
    this.liveSeeds = new Map()
    this.realtimeKeys = new Set()
  }

  state(instId, timeframe) {
    const key = seriesKey(instId, timeframe)
    let state = this.series.get(key)
    if (!state) {
      state = { key, instId, timeframe, intervalMS: intervalFor(timeframe), rows: new Map(), latestHour: null, loaded: false, loading: null,
        priceVersion: 0, sourceVersion: 0, calculatedVersion: -1, calculation: null, indicators: new Map(), generation: this.snapshots.get(key)?.valid ? this.snapshots.get(key).frame.generation : ++this.nextGeneration, active: 0,
        floor: null, latestTask: null, latestAt: 0, live: null, liveVersion: 0, calculatedLiveVersion: -1, indicatorState: null }
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
    this.trimLiveStates()
  }

  setRealtimeSubscriptions(subscriptions) {
    const keys = new Set(subscriptions.map(({ instId, timeframe }) => seriesKey(instId, timeframe)))
    if (keys.size === this.realtimeKeys.size && [...keys].every(key => this.realtimeKeys.has(key))) return
    this.realtimeKeys = keys
    this.warmUniverse = new Map(subscriptions.map(target => [seriesKey(target.instId, target.timeframe), target]))
    this.updateUniverse()
    this.trimLiveStates(true)
  }

  trimLiveStates(removeUnsubscribed = false) {
    let extra = [...this.liveStates.keys()].filter(key => !this.realtimeKeys.has(key) && !this.universe.has(key)).length
    for (const [key] of this.liveStates) {
      if (this.realtimeKeys.has(key) || this.universe.has(key) || this.liveSeeds.has(key)) continue
      if (!removeUnsubscribed && extra <= 16) break
      this.liveStates.delete(key)
      extra -= 1
    }
  }

  liveState(instId, timeframe) {
    const key = seriesKey(instId, timeframe)
    let state = this.liveStates.get(key)
    if (!state) {
      state = { key, instId, timeframe, intervalMS: intervalFor(timeframe), rows: new Map(), latestHour: null, indicators: new Map(),
        indicatorState: null, sourceVersion: 0, generation: 0, floor: null, live: null, liveVersion: 0 }
      this.liveStates.set(key, state)
    }
    return state
  }

  retainLiveState(state) {
    if (!state.indicatorState) return
    const live = this.liveState(state.instId, state.timeframe)
    const hours = [...state.rows.keys()].sort((left, right) => left - right).slice(-(VISIBLE + WARMUP))
    live.rows = new Map(hours.map(hour => [hour, state.rows.get(hour)]))
    live.latestHour = this.latest(state)
    live.indicators = new Map(hours.map(hour => [hour, state.indicators.get(hour)]).filter(([, bar]) => bar))
    live.indicatorState = structuredClone(state.indicatorState)
    live.sourceVersion = state.sourceVersion
    live.generation = state.generation
    live.floor = state.floor
    live.bollExpansion = bandwidthExpansion(this.projectRows(state).bars)
    if (state.live) this.updateLive(live, state.live)
    this.projectLive(live)
    this.trimLiveStates()
  }

  projectLive(state) {
    const previous = state.projectedLiveHour
    if (previous !== undefined && !state.rows.has(previous)) state.indicators.delete(previous)
    state.projectedLiveHour = undefined
    if (!state.indicatorState || !state.live || state.live.timestamp <= (state.indicatorState.lastTimestamp ?? -Infinity)) return
    const bar = projectIndicatorCandle(state.indicatorState, state.live)
    if (bar) { state.indicators.set(bar.hour, { ...bar, indicatorsObserved: true }); state.projectedLiveHour = bar.hour }
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
    this.requestedUniverse = new Map([...new Set(instIds)].map(instId => [seriesKey(instId, timeframe), { instId, timeframe }]))
    this.requestedIDs = new Set([...instIds, ...(focusInstId ? [focusInstId] : [])])
    this.preferredTimeframe = timeframe
    this.focusKey = focusInstId ? seriesKey(focusInstId, timeframe) : null
    this.updateUniverse()
    const frames = [...this.snapshots.keys()].map(key => this.cached(key)).filter(frame => frame && this.requestedIDs.has(frame.instId))
      .sort((left, right) => Number(right.timeframe === timeframe) - Number(left.timeframe === timeframe))
    return { frames }
  }

  updateUniverse() {
    this.universe = new Map([...this.warmUniverse, ...this.requestedUniverse])
    for (const [key] of this.localQueue) if (!this.universe.has(key)) this.localQueue.delete(key)
    for (const [key] of this.restoreQueue) if (!this.universe.has(key)) this.restoreQueue.delete(key)
    for (const [key] of this.remoteQueue) if (!this.universe.has(key)) this.remoteQueue.delete(key)
    for (const [key] of this.remoteAttempts) if (!this.universe.has(key)) this.remoteAttempts.delete(key)
    for (const [key, target] of this.universe) {
      const frame = this.cached(key)
      if (!frame || !this.liveStates.get(key)?.indicatorState) this.queueLocal(target.instId, target.timeframe, Boolean(frame))
      if (this.sourceDeadline(target) <= Date.now()) this.queueRemote(target.instId, target.timeframe, false)
    }
    if (!this.localQueue.size && this.remoteQueue.size) {
      const first = this.universe.get(this.focusKey) ?? this.universe.values().next().value
      if (first) this.queueLocal(first.instId, first.timeframe)
    }
    this.scheduleRefresh()
    this.trimSnapshots()
  }

  nextKey(queue, eligible = () => true) {
    const keys = [...queue.keys()].filter(eligible)
    return keys.includes(this.focusKey) ? this.focusKey
      : keys.find(key => queue.get(key).timeframe === this.preferredTimeframe) ?? keys[0]
  }

  emit(frame) {
    if (this.requestedIDs && !this.requestedIDs.has(frame.instId)) return
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
    if (!this.restoredKeys.has(key) && !this.snapshots.has(key) && !this.restoreTasks.has(key)) this.restoreQueue.set(key, { instId, timeframe })
    if (this.warmTimer === null) {
      this.warmTimer = setTimeout(() => { this.warmTimer = null; void this.drainRestores(); void this.drainLocal() }, 0)
      this.warmTimer.unref?.()
    }
  }

  restoreOnce(instId, timeframe, priority) {
    const key = seriesKey(instId, timeframe)
    if (this.restoreTasks.has(key)) return this.restoreTasks.get(key)
    const task = this.restoreSnapshot(instId, timeframe, priority).finally(() => {
      this.restoredKeys.add(key)
      if (this.restoreTasks.get(key) === task) this.restoreTasks.delete(key)
    })
    this.restoreTasks.set(key, task)
    return task
  }

  drainRestores() {
    if (this.closed || this.nextKey(this.restoreQueue, key => !this.restoreActive.has(key)) === undefined) return this.restoreRunning
    if (!this.restoreRunning) this.restoreRunning = new Promise(resolve => { this.restoreFinish = resolve })
    const running = this.restoreRunning
    while (this.restoreActive.size < RESTORE_CONCURRENCY) {
      const key = this.nextKey(this.restoreQueue, key => !this.restoreActive.has(key))
      if (key === undefined) break
      const target = this.restoreQueue.get(key)
      this.restoreQueue.delete(key)
      this.restoreActive.add(key)
      void (async () => {
        try { await this.restoreOnce(target.instId, target.timeframe, key === this.focusKey ? 'foreground' : 'background') }
        catch { /* Rebuild a missing or invalid derived checkpoint from durable source rows. */ }
        finally {
          this.restoreActive.delete(key)
          if (!this.restoreActive.size) { this.restoreRunning = null; this.restoreFinish(); this.restoreFinish = null }
          if (!this.closed) { void this.drainRestores(); void this.drainLocal(); void this.drainRemote() }
        }
      })()
    }
    return running
  }

  localEligible(key) { return !this.localActive.has(key) && (this.restoredKeys.has(key) || this.snapshots.has(key)) }

  canonical(instId, timeframe, priority, operation) {
    if (this.closed) return Promise.reject(new Error('Prepared chart data service is closed.'))
    const task = new Promise((resolve, reject) => {
      this.canonicalQueue.push({ key: seriesKey(instId, timeframe), timeframe, priority, operation, resolve, reject })
      this.drainCanonical()
    })
    this.canonicalTasks.add(task)
    task.then(() => this.canonicalTasks.delete(task), () => this.canonicalTasks.delete(task))
    return task
  }

  drainCanonical() {
    while (!this.closed && this.canonicalActive < LOCAL_CONCURRENCY && this.canonicalQueue.length) {
      let index = this.canonicalQueue.findIndex(job => job.key === this.focusKey)
      if (index < 0) index = this.canonicalQueue.findIndex(job => job.priority === 'foreground')
      if (index < 0) index = this.canonicalQueue.findIndex(job => job.timeframe === this.preferredTimeframe)
      const [job] = this.canonicalQueue.splice(Math.max(0, index), 1)
      this.canonicalActive += 1
      void Promise.resolve().then(job.operation).then(job.resolve, job.reject).finally(() => { this.canonicalActive -= 1; this.drainCanonical() })
    }
  }

  drainLocal() {
    if (this.closed || this.nextKey(this.localQueue, key => this.localEligible(key)) === undefined) return this.localRunning
    if (!this.localRunning) this.localRunning = new Promise(resolve => { this.localFinish = resolve })
    const running = this.localRunning
    while (this.localActive.size < LOCAL_CONCURRENCY) {
      const key = this.nextKey(this.localQueue, key => this.localEligible(key))
      if (key === undefined) break
      const target = this.localQueue.get(key)
      this.localQueue.delete(key)
      this.localActive.add(key)
      void (async () => {
        try { await this.local(target.instId, target.timeframe, { force: target.force, priority: key === this.focusKey ? 'foreground' : 'background' }) }
        catch { /* A local read failure leaves this candidate for independent source preparation. */ }
        finally {
          this.localActive.delete(key)
          if (!this.localActive.size) { this.localRunning = null; this.localFinish(); this.localFinish = null }
          if (!this.closed) { void this.drainLocal(); void this.drainRemote() }
        }
      })()
    }
    return running
  }

  queueRemote(instId, timeframe, schedule = true) {
    if (this.closed) return
    const key = seriesKey(instId, timeframe)
    if (!this.remoteActive.has(key) && (this.remoteAttempts.get(key) ?? 0) <= Date.now()) this.remoteQueue.set(key, { instId, timeframe })
    if (!schedule) return
    if (!this.localTasks.has(key) && !this.localActive.has(key) && !this.localQueue.has(key) && !this.snapshots.has(key)) this.queueLocal(instId, timeframe)
    void this.drainRemote()
    this.scheduleRefresh()
  }

  sourceDeadline({ instId, timeframe }, now = Date.now()) {
    const key = seriesKey(instId, timeframe), snapshot = this.snapshots.get(key)
    let deadline = now
    if (snapshot?.valid) {
      if (snapshot.frame.unavailable) deadline = snapshot.frame.unavailable.retryAt
      else {
        const step = intervalFor(timeframe), boundary = Math.floor(now / step) * step
        const latest = snapshot.frame.endHour ?? -Infinity
        // A price-only confirmation does not advance prepared coverage until
        // its native statistics are observed too. Keep their recovery deadline
        // even while the previous complete window remains visible.
        deadline = latest < boundary - step ? boundary + CONFIRMATION_GRACE_MS : boundary + step + CONFIRMATION_GRACE_MS
        if (snapshot.validUntil !== null) deadline = Math.min(deadline, snapshot.validUntil)
      }
    }
    return Math.max(deadline, this.remoteAttempts.get(key) ?? 0)
  }

  sourceStateChanged() {
    if (this.closed) return
    for (const target of this.universe.values()) if (this.sourceDeadline(target) <= Date.now()) this.queueRemote(target.instId, target.timeframe, false)
    void this.drainRemote()
    this.scheduleRefresh()
  }

  scheduleRefresh() {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    if (this.closed || !this.universe.size) return
    // Active and queued series already own their next attempt. Scheduling
    // their expired deadlines would poll a held source every second.
    const idle = [...this.universe].filter(([key]) => !this.remoteActive.has(key) && !this.remoteQueue.has(key)).map(([, target]) => target)
    if (!idle.length) return
    const next = Math.min(...idle.map(target => this.sourceDeadline(target)))
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      for (const [key, target] of this.universe) if (!this.remoteActive.has(key) && this.sourceDeadline(target) <= Date.now()) this.remoteQueue.set(key, target)
      void this.drainRemote()
      this.scheduleRefresh()
    }, Math.max(1, Math.min(2_147_483_647, next - Date.now())))
    this.refreshTimer.unref?.()
  }

  drainRemote() {
    if (this.closed || !this.remoteQueue.size) return this.remoteRunning
    if (!this.remoteRunning) this.remoteRunning = new Promise(resolve => { this.remoteFinish = resolve })
    const running = this.remoteRunning
    while (this.remoteActive.size < REMOTE_CONCURRENCY) {
      // Source latency belongs to this series. A later universe update can
      // fill idle lanes even while an older contract is still waiting.
      const key = this.nextKey(this.remoteQueue, key => !this.remoteActive.has(key) && !this.localActive.has(key) && !this.localQueue.has(key) && !this.localTasks.has(key))
      if (key === undefined) break
      const target = this.remoteQueue.get(key)
      this.remoteQueue.delete(key)
      if (!this.universe.has(key) || this.sourceDeadline(target) > Date.now()) continue
      this.remoteActive.add(key)
      this.remoteAttempts.delete(key)
      const state = this.state(target.instId, target.timeframe)
      state.active += 1
      this.trim()
      void (async () => {
        try {
          while (!this.closed) {
            const frame = await this.prepareState(state, undefined, { priority: 'chartWarm' })
            if (await this.saveCompact(state, this.compact(frame))) {
              // A successful HTTP response may still lack a closed candle or
              // a renewed statistics lease. Retry that unresolved gap, never
              // turn its already-expired deadline into a busy loop.
              if (this.universe.has(key) && this.sourceDeadline(target) <= Date.now()) this.remoteAttempts.set(key, Date.now() + SOURCE_RETRY_MS)
              break
            }
          }
        } catch {
          if (this.universe.has(key)) this.remoteAttempts.set(key, Date.now() + SOURCE_RETRY_MS)
        } finally {
          this.remoteActive.delete(key)
          state.active -= 1
          this.trim()
          if (!this.remoteActive.size) {
            this.remoteRunning = null
            this.remoteFinish()
            this.remoteFinish = null
          }
          if (!this.closed && this.localQueue.size) void this.drainLocal()
          if (!this.closed && this.remoteQueue.size) void this.drainRemote()
          this.scheduleRefresh()
        }
      })()
    }
    if (!this.remoteActive.size && this.remoteRunning === running) {
      this.remoteRunning = null
      this.remoteFinish()
      this.remoteFinish = null
    }
    this.scheduleRefresh()
    return running
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

  checkpoint(state) {
    if (!state.indicatorState) return null
    const hours = [...state.rows.keys()].sort((left, right) => left - right).slice(-(VISIBLE + WARMUP))
    if (hours.at(-1) !== state.indicatorState.lastTimestamp) return null
    const retained = this.liveStates.get(state.key)
    return structuredClone({ version: CHECKPOINT_SCHEMA,
      rows: hours.map(hour => state.rows.get(hour)),
      indicators: hours.map(hour => state.indicators.get(hour)),
      indicatorState: state.indicatorState, floor: state.floor,
      bollExpansion: retained?.indicatorState?.lastTimestamp === state.indicatorState.lastTimestamp ? retained.bollExpansion : state.bollExpansion,
    })
  }

  restoreCheckpoint(checkpoint, instId, timeframe, frame) {
    const state = checkpoint?.indicatorState, rows = checkpoint?.rows, indicators = checkpoint?.indicators, step = intervalFor(timeframe)
    if (checkpoint?.version !== CHECKPOINT_SCHEMA || !state || state.intervalMS !== step || !Number.isSafeInteger(state.lastTimestamp) || state.lastTimestamp % step || !Number.isSafeInteger(state.count) || state.count < 1
      || !positive(state.previousClose) || !Number.isFinite(state.emaSeedSum) || !nullableNumber(state.ema) || !nullableNumber(state.previousROC) || !nullableNumber(state.previousMAROC)
      || !Array.isArray(state.closes) || state.closes.length !== Math.min(state.count, 20) || !state.closes.every(positive) || state.closes.at(-1) !== state.previousClose
      || !Array.isArray(state.volumes) || state.volumes.length !== Math.min(state.count, 14) || !state.volumes.every(value => value && positive(value.typicalPrice) && (value.volume === null || Number.isFinite(value.volume) && value.volume >= 0))
      || !Array.isArray(state.rocs) || state.rocs.length !== Math.min(state.count, 9) || !state.rocs.every(nullableNumber)
      || !Array.isArray(state.rsi) || state.rsi.length !== 3 || !state.rsi.every((value, index) => value && value.period === [6, 12, 24][index] && Number.isFinite(value.gains) && value.gains >= 0 && Number.isFinite(value.losses) && value.losses >= 0)
      || !Array.isArray(rows) || rows.length < VISIBLE || rows.length > VISIBLE + WARMUP || !Array.isArray(indicators) || indicators.length !== rows.length
      || checkpoint.floor !== null && (!Number.isSafeInteger(checkpoint.floor) || checkpoint.floor < 0 || checkpoint.floor % step)) return null
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index], bar = indicators[index]
      if (!row || row.instrument !== instId || row.timeframe !== timeframe || row.confirmed !== true || !Number.isSafeInteger(row.timestamp) || row.timestamp % step
        || index > 0 && row.timestamp <= rows[index - 1].timestamp || !['open', 'high', 'low', 'close'].every(field => positive(row[field]))
        || !bar || bar.hour !== row.timestamp || bar.confirmed !== true || !indicatorFields.every(field => nullableNumber(bar[field])) || bar.close !== row.close) return null
    }
    if (rows.at(-1).timestamp !== state.lastTimestamp || rows.at(-1).close !== state.previousClose || indicators.at(-1).ema !== state.ema
      || rows[0].timestamp > frame.bars[0].hour || state.lastTimestamp < frame.endHour) return null
    let contiguous = 1
    for (let index = rows.length - 1; index > 0 && rows[index].timestamp - rows[index - 1].timestamp === step; index -= 1) contiguous += 1
    if (state.count < contiguous || state.volumes.at(-1).volume !== (rows.at(-1).baseVolume ?? null)) return null
    const raw = new Map(rows.map(row => [row.timestamp, row])), calculated = new Map(indicators.map(bar => [bar.hour, bar]))
    if (frame.bars.some(bar => !raw.has(bar.hour) || !calculated.has(bar.hour)
      || ['open', 'high', 'low', 'close', ...indicatorFields].some(field => !Object.is(bar[field], (indicatorFields.includes(field) ? calculated : raw).get(bar.hour)[field])))) return null
    const live = this.liveState(instId, timeframe)
    live.rows = new Map(rows.map(row => [row.timestamp, this.normalize(row)]))
    live.indicators = new Map(indicators.map(bar => [bar.hour, bar]))
    live.indicatorState = structuredClone(state)
    live.latestHour = state.lastTimestamp
    live.floor = checkpoint.floor
    live.generation = frame.generation
    live.bollExpansion = checkpoint.bollExpansion ?? null
    this.projectLive(live)
    return live
  }

  async saveCompact(state, frame, version = this.frameVersions.get(frame), { persist = true } = {}) {
    if (!version || state.sourceVersion !== version.sourceVersion || frame.generation !== state.generation) return null
    const watermark = await this.store.candleWatermark(state.instId, state.timeframe, 'background')
    if (this.closed || state.sourceVersion !== version.sourceVersion || frame.generation !== state.generation) return null
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
    const snapshot = { schemaVersion: SNAPSHOT_SCHEMA, formulaVersion: FORMULA_VERSION, watermark, validUntil, frame, checkpoint: frame.unavailable ? null : this.checkpoint(state) }
    // Live candles are an in-memory overlay, never a durable observation.
    const { liveBar: _liveBar, ...confirmedFrame } = frame
    if (persist) await this.store.writeChartSnapshot(state.instId, state.timeframe, { ...snapshot, frame: confirmedFrame })
    if (this.closed || state.sourceVersion !== version.sourceVersion || frame.generation !== state.generation) return null
    const live = this.liveStates.get(state.key) ?? state
    const liveBar = live.live?.timestamp === frame.endHour + live.intervalMS ? live.indicators.get(live.live.timestamp) : undefined
    const published = frame.liveBar === liveBar ? frame : { ...frame, liveBar }
    const changed = !existing?.valid || JSON.stringify(existing.frame) !== JSON.stringify(published)
    const { checkpoint: _checkpoint, ...resident } = snapshot
    this.snapshots.set(state.key, { ...resident, frame: published, valid: true })
    this.trimSnapshots()
    this.scheduleRefresh()
    if (changed) this.emit(published)
    return published
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
    if (!frame.unavailable) {
      const live = this.restoreCheckpoint(snapshot.checkpoint, instId, timeframe, restored)
      if (live && live.live?.timestamp === restored.endHour + live.intervalMS) restored.liveBar = live.indicators.get(live.live.timestamp)
    }
    const { checkpoint: _checkpoint, ...resident } = snapshot
    this.snapshots.set(key, { ...resident, frame: restored, valid: true })
    this.emit(restored)
    this.trimSnapshots()
    this.trimLiveStates()
    this.scheduleRefresh()
    if (!frame.unavailable && !this.liveStates.get(key)?.indicatorState && this.universe.has(key)) this.queueLocal(instId, timeframe, true)
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
      const live = this.liveStates.get(key)
      if (live?.indicatorState) {
        const frame = this.compactFrame(live)
        if (frame) {
          const saved = await this.saveCompact(live, this.produced(live, frame), undefined, { persist })
          if (saved) return saved
        }
        if (cached) return cached
      }
      if (!this.snapshots.has(key) && !this.restoredKeys.has(key)) {
        const saved = await this.restoreOnce(instId, timeframe, priority)
        if (saved && !force) return saved
      }
      return this.canonical(instId, timeframe, priority, async () => {
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
              await this.indicators(state, priority)
              if (version !== state.sourceVersion) continue
              frame = this.compactFrame(state)
              if (!frame) return this.cached(key)
            }
            const saved = await this.saveCompact(state, this.produced(state, frame, version), undefined, { persist })
            if (saved) return saved
          }
          return null
        } finally { state.active -= 1; this.trim() }
      })
    })().finally(() => { if (this.localTasks.get(key) === task) this.localTasks.delete(key) })
    this.localTasks.set(key, task)
    return task
  }

  compactFrame(state) {
    const frame = this.insufficientHistory(state)
    if (frame) return frame
    const hours = [...state.rows.keys()].sort((left, right) => right - left)
    let count = 0, prior = null, end = null
    for (const hour of hours) {
      const row = state.rows.get(hour)
      count = prior === null || prior - hour === state.intervalMS ? count : 0
      count = sourceFresh(row, 1) && sourceFresh(row, 2) ? count + 1 : 0
      prior = hour
      if (count === VISIBLE) { end = hour + 95 * state.intervalMS; break }
    }
    if (end === null) return null
    const bars = Array.from({ length: VISIBLE }, (_, index) => this.bar(state, end - (95 - index) * state.intervalMS))
    if (bars.some(bar => !bar)) return null
    return { instId: state.instId, timeframe: state.timeframe, intervalMS: state.intervalMS, endHour: end, latestEnd: end, oldestHour: state.floor,
      historyExhausted: state.floor !== null && bars[0].hour <= state.floor, generation: state.generation, revision: this.revision(state.instId), bars,
      oiState: bars.every(bar => bar.oi !== null) ? 'ready' : 'unavailable', takerState: bars.every(bar => bar.buy !== null && bar.sell !== null) ? 'ready' : 'unavailable',
      indicatorState: bars.every(bar => indicatorFields.every(field => Number.isFinite(bar[field]))) ? 'ready' : 'unavailable',
      liveBar: state.live?.timestamp === end + state.intervalMS ? state.indicators.get(state.live.timestamp) : undefined, error: '' }
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
          const bars = this.navigationBars(state, central, end)
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
      const state = this.series.get(key), live = this.liveStates.get(key)
      this.remoteAttempts.delete(key)
      this.sourceVersions.set(key, (this.sourceVersions.get(key) ?? 0) + 1)
      const snapshot = this.snapshots.get(key)
      let changed = false, reseed = false
      const oldLatest = Math.max(state ? extremeHour(state.rows) ?? -Infinity : -Infinity, live?.indicatorState?.lastTimestamp ?? -Infinity, snapshot?.frame?.endHour ?? -Infinity)
      for (const row of batch) {
        const old = previous.get(row.timestamp)
        if (priceChanged(old, row)) {
          changed = true
          if (row.timestamp <= oldLatest) reseed = true
        }
        if (state?.loaded) {
          state.rows.set(row.timestamp, this.normalize(row))
          state.latestHour = Math.max(state.latestHour ?? -Infinity, row.timestamp)
        }
      }
      if (state) {
        state.sourceVersion += 1
        if (changed) state.priceVersion += 1
        if (state.live && state.live.timestamp <= (this.latest(state) ?? -Infinity)) this.updateLive(state, null)
        if (reseed) state.generation = ++this.nextGeneration
      }
      if (snapshot && reseed) snapshot.valid = false
      if (live) {
        live.sourceVersion += 1
        if (reseed) {
          live.indicatorState = null
        } else if (live.indicatorState) {
          for (const row of [...batch].sort((left, right) => left.timestamp - right.timestamp)) {
            if (row.timestamp > live.indicatorState.lastTimestamp) {
              const previousHour = live.indicatorState.lastTimestamp, previous = live.indicators.get(previousHour)
              const indicator = appendIndicatorCandle(live.indicatorState, row)
              if (indicator) {
                const currentWidth = bandwidth(indicator), previousWidth = bandwidth(previous)
                live.bollExpansion = currentWidth === null ? null
                  : previousWidth === null || previousHour + live.intervalMS !== row.timestamp ? { hours: 0, complete: false }
                    : currentWidth <= previousWidth ? { hours: 0, complete: true }
                      : { hours: (live.bollExpansion?.hours ?? 0) + 1, complete: live.bollExpansion?.complete ?? false }
                live.indicators.set(indicator.hour, { ...indicator, indicatorsObserved: true })
              }
            }
            if (row.timestamp >= (extremeHour(live.rows, true) ?? -Infinity)) {
              live.rows.set(row.timestamp, this.normalize(row))
              live.latestHour = Math.max(live.latestHour ?? -Infinity, row.timestamp)
            }
          }
          const hours = [...live.rows.keys()].sort((left, right) => left - right)
          for (const hour of hours.slice(0, Math.max(0, hours.length - VISIBLE - WARMUP))) { live.rows.delete(hour); live.indicators.delete(hour) }
          if (live.live && live.live.timestamp <= live.indicatorState.lastTimestamp) this.updateLive(live, null)
          this.projectLive(live)
        }
      }
      if (this.universe.has(key) || snapshot) this.queueLocal(batch[0].instrument, batch[0].timeframe, true)
    }
    this.trim()
  }

  async load(state, priority = 'foreground') {
    if (state.loaded) return
    if (state.loading) return state.loading
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
        state.latestHour = extremeHour(next)
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
    const live = this.liveStates.get(key)
    if (live) live.indicatorState = null
    if (snapshot) snapshot.valid = false
    else this.snapshots.set(key, { valid: false })
    if (state) {
      state.sourceVersion += 1
      state.priceVersion += 1
      state.generation = ++this.nextGeneration
      state.rows.clear()
      state.latestHour = null
      state.loaded = false
      state.floor = null
      state.indicators.clear()
      state.latestAt = 0
      state.indicatorState = null
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
    const live = this.liveState(instId, timeframe), state = this.series.get(live.key)
    if (!this.updateLive(live, candle)) return this.cached(live.key)
    if (state) this.updateLive(state, candle)
    if (!live.indicatorState) {
      if (this.universe.has(live.key)) {
        this.queueLocal(instId, timeframe, Boolean(this.cached(live.key)))
        return this.cached(live.key)
      }
      let seed = this.liveSeeds.get(live.key)
      if (!seed) {
        const canonical = this.state(instId, timeframe)
        this.updateLive(canonical, live.live)
        canonical.active += 1
        seed = (async () => { await this.load(canonical, 'background'); this.listingFloor(canonical); await this.indicators(canonical, 'foreground') })()
          .finally(() => { canonical.active -= 1; this.liveSeeds.delete(live.key); this.trim() })
        this.liveSeeds.set(live.key, seed)
      }
      await seed
    }
    if (this.closed) return null
    this.projectLive(live)
    const snapshot = this.snapshots.get(live.key)
    if (!snapshot?.valid) return this.local(instId, timeframe, { force: true, persist: false })
    const completed = this.latest(live) > snapshot.frame.endHour ? this.compactFrame(live) ?? snapshot.frame : snapshot.frame
    const liveBar = live.live?.timestamp === completed.endHour + live.intervalMS ? live.indicators.get(live.live.timestamp) : undefined
    const frame = { ...completed, liveBar, revision: this.revision(instId) }
    this.snapshots.set(live.key, { ...snapshot, frame })
    this.emit(frame)
    return frame
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

  latest(state) { return state.latestHour }

  applyFloor(state, result) {
    const floor = result?.floor
    if (Number.isSafeInteger(floor) && floor >= 0 && floor % state.intervalMS === 0) state.floor = Math.max(state.floor ?? 0, floor)
  }

  async refreshLatest(state, priority = 'prepared') {
    if (state.latestTask) return state.latestTask
    const boundary = Math.floor(Date.now() / state.intervalMS) * state.intervalMS
    if (this.latest(state) !== null && this.latest(state) >= boundary - state.intervalMS
      && (this.streaming(state.instId, state.timeframe) || state.latestAt >= boundary)) return
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
      if (!row || !sourceFresh(row, 1) || !sourceFresh(row, 2)) missing.push(hour)
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
      this.worker.on('message', ({ id, bars, state, error }) => {
        const pending = this.calculations.get(id)
        if (!pending) return
        this.calculations.delete(id)
        this.activeCalculation = null
        if (error) pending.reject(new Error(error))
        else pending.resolve({ bars, state })
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
      while (state.calculatedVersion !== state.priceVersion) {
        const version = state.priceVersion
        const candles = [...state.rows.values()].map(row => Object.fromEntries(priceFields.map(field => [field, row[field]])))
        const { bars, state: indicatorState } = await this.calculate(candles, state.intervalMS, priority)
        if (version !== state.priceVersion) continue
        state.indicators = new Map(bars.map(bar => [bar.hour, bar]))
        state.indicatorState = indicatorState
        state.calculatedVersion = version
      }
      this.projectLive(state)
      state.calculatedLiveVersion = state.liveVersion
      this.retainLiveState(state)
    })().finally(() => { if (state.calculation === task) state.calculation = null })
    state.calculation = task
    return task
  }

  // Every consumer projects the same full-history calculation. A list window
  // only truncates the result; it can never choose a different recursive seed.
  async projectSeries(instId, timeframe) {
    return this.canonical(instId, timeframe, 'background', async () => {
      const state = this.state(instId, timeframe)
      state.active += 1
      try {
        await this.load(state, 'background')
        while (!this.closed) {
          const version = state.sourceVersion
          await this.indicators(state, 'background')
          if (version !== state.sourceVersion) continue
          return this.projectRows(state)
        }
        throw new Error('Prepared chart data service is closed.')
      } finally { state.active -= 1; this.trim() }
    })
  }

  projectRows(state) {
    const end = this.latest(state), bars = []
    for (let hour = end; hour !== null && state.rows.has(hour); hour -= state.intervalMS) {
      const row = state.rows.get(hour), indicator = state.indicators.get(hour)
      if (!indicator) break
      bars.push({ ...indicator, oi: row.oi, buy: row.buy, sell: row.sell })
    }
    return { end, bars: bars.reverse() }
  }

  /** List metrics need a fixed tail; expansion carries its full-history run. */
  async projectListSeries(instId, timeframe) {
    let live = this.liveStates.get(seriesKey(instId, timeframe))
    const key = seriesKey(instId, timeframe)
    if (!live?.indicatorState && !this.restoredKeys.has(key) && typeof this.store.readChartSnapshot === 'function') {
      try { await this.restoreOnce(instId, timeframe, 'background') }
      catch { /* Canonical source history can rebuild an invalid derived checkpoint. */ }
      live = this.liveStates.get(key)
    }
    if (!live?.indicatorState) {
      const projected = await this.projectSeries(instId, timeframe)
      live = this.liveStates.get(seriesKey(instId, timeframe))
      if (!live?.indicatorState) return { ...projected, bars: projected.bars.slice(-(VISIBLE + WARMUP)), bollExpansion: bandwidthExpansion(projected.bars) }
    }
    return { ...this.projectRows(live), bollExpansion: live.bollExpansion }
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

  navigationBars(state, central, end) {
    const before = [], after = [], remaining = LOCAL_HISTORY_BARS - central.length, step = state.intervalMS
    const first = central[0].hour, ceiling = Math.floor(Date.now() / step) * step - step
    let previous = first - step
    const extendBefore = limit => {
      while (before.length < limit && (state.floor === null || previous >= state.floor)) {
        const bar = this.bar(state, previous)
        if (!bar) break
        before.push(bar)
        previous -= step
      }
    }
    // Leave room on both sides so a prefetch response in a new indicator
    // generation still contains the viewport that triggered that request.
    extendBefore(Math.floor(remaining / 2))
    for (let hour = end + step; before.length + after.length < remaining && hour <= ceiling; hour += step) {
      const bar = this.bar(state, hour)
      if (!bar) break
      after.push(bar)
    }
    extendBefore(remaining - after.length)
    return [...before.reverse(), ...central, ...after]
  }

  async prepare(instId, timeframe, targetEnd, historyBars = VISIBLE) {
    if (!['5m', '15m', '1H'].includes(timeframe)) throw new Error('Unsupported chart timeframe.')
    if (targetEnd !== undefined && !Number.isFinite(targetEnd)) throw new Error('Invalid chart window end.')
    if (!Number.isSafeInteger(historyBars) || historyBars < VISIBLE || historyBars > 4_096) throw new Error('Invalid chart history size.')
    if (targetEnd === undefined) {
      const local = await this.local(instId, timeframe)
      if (local) { this.queueRemote(instId, timeframe); return local }
    }
    const state = this.state(instId, timeframe)
    state.active += 1
    this.trim()
    try {
      while (!this.closed) {
        const frame = await this.prepareState(state, targetEnd, { historyBars })
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

  async prepareState(state, targetEnd, { priority = 'prepared', historyBars = VISIBLE } = {}) {
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
    const acquire = async () => {
      const first = Math.max(0, end - (historyBars - 1) * step, state.floor ?? -Infinity)
      // Statistics start their network reads immediately and coordinate their
      // own durable price dependencies. Independent source latency overlaps.
      await Promise.all([
        this.ensurePrices(state, Math.max(0, first - WARMUP * step, state.floor ?? -Infinity), end, priority),
        this.ensureStatistics(state, first, end, priority),
      ])
    }
    await acquire()
    latestEnd = this.latest(state)
    if (state.floor !== null) {
      const clampedEnd = Math.min(latestEnd, Math.max(end, state.floor + (VISIBLE - 1) * step))
      if (clampedEnd !== end) {
        end = clampedEnd
        await acquire()
        latestEnd = this.latest(state)
      }
    }
    const first = end - (VISIBLE - 1) * step
    const available = []
    for (let hour = first; hour <= end; hour += step) {
      if (!state.rows.has(hour) || !Number.isFinite(state.rows.get(hour).baseVolume)) throw new Error('A complete 96-candle source window is not available.')
      available.push(state.rows.get(hour))
    }
    if (!state.loaded) return this.prepareState(state, targetEnd, { priority, historyBars })
    do { await this.indicators(state, priority === 'chartWarm' ? 'background' : 'foreground') }
    while (state.calculatedVersion !== state.priceVersion || state.calculatedLiveVersion !== state.liveVersion)
    if (!state.loaded) return this.prepareState(state, targetEnd, { priority, historyBars })
    const generation = state.generation
    const central = available.map(row => this.bar(state, row.timestamp))
    if (central.some(bar => !bar)) throw new Error('Chart statistics have not completed preparation.')
    for (let hour = Math.max(0, end - (historyBars - 1) * step, state.floor ?? -Infinity); hour < first; hour += step) {
      if (!this.bar(state, hour)) throw new Error('Chart history has not completed preparation.')
    }
    // Include only contiguous, fully observed neighbors. Prepared data may be
    // navigated immediately; unknown source rows never enter the renderer cache.
    const bars = targetEnd === undefined ? central : this.navigationBars(state, central, end)
    const oiState = central.every(bar => bar.oi !== null) ? 'ready' : 'unavailable'
    const takerState = central.every(bar => bar.buy !== null && bar.sell !== null) ? 'ready' : 'unavailable'
    const indicatorState = central.every(bar => indicatorFields.every(field => Number.isFinite(bar[field]))) ? 'ready' : 'unavailable'
    return this.produced(state, { instId, timeframe, intervalMS: step, endHour: end, latestEnd, oldestHour: state.floor,
      historyExhausted: state.floor !== null && bars[0].hour <= state.floor, generation, revision: this.revision(instId),
      bars, oiState, takerState, indicatorState,
      liveBar: targetEnd === undefined && state.live?.timestamp === end + step ? state.indicators.get(state.live.timestamp) : undefined, error: '' })
  }

  async dispose() {
    this.closed = true
    if (this.warmTimer !== null) clearTimeout(this.warmTimer)
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
    this.warmTimer = null
    this.refreshTimer = null
    this.localQueue.clear()
    this.restoreQueue.clear()
    for (const job of this.canonicalQueue) job.reject(new Error('Prepared chart data service is closed.'))
    this.canonicalQueue = []
    this.remoteQueue.clear()
    this.listeners.clear()
    for (const pending of this.calculations.values()) pending.reject(new Error('Prepared chart data service is closed.'))
    this.calculations.clear()
    this.calculationQueue = []
    this.activeCalculation = null
    const worker = this.worker
    this.worker = null
    if (worker) await worker.terminate()
    await Promise.allSettled([this.restoreRunning, this.localRunning, this.remoteRunning, ...this.canonicalTasks, ...this.restoreTasks.values(), ...this.localTasks.values(), ...this.tasks.values(), ...this.liveSeeds.values()].filter(Boolean))
    this.liveStates.clear()
  }
}
