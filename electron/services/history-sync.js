import { createHash } from 'node:crypto'

const intervals = { '5m': 300_000, '15m': 900_000, '1H': 3_600_000 }
const statuses = new Set(['queued', 'running', 'retry', 'paused', 'cancelled', 'completed', 'unavailable'])
const terminal = new Set(['paused', 'cancelled', 'completed', 'unavailable'])
const expirable = new Set(['cancelled', 'completed', 'unavailable'])
const foregroundReady = Symbol('Foreground history is ready for the source lane.')
const foregroundBurst = 8
const targetChanged = Symbol('The rolling history target changed during an asynchronous operation.')
const clone = value => structuredClone(value)
const integer = (value, name, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be a safe integer of at least ${minimum}.`)
  return value
}
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 200 || value.includes('\0')) throw new TypeError(`${name} must be a nonempty string of at most 200 characters without null bytes.`)
  return value
}
const range = (value, intervalMS) => {
  if (!value || typeof value !== 'object') throw new TypeError('A history range is required.')
  const from = integer(value.from, 'from'), through = integer(value.through, 'through')
  if (from > through || from % intervalMS || through % intervalMS) throw new TypeError('History ranges must be ordered and aligned to the timeframe grid.')
  return { from, through }
}
const priority = value => {
  if (value !== 'foreground' && value !== 'background') throw new TypeError('priority must be foreground or background.')
  return value
}
const descriptor = input => {
  if (!input || typeof input !== 'object') throw new TypeError('A history request is required.')
  const instrument = text(input.instrument, 'instrument'), source = text(input.source, 'source')
  if (!Object.hasOwn(intervals, input.timeframe)) throw new TypeError('timeframe must be 5m, 15m, or 1H.')
  return { instrument, source, timeframe: input.timeframe }
}
const exactKey = task => createHash('sha256').update(JSON.stringify([task.instrument, task.timeframe, task.source, task.from, task.through])).digest('hex')
const key = task => task.purpose === 'history' || task.purpose === 'warmup'
  ? `target-${createHash('sha256').update(JSON.stringify([task.instrument, task.timeframe, task.source, task.purpose])).digest('hex')}` : exactKey(task)
const seriesKey = task => JSON.stringify([task.instrument, task.timeframe, task.source])
const clipped = (values, bounds) => values.filter(value => intersects(value, bounds)).map(value => ({ from: Math.max(value.from, bounds.from), through: Math.min(value.through, bounds.through) }))
const merged = (values, intervalMS) => {
  const result = []
  for (const value of [...values].sort((a, b) => a.from - b.from)) {
    const prior = result.at(-1)
    if (prior && value.from <= prior.through + intervalMS) prior.through = Math.max(prior.through, value.through)
    else result.push({ ...value })
  }
  return result
}
const slots = (ranges, intervalMS) => ranges.reduce((total, value) => total + (value.through - value.from) / intervalMS + 1, 0)
const intersects = (left, right) => left.from <= right.through && left.through >= right.from
const subtract = (ranges, exclusions, intervalMS) => exclusions.reduce((remaining, exclusion) => remaining.flatMap(value => {
  if (!intersects(value, exclusion)) return [value]
  const pieces = []
  if (value.from < exclusion.from) pieces.push({ from: value.from, through: exclusion.from - intervalMS })
  if (value.through > exclusion.through) pieces.push({ from: exclusion.through + intervalMS, through: value.through })
  return pieces
}), ranges)

/**
 * A bounded pool shared by background targets and foreground repairs, with
 * one active page per source and fair rotation between pages.
 * SQLite stores coordination only; every coverage decision is read from the
 * injected Parquet store, including after a crash between write and checkpoint.
 */
export class HistorySync {
  constructor(options) {
    if (!options || typeof options !== 'object') throw new TypeError('HistorySync options are required.')
    const { metadata, store, sources, write, onProgress, onError, now = Date.now } = options
    for (const name of ['putSyncTask', 'getSyncTask', 'listSyncTasks', 'deleteSyncTask']) {
      if (typeof metadata?.[name] !== 'function') throw new TypeError(`metadata.${name} is required.`)
    }
    if (typeof store?.missingCandleRanges !== 'function') throw new TypeError('store.missingCandleRanges is required.')
    if (write !== undefined && typeof write !== 'function') throw new TypeError('write must be a function.')
    if (!write && typeof store?.appendCandles !== 'function') throw new TypeError('store.appendCandles or write is required.')
    if (!sources || typeof sources !== 'object' || !Object.keys(sources).length) throw new TypeError('At least one history source is required.')
    for (const [name, source] of Object.entries(sources)) {
      text(name, 'source')
      if (typeof source?.fetchGap !== 'function' || (source.inspect !== undefined && typeof source.inspect !== 'function')) throw new TypeError(`Invalid history source: ${name}.`)
    }
    for (const [name, callback] of Object.entries({ now, onProgress, onError })) {
      if (callback !== undefined && typeof callback !== 'function') throw new TypeError(`${name} must be a function.`)
    }
    this.metadata = metadata
    this.store = store
    this.sources = new Map(Object.entries(sources))
    this.write = write ?? ((records, task) => store.appendCandles(records, task.priority))
    this.onProgress = onProgress
    this.onError = onError
    this.now = now
    this.maxConcurrentTasks = integer(options.maxConcurrentTasks ?? 1, 'maxConcurrentTasks', 1)
    this.minRequestIntervalMS = integer(options.minRequestIntervalMS ?? 125, 'minRequestIntervalMS')
    this.retryBaseMS = integer(options.retryBaseMS ?? 1_000, 'retryBaseMS', 1)
    this.maxRetryDelayMS = integer(options.maxRetryDelayMS ?? 300_000, 'maxRetryDelayMS', this.retryBaseMS)
    this.maxAttempts = integer(options.maxAttempts ?? 5, 'maxAttempts', 1)
    this.maxRetainedTerminalTasks = integer(options.maxRetainedTerminalTasks ?? 512, 'maxRetainedTerminalTasks', 1)
    if (this.minRequestIntervalMS > 2_147_483_647 || this.maxRetryDelayMS > 2_147_483_647) throw new TypeError('History delays cannot exceed 2147483647 milliseconds.')
    this.tasks = new Map()
    this.waiters = new Map()
    this.idleWaiters = []
    this.started = null
    this.closed = false
    this.closing = null
    this.draining = null
    this.timer = null
    this.active = new Map()
    this.foregroundPages = new Map()
    this.targetAdmissions = new Map()
    this.rollingAdmissions = new Map()
    this.wakeDrain = null
    this.lastRequestAt = null
    this.requestTail = Promise.resolve()
    this.persistTail = Promise.resolve()
    this.pendingCheckpoints = null
    this.progressStatuses = new Map()
    this.progressByTimeframe = new Map()
    this.fatalError = null
    // Process-local verification only. Restart always asks durable storage again.
    this.coverageChecks = new Map()
    this.coverageEpochs = new Map()
    this.targetGenerations = new Map()
  }

  start() {
    if (this.closed) return Promise.reject(new Error('HistorySync is closed.'))
    if (!this.started) this.started = this.restore().then(() => { this.kick(); return this })
    return this.started
  }

  async restore() {
    const tasks = await this.metadata.listSyncTasks()
    if (!Array.isArray(tasks)) throw new TypeError('metadata.listSyncTasks must return an array.')
    const obsolete = [], restoredIntent = new Map()
    for (const saved of tasks) {
      const task = clone(saved)
      descriptor(task)
      range(task, intervals[task.timeframe])
      text(task.id, 'task.id')
      priority(task.priority)
      if (task.schemaVersion !== 1 || !['requested', 'history', 'warmup'].includes(task.purpose)) throw new TypeError('Invalid persisted history schema or purpose.')
      if (!statuses.has(task.status)) throw new TypeError(`Invalid persisted history status: ${task.status}.`)
      integer(task.createdAt, 'createdAt')
      integer(task.updatedAt, 'updatedAt')
      integer(task.attempts, 'attempts')
      integer(task.writtenRecords, 'writtenRecords')
      if (typeof task.inspected !== 'boolean' || (task.lastError !== null && typeof task.lastError !== 'string')) throw new TypeError('Invalid persisted history progress.')
      if (!this.sources.has(task.source)) throw new TypeError(`History source is unavailable: ${task.source}.`)
      if (task.nextAttemptAt !== null) integer(task.nextAttemptAt, 'nextAttemptAt')
      this.validateCursor(task.cursor)
      if (!Array.isArray(task.unavailableRanges) || !Array.isArray(task.remaining)) throw new TypeError('Invalid persisted history ranges.')
      task.unavailableRanges = this.unavailable(task, { unavailable: task.unavailableRanges })
      for (const bounds of [...task.remaining, ...(task.cursorRange == null ? [] : [task.cursorRange])]) {
        range(bounds, intervals[task.timeframe])
        if (bounds.from < task.from || bounds.through > task.through) throw new TypeError('Persisted progress is outside its history target.')
      }
      // Old foreground range checkpoints are accepted exact consumers; only
      // background goals migrate to stable rolling identities.
      if (task.priority === 'foreground' && task.purpose !== 'requested' && task.id === exactKey(task)) task.purpose = 'requested'
      const canonicalID = key(task)
      if (task.id !== canonicalID && task.id !== exactKey(task)) throw new TypeError('Persisted history task ID does not match its target.')
      if (task.id !== canonicalID) obsolete.push(task.id)
      const existing = this.tasks.get(canonicalID)
      // Replace the old range-keyed rolling queue with the latest desired
      // window. These are coordination rows, never market observations.
      const intent = { canonical: task.id === canonicalID, requestedAt: task.targetRequestedAt ?? task.createdAt }
      if (task.targetRequestedAt !== undefined) integer(task.targetRequestedAt, 'targetRequestedAt')
      if (existing && task.purpose !== 'requested') {
        const previous = restoredIntent.get(canonicalID)
        if (Number(intent.canonical) < Number(previous.canonical) || intent.canonical === previous.canonical
          && (intent.requestedAt < previous.requestedAt || intent.requestedAt === previous.requestedAt && task.through < existing.through)) continue
      } else if (existing) throw new TypeError('Duplicate persisted history task ID.')
      restoredIntent.set(canonicalID, intent)
      delete task.targetRequestedAt
      task.id = canonicalID
      this.tasks.set(task.id, task)
      if (task.status === 'running') {
        task.status = 'queued'
        task.nextAttemptAt = null
        if (task.purpose === 'requested') await this.save(task)
      }
    }
    // Publish canonical targets before deleting obsolete checkpoints, so an
    // interrupted cleanup is safe to run again on the next launch.
    for (const task of this.tasks.values()) this.updateProgress(task)
    const targets = [...this.tasks.values()].filter(task => task.purpose !== 'requested')
    if (targets.length) {
      if (this.metadata.putSyncTasks) await this.metadata.putSyncTasks(targets.map(clone))
      else for (const task of targets) await this.save(task)
    }
    if (obsolete.length) {
      if (this.metadata.deleteSyncTasks) await this.metadata.deleteSyncTasks(obsolete)
      else for (const id of obsolete) await this.metadata.deleteSyncTask(id)
    }
    await this.pruneTerminalTasks()
  }

  admit(admissions, identity, operation) {
    const admission = (admissions.get(identity) ?? Promise.resolve()).then(operation)
    const tail = admission.catch(() => undefined)
    admissions.set(identity, tail)
    void tail.then(() => { if (admissions.get(identity) === tail) admissions.delete(identity) })
    return admission
  }

  async enqueue(input) {
    if (input?.purpose === 'history' || input?.purpose === 'warmup') {
      const identity = descriptor(input)
      await this.start()
      return this.admit(this.rollingAdmissions, key({ ...identity, purpose: input.purpose }), () => this.enqueueRequest(input))
    }
    return this.enqueueRequest(input)
  }

  async enqueueRequest(input) {
    await this.start()
    this.assertOpen()
    const identity = descriptor(input)
    if (!this.sources.has(identity.source)) throw new TypeError(`History source is unavailable: ${identity.source}.`)
    const bounds = range(input, intervals[identity.timeframe])
    const requestedPriority = priority(input.priority ?? 'background')
    const purpose = input.purpose ?? 'requested'
    if (!['requested', 'history', 'warmup'].includes(purpose)) throw new TypeError('Invalid history purpose.')
    const id = key({ ...identity, ...bounds, purpose })
    let task = this.tasks.get(id)
    if (task) {
      const changedRange = task.from !== bounds.from || task.through !== bounds.through
      const promoted = requestedPriority === 'foreground' && task.priority !== 'foreground'
      if (promoted) task.priority = 'foreground'
      if (changedRange) {
        this.targetGenerations.set(id, (this.targetGenerations.get(id) ?? 0) + 1)
        Object.assign(task, bounds)
        // The replacement window has not been verified yet. Persist its full
        // bounds conservatively; the process-local cache will refine them.
        task.remaining = [{ ...bounds }]
        task.unavailableRanges = []
        task.inspected = false
        task.cursor = null
        task.cursorRange = null
      }
      // A recurring target must not undo the user's pause or cancellation.
      if (purpose !== 'requested' && ['paused', 'cancelled'].includes(task.status)) {
        if (changedRange || promoted) await this.save(task)
        return clone(task)
      }
      if (['completed', 'unavailable'].includes(task.status)) {
        // Unversioned adapters cannot prove that storage stayed unchanged.
        if (!this.store.coverageVersion) this.coverageChecks.delete(id)
        const gaps = await this.missing(task)
        if (!gaps.length) {
          const nextStatus = task.remaining.length ? 'unavailable' : 'completed'
          const changedStatus = task.status !== nextStatus
          task.status = nextStatus
          if (changedRange || promoted || changedStatus) await this.save(task, changedStatus)
          return clone(task)
        }
      }
      if (['paused', 'cancelled', 'completed', 'unavailable'].includes(task.status)) {
        task.status = 'queued'
        task.attempts = 0
        task.nextAttemptAt = null
        task.lastError = null
      } else if (!changedRange && !promoted) return clone(task)
      await this.save(task)
    } else {
      const timestamp = this.timestamp()
      task = { schemaVersion: 1, id, ...identity, ...bounds, purpose, priority: requestedPriority, status: 'queued',
        createdAt: timestamp, updatedAt: timestamp, nextAttemptAt: null, attempts: 0, cursor: null,
        cursorRange: null, unavailableRanges: [], remaining: [bounds], writtenRecords: 0, inspected: false, lastError: null }
      this.tasks.set(id, task)
      await this.save(task)
    }
    this.kick()
    return clone(task)
  }

  async enqueueTarget(input) {
    const identity = descriptor(input)
    const intervalMS = intervals[identity.timeframe]
    const historyDays = integer(input.historyDays ?? 30, 'historyDays', 1)
    if (historyDays > 3650) throw new TypeError('historyDays cannot exceed 3650.')
    const warmupCandles = integer(input.warmupCandles ?? 200, 'warmupCandles')
    if (warmupCandles > 100_000) throw new TypeError('warmupCandles cannot exceed 100000.')
    const asOf = integer(input.asOf ?? this.timestamp(), 'asOf', intervalMS)
    const through = Math.floor(asOf / intervalMS) * intervalMS - intervalMS
    const from = Math.max(0, through - historyDays * 86_400_000 + intervalMS)
    await this.start()
    // Only admissions for this source/series serialize. Independent targets
    // still checkpoint together, and no range-keyed cancellation layer remains.
    return this.admit(this.targetAdmissions, seriesKey(identity), async () => {
      this.assertOpen()
      const history = await this.enqueue({ ...identity, from, through, priority: input.priority, purpose: 'history' })
      const warmup = warmupCandles && from >= intervalMS
        ? await this.enqueue({ ...identity, from: Math.max(0, from - warmupCandles * intervalMS), through: from - intervalMS, priority: input.priority, purpose: 'warmup' }) : null
      if (!warmup) {
        const previous = this.tasks.get(key({ ...identity, purpose: 'warmup' }))
        if (previous && previous.priority === 'background' && !this.waiters.has(previous.id)
          && !['completed', 'unavailable', 'cancelled'].includes(previous.status)) await this.cancel(previous.id)
      }
      return { history, warmup }
    })
  }

  getTask(id) {
    const task = this.tasks.get(text(id, 'task ID'))
    return task ? clone(task) : null
  }

  listTasks() { return [...this.tasks.values()].map(clone) }

  progressFor(instIds, timeframe) {
    const statuses = this.progressByTimeframe.get(timeframe)
    let retrying = 0, unavailable = 0
    for (const instId of new Set(instIds)) {
      const counts = statuses?.get(instId)
      if (counts?.retrying) retrying++
      if (counts?.unavailable) unavailable++
    }
    return { retrying, unavailable }
  }

  updateProgress(task, remove = false) {
    const previous = this.progressStatuses.get(task.id)
    const category = task.status === 'retry' ? 'retrying' : ['paused', 'unavailable'].includes(task.status) ? 'unavailable' : null
    if (!remove && previous?.category === category && previous.instrument === task.instrument && previous.timeframe === task.timeframe) return
    if (previous) {
      const instruments = this.progressByTimeframe.get(previous.timeframe), counts = instruments?.get(previous.instrument)
      if (counts) {
        counts[previous.category]--
        if (!counts.retrying && !counts.unavailable) instruments.delete(previous.instrument)
        if (!instruments.size) this.progressByTimeframe.delete(previous.timeframe)
      }
      this.progressStatuses.delete(task.id)
    }
    if (remove || !category) return
    const instruments = this.progressByTimeframe.get(task.timeframe) ?? new Map()
    const counts = instruments.get(task.instrument) ?? { retrying: 0, unavailable: 0 }
    counts[category]++
    instruments.set(task.instrument, counts)
    this.progressByTimeframe.set(task.timeframe, instruments)
    this.progressStatuses.set(task.id, { instrument: task.instrument, timeframe: task.timeframe, category })
  }

  async pause(id) { return this.control(id, 'paused') }
  async cancel(id) { return this.control(id, 'cancelled') }

  async control(id, status) {
    await this.start()
    this.assertOpen()
    const task = this.requireTask(id)
    task.status = status
    task.nextAttemptAt = null
    const active = this.active.get(task.source)
    if (active?.id === task.id) active.controller.abort()
    await this.save(task)
    this.settle(task)
    await this.pruneTerminalTasks()
    this.kick()
    return clone(task)
  }

  async resume(id) {
    await this.start()
    this.assertOpen()
    const task = this.requireTask(id)
    if (task.status === 'running') return clone(task)
    this.coverageChecks.delete(task.id)
    if (task.status === 'unavailable') {
      task.unavailableRanges = []
      task.inspected = false
    }
    task.status = 'queued'
    task.nextAttemptAt = null
    task.attempts = 0
    task.lastError = null
    await this.save(task)
    this.kick()
    return clone(task)
  }

  async waitFor(id) {
    await this.start()
    this.assertOpen()
    const task = this.requireTask(id)
    if (terminal.has(task.status)) return clone(task)
    return new Promise((resolve, reject) => {
      const listeners = this.waiters.get(id) ?? []
      listeners.push({ resolve, reject })
      this.waiters.set(id, listeners)
    })
  }

  async whenIdle() {
    await this.start()
    this.assertOpen()
    if (this.isIdle()) return
    return new Promise((resolve, reject) => this.idleWaiters.push({ resolve, reject }))
  }

  assertOpen() {
    if (this.closed) throw new Error('HistorySync is closed.')
    if (this.fatalError) throw this.fatalError
  }

  requireTask(id) {
    const task = this.tasks.get(text(id, 'task ID'))
    if (!task) throw new Error(`Unknown history task: ${id}.`)
    return task
  }

  timestamp() { return integer(this.now(), 'now()') }

  save(task, notify = true) {
    task.updatedAt = this.timestamp()
    this.updateProgress(task)
    const snapshot = clone(task)
    let batch = this.pendingCheckpoints
    if (!batch) {
      batch = { entries: new Map() }
      this.pendingCheckpoints = batch
      // The predecessor preserves ordering with cleanup/deletion. Starting on
      // a microtask coalesces simultaneous source state changes into one WAL
      // transaction; each caller still waits for the durable batch commit.
      const persistence = this.persistTail.then(async () => {
        if (this.pendingCheckpoints === batch) this.pendingCheckpoints = null
        const entries = [...batch.entries.values()]
        try {
          const snapshots = entries.map(entry => entry.snapshot)
          if (this.metadata.putSyncTasks) await this.metadata.putSyncTasks(snapshots)
          else for (const value of snapshots) await this.metadata.putSyncTask(value)
          for (const entry of entries) {
            try { if (entry.notify) Promise.resolve(this.onProgress?.(clone(entry.snapshot))).catch(() => undefined) } catch { /* Observers cannot interrupt synchronization. */ }
            entry.waiters.forEach(waiter => waiter.resolve())
          }
        } catch (error) {
          entries.forEach(entry => entry.waiters.forEach(waiter => waiter.reject(error)))
          this.fail(error)
          throw error
        }
      })
      this.persistTail = persistence.catch(() => undefined)
    }
    const existing = batch.entries.get(task.id)
    const entry = { snapshot, notify: notify || existing?.notify, waiters: existing?.waiters ?? [] }
    batch.entries.set(task.id, entry)
    return new Promise((resolve, reject) => entry.waiters.push({ resolve, reject }))
  }

  pruneTerminalTasks() {
    // Coordination checkpoints are not historical market data. Retain a
    // bounded recent result history; Parquet remains the coverage authority
    // when an expired target is requested again.
    const persistence = this.persistTail.then(async () => {
      const candidates = [...this.tasks.values()].reverse().filter(task => task.purpose === 'requested' && expirable.has(task.status)
        && task.id !== this.active.get(task.source)?.id && !this.waiters.has(task.id))
        .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      const removed = []
      for (const task of candidates.slice(this.maxRetainedTerminalTasks)) {
        if (this.tasks.get(task.id) !== task || !expirable.has(task.status)
          || task.id === this.active.get(task.source)?.id || this.waiters.has(task.id)) continue
        // A later enqueue creates a fresh task and queues its save after this
        // deletion transaction, even when its exact identity is reused.
        this.tasks.delete(task.id)
        this.coverageChecks.delete(task.id)
        this.updateProgress(task, true)
        removed.push(task)
      }
      if (!removed.length) return
      try {
        if (this.metadata.deleteSyncTasks) await this.metadata.deleteSyncTasks(removed.map(task => task.id))
        else for (const task of removed) await this.metadata.deleteSyncTask(task.id)
      } catch (error) {
        for (const task of removed) if (!this.tasks.has(task.id)) { this.tasks.set(task.id, task); this.updateProgress(task) }
        throw error
      }
    })
    this.persistTail = persistence.catch(() => undefined)
    return persistence
  }

  validateCursor(cursor) {
    if (cursor !== null && typeof cursor !== 'string' && !(typeof cursor === 'number' && Number.isFinite(cursor))) throw new TypeError('A history cursor must be a string, finite number, or null.')
  }

  unavailable(task, result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('Source inspection must return an object.')
    const intervalMS = intervals[task.timeframe]
    const unavailable = result.unavailable ?? []
    if (!Array.isArray(unavailable)) throw new TypeError('Source unavailable ranges must be an array.')
    const values = unavailable.map(value => ({ ...range(value, intervalMS), reason: text(value.reason, 'unavailable reason') }))
    if (result.availableFrom !== undefined) {
      const first = Math.ceil(integer(result.availableFrom, 'availableFrom') / intervalMS) * intervalMS
      if (first > task.from) values.push({ from: task.from, through: first - intervalMS, reason: result.reason ?? 'Before the source history boundary.' })
    }
    if (result.availableThrough !== undefined) {
      const last = Math.floor(integer(result.availableThrough, 'availableThrough') / intervalMS) * intervalMS
      if (last < task.through) values.push({ from: last + intervalMS, through: task.through, reason: result.reason ?? 'After the source history boundary.' })
    }
    return values.filter(value => intersects(value, task)).map(value => ({
      from: Math.max(value.from, task.from), through: Math.min(value.through, task.through), reason: text(value.reason, 'unavailable reason'),
    }))
  }

  /** Invalidate explicit observations (latest REST seeds and repairs) even
   * when they have not produced a storage mutation yet. */
  invalidate(query) {
    const key = seriesKey(query)
    this.coverageEpochs.set(key, (this.coverageEpochs.get(key) ?? 0) + 1)
    for (const [id, check] of this.coverageChecks) {
      const task = this.tasks.get(id)
      if (task && seriesKey(task) === seriesKey(query) && intersects(check, query)) {
        check.dirty = merged([...check.dirty, ...clipped([query], check)], intervals[task.timeframe])
      }
    }
  }

  async missing(task) {
    const intervalMS = intervals[task.timeframe]
    const query = { instrument: task.instrument, timeframe: task.timeframe, source: task.source, from: task.from, through: task.through, intervalMS }
    const epoch = this.coverageEpochs.get(seriesKey(query)) ?? 0
    const version = await this.store.coverageVersion?.(query)
    const previous = this.coverageChecks.get(task.id)
    let refresh = [query], missing = [], expiresAt = null
    if (previous) {
      missing = clipped(previous.remaining, query)
      expiresAt = previous.expiresAt
      refresh = [...subtract([query], [previous], intervalMS), ...clipped(previous.dirty, query)]
      if (previous.expiresAt !== null && previous.expiresAt <= this.timestamp()) refresh = [query]
      else if (previous.version !== version) {
        const changes = await this.store.coverageChanges?.(query, previous.version)
        refresh.push(...(changes?.ranges === null || !changes ? [query] : clipped(changes.ranges, query)))
      }
    }
    refresh = merged(refresh, intervalMS)
    // Lease expiry is recomputed by the authoritative full check. Partial
    // refreshes conservatively retain the earliest existing lease.
    if (refresh.length === 1 && refresh[0].from === query.from && refresh[0].through === query.through) expiresAt = null
    for (const bounds of refresh) {
      const values = await this.store.missingCandleRanges({ ...query, ...bounds }, task.priority)
      if (!Array.isArray(values)) throw new TypeError('store.missingCandleRanges must return an array.')
      const sorted = values.map(value => range(value, intervalMS)).sort((a, b) => a.from - b.from)
      let prior = null
      for (const value of sorted) {
        if (value.from < bounds.from || value.through > bounds.through || prior && value.from <= prior.through) throw new TypeError('Store gaps must be disjoint and inside the requested range.')
        prior = value
      }
      missing = merged([...subtract(missing, [bounds], intervalMS), ...sorted], intervalMS)
      const expiry = this.store.coverageExpiry?.({ ...query, ...bounds })
      if (expiry != null) expiresAt = Math.min(expiresAt ?? Infinity, expiry)
    }
    // Keep the revision from before the reads: a racing mutation is checked
    // again through the bounded change journal, never blessed by a stale read.
    const check = { from: query.from, through: query.through, version, expiresAt, remaining: missing, dirty: [] }
    this.coverageChecks.set(task.id, check)
    if (epoch !== (this.coverageEpochs.get(seriesKey(query)) ?? 0)) check.dirty = [query]
    if (check.dirty.length || query.from !== task.from || query.through !== task.through) return this.missing(task)
    task.remaining = missing
    return subtract(missing, task.unavailableRanges, intervalMS)
  }

  kick() {
    if (this.closed || this.fatalError) return
    clearTimeout(this.timer)
    this.timer = null
    if (this.draining) { this.wakeDrain?.(); return }
    const ready = [...this.tasks.values()].some(task => task.status === 'queued' || (task.status === 'retry' && task.nextAttemptAt <= this.timestamp()))
    if (ready) {
      // Deferring one turn admits simultaneous requests before the first fetch.
      this.timer = setTimeout(() => {
        this.timer = null
        this.draining = this.drain().catch(error => this.fail(error)).finally(() => {
          this.draining = null
          this.kick()
          this.settleIdle()
        })
      }, 0)
    } else {
      const deadlines = [...this.tasks.values()].filter(task => task.status === 'retry').map(task => task.nextAttemptAt)
      if (deadlines.length) this.timer = setTimeout(() => this.kick(), Math.min(2_147_483_647, Math.max(1, Math.min(...deadlines) - this.timestamp())))
      this.settleIdle()
    }
  }

  async drain() {
    try {
      while (!this.closed && !this.fatalError) {
        const timestamp = this.timestamp()
        const ready = [...this.tasks.values()].filter(task => !this.active.has(task.source)
          && (task.status === 'queued' || (task.status === 'retry' && task.nextAttemptAt <= timestamp)))
          .sort((a, b) => this.admissionPriority(b) - this.admissionPriority(a))
        for (const task of ready) {
          if (this.active.size >= this.maxConcurrentTasks) break
          if (this.active.has(task.source)) continue
          const entry = { id: task.id, controller: new AbortController(), promise: null,
            backgroundTurn: task.priority === 'background' && this.admissionPriority(task) === 2, yielded: false }
          this.active.set(task.source, entry)
          entry.promise = this.run(task, entry.controller).catch(error => this.fail(error)).finally(() => {
            this.settle(task)
            this.active.delete(task.source)
            if (!entry.yielded) this.foregroundPages.set(task.source, task.priority === 'foreground'
              ? Math.min(foregroundBurst, (this.foregroundPages.get(task.source) ?? 0) + 1) : 0)
            // Move the just-served target behind its peers even when every
            // page has the same createdAt or the target spans thirty days.
            this.tasks.delete(task.id)
            this.tasks.set(task.id, task)
          })
        }
        if (!this.active.size) break
        // Enqueue must wake this race: an active stats page may be awaiting a
        // candle task that was added after the other sources began fetching.
        let wake
        const changed = new Promise(resolve => { wake = resolve; this.wakeDrain = resolve })
        const retries = [...this.tasks.values()].filter(task => task.status === 'retry' && !this.active.has(task.source))
        const deadline = this.active.size < this.maxConcurrentTasks && retries.length
          ? setTimeout(wake, Math.min(2_147_483_647, Math.max(1, Math.min(...retries.map(task => task.nextAttemptAt)) - this.timestamp()))) : null
        try { await Promise.race([changed, ...[...this.active.values()].map(entry => entry.promise)]) }
        finally { clearTimeout(deadline); this.wakeDrain = null }
        await this.pruneTerminalTasks()
      }
    } catch (error) {
      this.fail(error)
    } finally {
      // Closing/fatal errors stop admission but never abandon accepted writes.
      await Promise.all([...this.active.values()].map(entry => entry.promise))
      await this.pruneTerminalTasks()
    }
  }

  admissionPriority(task) {
    // Eight foreground pages buy one bounded background turn on that source.
    return task.priority === 'foreground' ? 1 : (this.foregroundPages.get(task.source) ?? 0) >= foregroundBurst ? 2 : 0
  }

  async callSource(operation, signal, task) {
    let response
    const admission = this.requestTail.then(async () => {
      while (this.lastRequestAt !== null) {
        const remaining = this.lastRequestAt + this.minRequestIntervalMS - this.timestamp()
        if (remaining <= 0) break
        await this.delay(remaining, signal)
      }
      signal.throwIfAborted()
      // Foreground repairs preempt their own source only. Other active sources
      // may depend on this background page, so cross-source yielding can starve.
      if (task.priority === 'background' && !this.active.get(task.source)?.backgroundTurn
        && [...this.tasks.values()].some(value => value.source === task.source && value.priority === 'foreground'
        && (value.status === 'queued' || (value.status === 'retry' && value.nextAttemptAt <= this.timestamp())))) throw foregroundReady
      // Record after synchronous admission so a CPU pause before the source
      // starts cannot shorten the interval before the next request. HTTP
      // completion remains independent of this start-only lane.
      try { response = operation() }
      finally { this.lastRequestAt = this.timestamp() }
    })
    // Serialize starts, never HTTP completion or a source's dependency wait.
    this.requestTail = admission.catch(() => undefined)
    await admission
    return response
  }

  delay(milliseconds, signal) {
    signal.throwIfAborted()
    if (!milliseconds) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', abort); resolve() }
      const timer = setTimeout(finish, milliseconds)
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  async run(task, controller) {
    const { signal } = controller
    task.status = 'running'
    task.nextAttemptAt = null
    await this.save(task)
    const generation = this.targetGenerations.get(task.id) ?? 0
    const changed = () => generation !== (this.targetGenerations.get(task.id) ?? 0)
    const requireCurrent = () => { if (changed()) throw targetChanged }
    try {
      let gaps = await this.missing(task)
      signal.throwIfAborted()
      requireCurrent()
      const source = this.sources.get(task.source)
      if (gaps.length && source.inspect && !task.inspected) {
        const inspectedTarget = clone(task)
        const inspection = await this.callSource(() => source.inspect({ instrument: inspectedTarget.instrument, timeframe: inspectedTarget.timeframe, source: inspectedTarget.source, priority: inspectedTarget.priority, from: inspectedTarget.from, through: inspectedTarget.through, signal, cursor: inspectedTarget.cursor }), signal, task)
        signal.throwIfAborted()
        requireCurrent()
        task.unavailableRanges.push(...this.unavailable(inspectedTarget, inspection))
        task.inspected = true
        gaps = await this.missing(task)
        signal.throwIfAborted()
        requireCurrent()
        await this.save(task)
        requireCurrent()
      }
      if (!gaps.length) return await this.finish(task)
      const intervalMS = intervals[task.timeframe]
      const gap = gaps.find(value => task.cursorRange && intersects(value, task.cursorRange)) ?? gaps[0]
      if (!task.cursorRange || gap.from !== task.cursorRange.from || gap.through !== task.cursorRange.through) {
        task.cursor = null
        task.cursorRange = clone(gap)
      }
      const pageTarget = clone(task)
      const response = await this.callSource(() => source.fetchGap({ instrument: pageTarget.instrument, timeframe: pageTarget.timeframe, source: pageTarget.source, priority: pageTarget.priority, ...gap, cursor: pageTarget.cursor, signal }), signal, task)
      signal.throwIfAborted()
      const result = Array.isArray(response) ? { records: response } : response
      if (!result || !Array.isArray(result.records)) throw new TypeError('fetchGap must return records or an object containing records.')
      const records = result.records.filter(record => {
        if (!record || record.instrument !== task.instrument || record.timeframe !== task.timeframe || record.confirmed !== true) throw new TypeError('History sources must return confirmed records for the requested instrument and timeframe.')
        integer(record.timestamp, 'record.timestamp')
        if (record.timestamp % intervalMS) throw new TypeError('History source records must follow the timeframe grid.')
        return record.timestamp >= gap.from && record.timestamp <= gap.through
      })
      if (records.length) {
        await this.write(records, pageTarget)
        this.invalidate({ ...pageTarget, from: Math.min(...records.map(record => record.timestamp)), through: Math.max(...records.map(record => record.timestamp)) })
        task.writtenRecords += records.length
      }
      // A cancelled request cannot publish a cursor or completion state. Any
      // already admitted Parquet write is recovered by the next coverage read.
      signal.throwIfAborted()
      // The old page remains valid market data, but its availability bounds,
      // cursor, and completion apply only to the target that requested it.
      requireCurrent()
      if (result.unavailable !== undefined) task.unavailableRanges.push(...this.unavailable({ ...task, ...gap }, result))
      const after = await this.missing(task)
      signal.throwIfAborted()
      requireCurrent()
      if (Object.hasOwn(result, 'cursor')) {
        this.validateCursor(result.cursor)
        task.cursor = result.cursor
      } else task.cursor = null
      task.cursorRange = clone(after.find(value => intersects(value, gap)) ?? null)
      if (!task.cursorRange) task.cursor = null
      if (!after.length) return await this.finish(task)
      if (slots(clipped(after, gap), intervalMS) >= slots(clipped(gaps, gap), intervalMS)) throw new Error('The history source made no persisted coverage progress.')
      task.attempts = 0
      task.lastError = null
      task.status = 'queued'
      await this.save(task)
    } catch (error) {
      if (signal.aborted || error === foregroundReady || error === targetChanged || changed()) {
        if (error === foregroundReady) this.active.get(task.source).yielded = true
        if (task.status === 'running') {
          task.status = 'queued'
          await this.save(task)
        }
      } else {
        task.attempts += 1
        task.lastError = error instanceof Error ? error.message : String(error)
        if (task.attempts >= this.maxAttempts) {
          task.status = 'paused'
          task.nextAttemptAt = null
        } else {
          task.status = 'retry'
          const delay = Math.min(this.maxRetryDelayMS, this.retryBaseMS * 2 ** Math.min(30, task.attempts - 1))
          task.nextAttemptAt = this.timestamp() + delay
        }
        await this.save(task)
        try { Promise.resolve(this.onError?.(error, clone(task))).catch(() => undefined) } catch { /* Observers cannot interrupt synchronization. */ }
      }
    }
  }

  async finish(task) {
    const checked = this.coverageChecks.get(task.id)
    if (!checked || checked.from !== task.from || checked.through !== task.through || checked.dirty.length) {
      task.status = 'queued'
      await this.save(task)
      return
    }
    task.status = task.remaining.length ? 'unavailable' : 'completed'
    task.cursor = null
    task.cursorRange = null
    task.attempts = 0
    task.nextAttemptAt = null
    task.lastError = null
    await this.save(task)
  }

  settle(task) {
    if (!terminal.has(task.status)) return
    const waiters = this.waiters.get(task.id) ?? []
    this.waiters.delete(task.id)
    waiters.forEach(waiter => waiter.resolve(clone(task)))
  }

  isIdle() { return !this.draining && !this.active.size && ![...this.tasks.values()].some(task => ['queued', 'running', 'retry'].includes(task.status)) }

  settleIdle() {
    if (!this.isIdle()) return
    this.idleWaiters.splice(0).forEach(waiter => waiter.resolve())
  }

  fail(error) {
    this.fatalError = error
    this.active.forEach(entry => entry.controller.abort())
    this.waiters.forEach(waiters => waiters.forEach(waiter => waiter.reject(error)))
    this.waiters.clear()
    this.idleWaiters.splice(0).forEach(waiter => waiter.reject(error))
    try { Promise.resolve(this.onError?.(error)).catch(() => undefined) } catch { /* The persistence error remains available to callers. */ }
  }

  close() {
    if (this.closing) return this.closing
    this.closed = true
    clearTimeout(this.timer)
    this.timer = null
    this.active.forEach(entry => entry.controller.abort())
    this.wakeDrain?.()
    // Active sources can be awaiting waitFor() on another source. Release
    // those dependencies before joining workers, including queued work whose
    // fetch will never start after close. Accepted writes still drain below.
    const error = new Error('HistorySync is closed.')
    this.waiters.forEach(waiters => waiters.forEach(waiter => waiter.reject(error)))
    this.waiters.clear()
    this.idleWaiters.splice(0).forEach(waiter => waiter.reject(error))
    this.closing = (async () => {
      await this.started?.catch(() => undefined)
      await Promise.all([...this.targetAdmissions.values(), ...this.rollingAdmissions.values()])
      await this.draining
      await this.persistTail
    })()
    return this.closing
  }
}
