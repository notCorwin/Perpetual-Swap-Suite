import { randomUUID } from 'node:crypto'

const intervals = { '5m': 300_000, '15m': 900_000, '1H': 3_600_000 }
const terminal = new Set(['paused', 'cancelled', 'completed', 'unavailable'])
const priorities = { interactive: 4, foreground: 4, prepared: 4, repair: 4, continuity: 3, statistics: 3, prefetch: 1, chartWarm: 1, background: 0 }
const clone = value => structuredClone(value)
const integer = (value, name, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be a safe integer of at least ${minimum}.`)
  return value
}
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) throw new TypeError(`${name} must be a nonempty string of at most 200 characters without null bytes.`)
  return value
}
const range = (value, step) => {
  const from = integer(value?.from, 'from'), through = integer(value?.through, 'through')
  if (from > through || from % step || through % step) throw new TypeError('History ranges must be ordered and aligned to the timeframe grid.')
  return { from, through }
}
const descriptor = value => {
  if (!Object.hasOwn(intervals, value?.timeframe)) throw new TypeError('timeframe must be 5m, 15m, or 1H.')
  return { instrument: text(value.instrument, 'instrument'), timeframe: value.timeframe, source: text(value.source, 'source') }
}
const priority = value => {
  if (!Object.hasOwn(priorities, value)) throw new TypeError('Invalid history priority.')
  return value
}
const seriesKey = value => JSON.stringify([value.instrument, value.timeframe, value.source])
const intersects = (a, b) => a.from <= b.through && a.through >= b.from
const clipped = (values, bounds) => values.filter(value => intersects(value, bounds)).map(value => ({ ...value, from: Math.max(value.from, bounds.from), through: Math.min(value.through, bounds.through) }))
const merged = (values, step) => {
  const result = []
  for (const value of [...values].sort((a, b) => a.from - b.from)) {
    const previous = result.at(-1)
    if (previous && value.from <= previous.through + step) previous.through = Math.max(previous.through, value.through)
    else result.push({ from: value.from, through: value.through })
  }
  return result
}
const subtract = (values, exclusions, step) => exclusions.reduce((remaining, exclusion) => remaining.flatMap(value => {
  if (!intersects(value, exclusion)) return [value]
  return [...(value.from < exclusion.from ? [{ ...value, through: exclusion.from - step }] : []),
    ...(value.through > exclusion.through ? [{ ...value, from: exclusion.through + step }] : [])]
}), values)
const slots = (values, step) => values.reduce((total, value) => total + (value.through - value.from) / step + 1, 0)

/** Finite process-local consumers share durable source coverage and one in-flight page per series/source. */
export class HistorySync {
  constructor(options) {
    const { metadata, store, sources, write, onProgress, onError, now = Date.now } = options ?? {}
    for (const name of ['listSyncTasks', 'deleteSyncTask']) if (typeof metadata?.[name] !== 'function') throw new TypeError(`metadata.${name} is required.`)
    if (typeof store?.missingCandleRanges !== 'function') throw new TypeError('store.missingCandleRanges is required.')
    if (!write && typeof store.appendCandles !== 'function') throw new TypeError('store.appendCandles or write is required.')
    if (!sources || !Object.keys(sources).length) throw new TypeError('At least one history source is required.')
    for (const [name, source] of Object.entries(sources)) if (typeof source?.fetchGap !== 'function') throw new TypeError(`Invalid history source: ${name}.`)
    this.metadata = metadata; this.store = store; this.sources = new Map(Object.entries(sources))
    this.write = write ?? ((records, task) => store.appendCandles(records, task.priority))
    this.onProgress = onProgress; this.onError = onError; this.now = now
    this.maxConcurrentTasks = integer(options.maxConcurrentTasks ?? 8, 'maxConcurrentTasks', 1)
    const limits = options.maxConcurrentPerSource ?? 4
    if (typeof limits !== 'number' && (!limits || typeof limits !== 'object' || Array.isArray(limits))) throw new TypeError('Invalid maxConcurrentPerSource.')
    if (typeof limits === 'number') integer(limits, 'maxConcurrentPerSource', 1)
    else for (const [source, limit] of Object.entries(limits)) {
      if (!this.sources.has(source)) throw new TypeError(`Unknown maxConcurrentPerSource source: ${source}.`)
      integer(limit, `maxConcurrentPerSource.${source}`, 1)
    }
    this.maxConcurrentPerSource = new Map([...this.sources.keys()].map(source => [source, typeof limits === 'number' ? limits : limits[source] ?? 1]))
    this.minRequestIntervalMS = integer(options.minRequestIntervalMS ?? 0, 'minRequestIntervalMS')
    this.retryBaseMS = integer(options.retryBaseMS ?? 1000, 'retryBaseMS', 1)
    this.maxRetryDelayMS = integer(options.maxRetryDelayMS ?? 300000, 'maxRetryDelayMS', this.retryBaseMS)
    this.maxAttempts = integer(options.maxAttempts ?? 5, 'maxAttempts', 1)
    this.maxRetainedTerminalTasks = integer(options.maxRetainedTerminalTasks ?? 512, 'maxRetainedTerminalTasks', 1)
    if (this.minRequestIntervalMS > 2147483647 || this.maxRetryDelayMS > 2147483647) throw new TypeError('History delays cannot exceed 2147483647 milliseconds.')
    this.tasks = new Map(); this.groups = new Map(); this.waiters = new Map(); this.controls = new Map(); this.idleWaiters = []
    this.active = new Map(); this.coverageChecks = new Map(); this.coverageEpochs = new Map()
    this.closed = false; this.started = null; this.closing = null; this.timer = null; this.draining = false
    this.requestTail = Promise.resolve(); this.lastRequestAt = null
    this.turn = 0; this.urgentTurns = 0; this.fatalError = null; this.instrumentEpochs = new Map()
  }

  start() {
    if (this.closed) return Promise.reject(new Error('HistorySync is closed.'))
    this.started ??= this.removeLegacyTasks().then(() => { this.kick(); return this })
    return this.started
  }

  async removeLegacyTasks() {
    const saved = await this.metadata.listSyncTasks()
    if (!Array.isArray(saved)) throw new TypeError('metadata.listSyncTasks must return an array.')
    // Old rolling archive goals must never restart merely because the app opens.
    const ids = [...new Set(saved.map(task => task?.id).filter(id => typeof id === 'string' && id))]
    if (ids.length) {
      if (this.metadata.deleteSyncTasks) await this.metadata.deleteSyncTasks(ids)
      else for (const id of ids) await this.metadata.deleteSyncTask(id)
    }
  }

  group(identity) {
    const key = seriesKey(identity)
    if (!this.groups.has(key)) this.groups.set(key, { key, ...descriptor(identity), tasks: new Set(), active: null, lastServed: 0, urgentPages: 0 })
    return this.groups.get(key)
  }

  async enqueue(input) {
    const epoch = this.instrumentEpochs.get(input?.instrument) ?? 0
    await this.start(); this.assertOpen()
    if (epoch !== (this.instrumentEpochs.get(input?.instrument) ?? 0)) throw new DOMException('The instrument history demand was retired.', 'AbortError')
    const identity = descriptor(input), bounds = range(input, intervals[identity.timeframe])
    if (!this.sources.has(identity.source)) throw new TypeError(`History source is unavailable: ${identity.source}.`)
    if (input.purpose !== undefined && input.purpose !== 'requested') throw new TypeError('Invalid history purpose.')
    const id = `consumer-${randomUUID()}`, timestamp = integer(this.now(), 'now()')
    const task = { schemaVersion: 1, id, ...identity, ...bounds, purpose: 'requested', priority: priority(input.priority ?? 'background'),
      status: 'queued', createdAt: timestamp, updatedAt: timestamp, nextAttemptAt: null, attempts: 0, cursor: null, cursorRange: null,
      unavailableRanges: [], remaining: [bounds], writtenRecords: 0, coveredRecords: 0, unavailableRecords: 0, localRecords: 0, inspected: false, lastError: null }
    this.tasks.set(id, task); this.group(task).tasks.add(id)
    const active = this.group(task).active
    if (active && active.rank < priorities.continuity && priorities[task.priority] >= priorities.continuity
      && (!active.bounds || !intersects(task, active.bounds))) active.controller.abort()
    this.notify(task); this.kick()
    return clone(task)
  }

  async removeTargets(instIds) {
    const removed = new Set(instIds)
    for (const id of removed) this.instrumentEpochs.set(id, (this.instrumentEpochs.get(id) ?? 0) + 1)
    await this.start(); this.assertOpen()
    const tasks = [...this.tasks.values()].filter(task => removed.has(task.instrument))
    await Promise.all(tasks.filter(task => !terminal.has(task.status) || this.controls.has(task.id)).map(task => this.cancel(task.id)))
    for (const task of tasks) {
      this.tasks.delete(task.id); this.group(task).tasks.delete(task.id)
    }
    for (const group of this.groups.values()) if (removed.has(group.instrument)) {
      group.active?.controller.abort(); this.coverageChecks.delete(group.key)
      if (!group.active) this.groups.delete(group.key)
    }
    this.kick(); this.settleIdle()
  }

  getTask(id) { const task = this.tasks.get(text(id, 'task ID')); return task ? clone(task) : null }
  listTasks() { return [...this.tasks.values()].map(clone) }
  progressFor(ids, timeframe) {
    const wanted = new Set(ids), retrying = new Set(), unavailable = new Set()
    for (const task of this.tasks.values()) if (task.timeframe === timeframe && wanted.has(task.instrument)) {
      if (task.status === 'retry') retrying.add(task.instrument)
      if (['paused', 'unavailable'].includes(task.status)) unavailable.add(task.instrument)
    }
    return { retrying: retrying.size, unavailable: unavailable.size }
  }
  assertOpen() { if (this.closed) throw new Error('HistorySync is closed.'); if (this.fatalError) throw this.fatalError }
  requireTask(id) { const task = this.tasks.get(text(id, 'task ID')); if (!task) throw new Error(`Unknown history task: ${id}.`); return task }
  async pause(id) { return this.control(id, 'paused') }
  async cancel(id) { return this.control(id, 'cancelled') }
  async control(id, status) {
    await this.start(); this.assertOpen()
    const pending = this.controls.get(id)
    if (pending) {
      const result = await pending
      if (result.status === status) return result
    }
    const task = this.requireTask(id); task.status = status; task.nextAttemptAt = null
    const group = this.group(task), entry = group.active
    // Cancelling one consumer never cancels another consumer's shared page.
    if (entry && !this.demands(group).some(value => !entry.bounds || intersects(value, entry.bounds))) entry.controller.abort()
    if (!entry?.writing || !intersects(task, entry.bounds)) {
      this.notify(task); this.settle(task); this.prune(); this.kick()
      return clone(task)
    }
    // An admitted durable mutation owns its completion even after its last
    // consumer stops. Never wait for a shared page still on the network.
    const stopped = Promise.resolve().then(async () => {
      try {
        await entry.writePromise.catch(() => undefined)
        await this.missing(task, task.priority)
        this.measure(task, this.coverageChecks.get(group.key), [...task.unavailableRanges, ...entry.unavailable])
      } finally {
        this.controls.delete(id)
        this.notify(task); this.settle(task); this.prune(); this.kick(); this.settleIdle()
      }
      return clone(task)
    })
    this.controls.set(id, stopped)
    return stopped
  }

  async resume(id) {
    await this.start(); this.assertOpen()
    const stopping = this.controls.get(id)
    if (stopping) await stopping
    const task = this.requireTask(id)
    task.status = 'queued'; task.nextAttemptAt = null; task.attempts = 0; task.lastError = null; task.unavailableRanges = []
    this.invalidate(task)
    this.notify(task); this.kick(); return clone(task)
  }
  async waitFor(id) {
    await this.start(); this.assertOpen()
    const task = this.requireTask(id)
    if (terminal.has(task.status) && !this.controls.has(task.id)) return clone(task)
    return new Promise((resolve, reject) => { const values = this.waiters.get(id) ?? []; values.push({ resolve, reject }); this.waiters.set(id, values) })
  }
  async whenIdle() { await this.start(); this.assertOpen(); if (this.isIdle()) return; return new Promise((resolve, reject) => this.idleWaiters.push({ resolve, reject })) }
  demands(group) { return [...group.tasks].map(id => this.tasks.get(id)).filter(task => task && !terminal.has(task.status)) }
  ready(group) { return this.demands(group).filter(task => task.status !== 'retry' || task.nextAttemptAt <= this.now()) }
  invalidate(query) {
    const key = seriesKey(query), cached = this.coverageChecks.get(key)
    this.coverageEpochs.set(key, (this.coverageEpochs.get(key) ?? 0) + 1)
    if (cached) cached.dirty = merged([...cached.dirty, ...clipped([query], cached)], intervals[query.timeframe])
  }

  async missing(query, requestPriority) {
    const key = seriesKey(query), step = intervals[query.timeframe], previous = this.coverageChecks.get(key)
    const epoch = this.coverageEpochs.get(key) ?? 0, version = await this.store.coverageVersion?.(query)
    // A series has one coverage cache shared by every active consumer.
    const retained = [...this.group(query).tasks].map(id => this.tasks.get(id)).filter(task => task && (!terminal.has(task.status) || this.controls.has(task.id)))
    const bounds = { from: Math.min(query.from, ...retained.map(task => task.from)), through: Math.max(query.through, ...retained.map(task => task.through)) }
    let gaps = clipped(previous?.remaining ?? [], bounds), leases = clipped(previous?.leases ?? [], bounds)
    let refresh = previous ? [...subtract([bounds], [previous], step), ...clipped(previous.dirty, bounds), ...leases.filter(lease => lease.expiresAt <= this.now())] : [bounds]
    if (previous && (version === undefined || previous.version !== version)) {
      const changed = version === undefined ? null : await this.store.coverageChanges?.(query, previous.version)
      refresh.push(...clipped(changed?.ranges ?? [bounds], bounds))
    }
    for (const portion of merged(refresh, step)) {
      const request = { ...query, ...portion, intervalMS: step }
      const result = await this.store.missingCandleRanges(request, requestPriority)
      if (!Array.isArray(result)) throw new TypeError('store.missingCandleRanges must return an array.')
      const checked = result.map(value => range(value, step))
      if (checked.some(value => value.from < portion.from || value.through > portion.through)) throw new TypeError('Store gaps must be inside the requested range.')
      gaps = merged([...subtract(gaps, [portion], step), ...checked], step)
      const observed = this.store.coverageLeases?.(request) ?? []
      if (!Array.isArray(observed)) throw new TypeError('store.coverageLeases must return an array.')
      for (const lease of observed) {
        range(lease, step); integer(lease.expiresAt, 'expiresAt')
        if (lease.from < portion.from || lease.through > portion.through) throw new TypeError('Coverage leases must be inside the verified range.')
      }
      leases = [...subtract(leases, [portion], step), ...observed]
    }
    const cached = { ...bounds, version, remaining: gaps, leases, dirty: [] }
    if (epoch !== (this.coverageEpochs.get(key) ?? 0) || version !== await this.store.coverageVersion?.(query)) cached.dirty = [bounds]
    this.coverageChecks.set(key, cached)
    if (cached.dirty.length) return this.missing(query, requestPriority)
    return clipped(gaps, query)
  }

  unavailable(query, inspection) {
    const step = intervals[query.timeframe], values = [...(inspection?.unavailable ?? [])]
    if (inspection?.availableFrom !== undefined) {
      const first = Math.ceil(integer(inspection.availableFrom, 'availableFrom') / step) * step
      if (first > query.from) values.push({ from: query.from, through: first - step, reason: inspection.reason ?? 'Before the source history boundary.' })
    }
    if (inspection?.availableThrough !== undefined) {
      const last = Math.floor(integer(inspection.availableThrough, 'availableThrough') / step) * step
      if (last < query.through) values.push({ from: last + step, through: query.through, reason: inspection.reason ?? 'After the source history boundary.' })
    }
    return clipped(values.map(value => ({ ...range(value, step), reason: text(value.reason, 'unavailable reason') })), query)
  }

  kick() {
    if (this.closed || this.fatalError || this.draining) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.drain() }, 0)
  }
  canAdmit(group, rank) {
    const entries = [...this.active.values()], limit = this.maxConcurrentPerSource.get(group.source)
    if (group.active || entries.length >= this.maxConcurrentTasks || entries.filter(value => value.group.source === group.source).length >= limit) return false
    // Background never occupies the last global or source slot when a reserve exists.
    if (rank < priorities.continuity && (entries.filter(value => value.rank < priorities.continuity).length >= Math.max(1, this.maxConcurrentTasks - 1)
      || entries.filter(value => value.group.source === group.source && value.rank < priorities.continuity).length >= Math.max(1, limit - 1))) return false
    return true
  }
  async drain() {
    if (this.draining || this.closed) return
    this.draining = true
    try {
      while (!this.closed && !this.fatalError) {
        let candidates = [...this.groups.values()].map(group => ({ group, rank: Math.max(-1, ...this.ready(group).map(task => priorities[task.priority])) }))
          .filter(value => value.rank >= 0 && this.canAdmit(value.group, value.rank))
          .sort((a, b) => b.rank - a.rank || a.group.lastServed - b.group.lastServed)
        if (!candidates.length) break
        // A continuing stream of interactive demands cannot starve maintenance.
        if (this.urgentTurns >= 8) {
          const maintenance = candidates.filter(value => value.rank < priorities.continuity).sort((a, b) => a.group.lastServed - b.group.lastServed)[0]
          if (maintenance) candidates = [maintenance, ...candidates.filter(value => value !== maintenance)]
        }
        const { group, rank } = candidates[0]
        this.urgentTurns = rank >= priorities.continuity ? this.urgentTurns + 1 : 0
        group.lastServed = ++this.turn
        const entry = { group, rank, bounds: null, controller: new AbortController(), promise: null, writing: false, writePromise: null, unavailable: [] }
        group.active = entry; this.active.set(group.key, entry)
        entry.promise = this.run(entry).catch(error => this.fail(error)).finally(() => {
          group.active = null; this.active.delete(group.key); this.prune(); this.kick(); this.settleIdle()
        })
      }
    } finally {
      this.draining = false
      const retries = [...this.tasks.values()].filter(task => task.status === 'retry').map(task => task.nextAttemptAt)
      if (!this.active.size && retries.length && !this.closed) this.timer = setTimeout(() => this.kick(), Math.min(2147483647, Math.max(1, Math.min(...retries) - this.now())))
      this.settleIdle()
    }
  }

  async callSource(operation, signal) {
    let result
    const admission = this.requestTail.then(async () => {
      signal.throwIfAborted()
      const delay = Math.max(0, (this.lastRequestAt ?? -Infinity) + this.minRequestIntervalMS - this.now())
      if (delay) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delay)
        const abort = () => { clearTimeout(timer); reject(signal.reason) }
        signal.addEventListener('abort', abort, { once: true })
      })
      signal.throwIfAborted(); this.lastRequestAt = this.now(); result = operation()
    })
    this.requestTail = admission.catch(() => undefined)
    await admission
    return result
  }

  async run(entry) {
    const { group, controller } = entry, { signal } = controller, step = intervals[group.timeframe]
    const initial = this.ready(group)
    const bounds = merged(initial, step), source = this.sources.get(group.source)
    try {
      let gaps = [], unavailable = initial.flatMap(task => task.unavailableRanges)
      for (const portion of bounds) {
        const query = { instrument: group.instrument, timeframe: group.timeframe, source: group.source, ...portion }
        const raw = await this.missing(query, initial[0].priority)
        signal.throwIfAborted()
        const excluded = source.inspect ? this.unavailable(query, await source.inspect({ ...query, priority: initial[0].priority, cursor: null, signal })) : []
        unavailable.push(...excluded); gaps.push(...subtract(raw, unavailable, step))
      }
      this.assess(group, unavailable)
      const ready = this.ready(group).sort((a, b) => priorities[b.priority] - priorities[a.priority] || a.createdAt - b.createdAt)
      const available = ready.filter(task => clipped(gaps, task).length)
      const selected = group.urgentPages >= 8 ? available.find(task => priorities[task.priority] < priorities.continuity) ?? available[0] : available[0]
      if (!selected) return
      group.urgentPages = priorities[selected.priority] >= priorities.continuity ? group.urgentPages + 1 : 0
      const wanted = clipped(gaps, selected).at(-1), connected = gaps.find(value => intersects(value, wanted))
      const size = integer(source.pageSize ?? (group.source === 'candles' ? 300 : 100), 'source.pageSize', 1)
      const from = Math.max(connected.from, wanted.through - (size - 1) * step)
      const page = { from, through: Math.min(connected.through, from + (size - 1) * step) }
      entry.bounds = page
      const participants = this.demands(group).filter(task => intersects(task, page))
      for (const task of participants) { task.status = 'running'; task.nextAttemptAt = null; this.notify(task) }
      const query = { instrument: group.instrument, timeframe: group.timeframe, source: group.source, ...page, priority: selected.priority, cursor: null, signal }
      const response = await this.callSource(() => source.fetchGap(query), signal)
      signal.throwIfAborted()
      const result = Array.isArray(response) ? { records: response } : response
      if (!result || !Array.isArray(result.records)) throw new TypeError('fetchGap must return records or an object containing records.')
      const records = result.records.filter(record => {
        if (!record || record.instrument !== group.instrument || record.timeframe !== group.timeframe || group.source === 'candles' && record.confirmed !== true) throw new TypeError('History sources must return records for the requested instrument and timeframe.')
        integer(record.timestamp, 'record.timestamp')
        if (record.timestamp % step) throw new TypeError('History source records must follow the timeframe grid.')
        return record.timestamp >= page.from && record.timestamp <= page.through
      })
      const before = slots(clipped(gaps, page), step)
      entry.unavailable = unavailable
      const commit = async () => {
        if (records.length) {
          // Once a write is admitted, cancellation cannot abandon its durable facts.
          await this.write(records, { ...clone(selected), ...page })
          this.invalidate({ ...query, from: Math.min(...records.map(row => row.timestamp)), through: Math.max(...records.map(row => row.timestamp)) })
          for (const task of participants) task.writtenRecords += records.filter(row => row.timestamp >= task.from && row.timestamp <= task.through).length
        }
        const after = await this.missing(query, selected.priority)
        if (result.unavailable) unavailable.push(...this.unavailable(query, result))
        for (const task of participants) if (!terminal.has(task.status)) task.status = 'queued'
        this.assess(group, unavailable)
        if (slots(subtract(after, unavailable, step), step) >= before && this.demands(group).some(task => intersects(task, page))) throw new Error('The history source made no persisted coverage progress.')
        for (const task of participants) if (!terminal.has(task.status)) { task.attempts = 0; task.lastError = null }
      }
      if (records.length) {
        entry.writing = true
        entry.writePromise = commit().finally(() => { entry.writing = false })
        await entry.writePromise
      } else await commit()

    } catch (error) {
      if (signal.aborted || this.closed) {
        for (const task of this.demands(group)) if (task.status === 'running') task.status = 'queued'
        return
      }
      for (const task of this.demands(group).filter(task => !entry.bounds || intersects(task, entry.bounds))) {
        task.attempts++; task.lastError = error instanceof Error ? error.message : String(error)
        task.status = task.attempts >= this.maxAttempts ? 'paused' : 'retry'
        task.nextAttemptAt = task.status === 'retry' ? this.now() + Math.min(this.maxRetryDelayMS, this.retryBaseMS * 2 ** Math.min(30, task.attempts - 1)) : null
        this.notify(task); this.settle(task)
      }
      try { await this.onError?.(error, this.getTask(initial[0]?.id)) } catch { /* Observers cannot stop acquisition. */ }
    }
  }

  assess(group, unavailable) {
    const cached = this.coverageChecks.get(group.key)
    if (!cached) return
    for (const task of this.demands(group)) {
      // A newly admitted consumer outside this coverage read remains queued.
      if (task.from < cached.from || task.through > cached.through) continue
      this.measure(task, cached, unavailable)
      const step = intervals[task.timeframe]
      if (!subtract(task.remaining, task.unavailableRanges, step).length) {
        task.status = task.remaining.length ? 'unavailable' : 'completed'; task.nextAttemptAt = null; task.attempts = 0; task.lastError = null
      }
      this.notify(task); this.settle(task)
    }
  }
  measure(task, cached, unavailable) {
    if (!cached || task.from < cached.from || task.through > cached.through) return
    const step = intervals[task.timeframe]
    task.remaining = clipped(cached.remaining, task)
    task.unavailableRanges = [...new Map(clipped(unavailable, task).map(value => [JSON.stringify(value), value])).values()]
    const coveredLeases = subtract(merged(clipped(cached.leases.filter(lease => lease.expiresAt > this.now()), task), step), task.remaining, step)
    const unavailableMissing = task.remaining.flatMap(portion => clipped(task.unavailableRanges, portion))
    task.coveredRecords = slots([task], step) - slots(task.remaining, step) - slots(coveredLeases, step)
    task.unavailableRecords = slots(merged([...coveredLeases, ...unavailableMissing], step), step)
    if (!task.inspected) task.localRecords = task.coveredRecords
    task.inspected = true
  }
  notify(task) { task.updatedAt = this.now(); try { Promise.resolve(this.onProgress?.(clone(task))).catch(() => undefined) } catch { /* Detached observer. */ } }
  settle(task) { if (!terminal.has(task.status) || this.controls.has(task.id)) return; const waiters = this.waiters.get(task.id) ?? []; this.waiters.delete(task.id); for (const waiter of waiters) waiter.resolve(clone(task)) }
  prune() {
    const finished = [...this.tasks.values()].filter(task => terminal.has(task.status) && !this.waiters.has(task.id) && !this.controls.has(task.id))
    for (const task of finished.slice(0, Math.max(0, finished.length - this.maxRetainedTerminalTasks))) { this.tasks.delete(task.id); this.group(task).tasks.delete(task.id) }
  }
  isIdle() { return !this.active.size && !this.controls.size && ![...this.tasks.values()].some(task => !terminal.has(task.status)) }
  settleIdle() { if (this.isIdle()) for (const waiter of this.idleWaiters.splice(0)) waiter.resolve() }
  fail(error) { this.fatalError = error; for (const entry of this.active.values()) entry.controller.abort(); for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter.reject(error); this.waiters.clear(); for (const waiter of this.idleWaiters.splice(0)) waiter.reject(error) }
  close() {
    if (this.closing) return this.closing
    this.closed = true; clearTimeout(this.timer)
    for (const entry of this.active.values()) entry.controller.abort()
    const error = new Error('HistorySync is closed.')
    for (const values of this.waiters.values()) for (const waiter of values) waiter.reject(error)
    this.waiters.clear(); for (const waiter of this.idleWaiters.splice(0)) waiter.reject(error)
    this.closing = (async () => { await this.started?.catch(() => undefined); await Promise.all([...this.active.values()].map(entry => entry.promise)); await Promise.allSettled([...this.controls.values()]) })()
    return this.closing
  }
}
