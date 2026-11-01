import { randomUUID } from 'node:crypto'
import { beginOperation } from './operations.js'

const intervals = { '5m': 300_000, '15m': 900_000, '1H': 3_600_000 }
const terminal = new Set(['paused', 'cancelled', 'completed', 'unavailable'])
const priorities = { interactive: 4, foreground: 4, prepared: 4, repair: 4, continuity: 3, statistics: 3, prefetch: 1, chartWarm: 1, background: 0 }
const MAX_SHARED_COVERAGE_SLOTS = 2400
const MAX_COVERAGE_INVALIDATIONS = 256
const MAX_ACTIVE_COVERAGE_JOURNALS = 128
const MAX_CHECKPOINT_ATTEMPTS = 32
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
const validRanges = (values, step) => Array.isArray(values) && values.every(value => Number.isSafeInteger(value?.from) && value.from >= 0
  && Number.isSafeInteger(value?.through) && value.from <= value.through && value.from % step === 0 && value.through % step === 0)
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
    const { store, sources, write, onProgress, onError, now = Date.now } = options ?? {}
    if (typeof store?.missingCandleRanges !== 'function') throw new TypeError('store.missingCandleRanges is required.')
    if (!write && typeof store.appendCandles !== 'function') throw new TypeError('store.appendCandles or write is required.')
    if (!sources || !Object.keys(sources).length) throw new TypeError('At least one history source is required.')
    for (const [name, source] of Object.entries(sources)) if (typeof source?.fetchGap !== 'function') throw new TypeError(`Invalid history source: ${name}.`)
    this.store = store; this.sources = new Map(Object.entries(sources))
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
    this.tasks = new Map(); this.groups = new Map(); this.waiters = new Map(); this.controls = new Map(); this.holds = new Set(); this.rechecks = new Set(); this.isolated = new Set(); this.heldDownloads = new Map(); this.heldCoverage = new Map(); this.idleWaiters = []
    this.active = new Map(); this.coverageChecks = new Map(); this.coverageEpochs = new Map(); this.coverageInvalidations = new Map(); this.coverageReaders = new Map()
    this.closed = false; this.started = null; this.closing = null; this.timer = null; this.draining = false
    this.requestTail = Promise.resolve(); this.lastRequestAt = null
    this.turn = 0; this.urgentTurns = 0; this.fatalError = null; this.instrumentEpochs = new Map()
  }

  start() {
    if (this.closed) return Promise.reject(new Error('HistorySync is closed.'))
    this.started ??= Promise.resolve().then(() => { this.kick(); return this })
    return this.started
  }

  group(identity) {
    const key = seriesKey(identity)
    if (!this.groups.has(key)) this.groups.set(key, { key, ...descriptor(identity), tasks: new Set(), active: null, lastServed: 0, urgentPages: 0 })
    return this.groups.get(key)
  }

  async enqueue(input, { hold = false } = {}) {
    const epoch = this.instrumentEpochs.get(input?.instrument) ?? 0
    await this.start(); this.assertOpen()
    if (epoch !== (this.instrumentEpochs.get(input?.instrument) ?? 0)) throw new DOMException('The instrument history demand was retired.', 'AbortError')
    const identity = descriptor(input), bounds = range(input, intervals[identity.timeframe])
    if (!this.sources.has(identity.source)) throw new TypeError(`History source is unavailable: ${identity.source}.`)
    if (input.purpose !== undefined && input.purpose !== 'requested') throw new TypeError('Invalid history purpose.')
    const id = `consumer-${randomUUID()}`, timestamp = integer(this.now(), 'now()')
    const task = { schemaVersion: 1, id, ...identity, ...bounds, purpose: 'requested', priority: priority(input.priority ?? 'background'),
      status: 'queued', createdAt: timestamp, updatedAt: timestamp, nextAttemptAt: null, attempts: 0, cursor: null, cursorRange: null,
      unavailableRanges: [], remaining: [bounds], writtenRecords: 0, coveredRecords: 0, emptyRecords: 0, unavailableRecords: 0, localRecords: 0, inspected: false, lastError: null }
    if (typeof hold !== 'boolean') throw new TypeError('History hold must be boolean.')
    if (hold) { this.holds.add(id); this.heldDownloads.set(id, []) }
    this.tasks.set(id, task); this.group(task).tasks.add(id)
    const active = this.group(task).active
    const cached = this.coverageChecks.get(seriesKey(task))
    if (cached && !cached.dirty.length) this.measure(task, cached, this.demands(this.group(task)).flatMap(value => value.unavailableRanges))
    if (active?.bounds && !active.writing && active.rank < priorities.continuity && priorities[task.priority] >= priorities.continuity
      && !intersects(task, active.bounds)) active.controller.abort()
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
      this.holds.delete(task.id); this.rechecks.delete(task.id); this.isolated.delete(task.id); this.heldDownloads.delete(task.id); this.heldCoverage.delete(task.id); this.tasks.delete(task.id); this.group(task).tasks.delete(task.id)
    }
    for (const group of this.groups.values()) if (removed.has(group.instrument)) {
      group.active?.controller.abort(); this.coverageChecks.delete(group.key)
      if (!group.active) this.groups.delete(group.key)
    }
    this.kick(); this.settleIdle()
  }

  getTask(id) { const task = this.tasks.get(text(id, 'task ID')); return task ? clone(task) : null }
  listTasks() { return [...this.tasks.values()].map(clone) }
  release(id) {
    const task = this.requireTask(id)
    if (!this.holds.delete(id) || terminal.has(task.status)) return false
    // Child commits may have changed or removed parent rows after the initial
    // local inspection. Re-read before allowing acquisition or completion.
    task.unavailableRanges = []
    this.rechecks.add(id)
    this.isolated.add(id)
    this.invalidate(task)
    if (task.status === 'waiting') task.status = 'queued'
    this.notify(task); this.kick()
    return true
  }
  promote(query, requestPriority) {
    this.assertOpen()
    const identity = descriptor(query), bounds = range(query, intervals[identity.timeframe]), promoted = priority(requestPriority)
    const group = this.groups.get(seriesKey(identity))
    if (!group) return 0
    let changed = 0
    for (const task of this.demands(group)) if (task.from >= bounds.from && task.through <= bounds.through && priorities[task.priority] < priorities[promoted]) {
      task.priority = promoted; changed++; this.notify(task)
    }
    // Active rank and source getPriority read these same live consumers. The
    // MarketHistory owner wakes its transport queues after this promotion.
    if (changed) this.kick()
    return changed
  }
  progressFor(ids, timeframe) {
    const wanted = new Set(ids), retrying = new Set(), unavailable = new Set()
    for (const task of this.tasks.values()) if (task.timeframe === timeframe && wanted.has(task.instrument)) {
      if (task.status === 'retry') retrying.add(task.instrument)
      if (task.status === 'unavailable') unavailable.add(task.instrument)
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
    const task = this.requireTask(id); task.status = status; task.nextAttemptAt = null; this.holds.delete(id)
    const group = this.group(task), entry = group.active
    // Cancelling one consumer never cancels another consumer's shared page.
    if (entry && !this.demands(group).some(value => !this.holds.has(value.id) && (!entry.bounds || intersects(value, entry.bounds)))) entry.controller.abort()
    if (!entry?.writing || !intersects(task, entry.bounds)) {
      this.notify(task); this.settle(task); this.prune(); this.kick()
      return clone(task)
    }
    // An admitted durable mutation owns its completion even after its last
    // consumer stops. Never wait for a shared page still on the network.
    const stopped = Promise.resolve().then(async () => {
      const unverified = () => {
        task.remaining = [{ from: task.from, through: task.through }]
        task.unavailableRanges = []
        task.coveredRecords = 0; task.emptyRecords = 0; task.unavailableRecords = 0; task.localRecords = 0; task.inspected = false
      }
      try {
        await entry.writePromise.catch(() => undefined)
        const checkpoint = await this.missing(task, task.priority, undefined, { maxAttempts: MAX_CHECKPOINT_ATTEMPTS, returnCoverage: true })
        if (!checkpoint || this.coverageChecks.get(group.key) !== checkpoint.coverage || checkpoint.coverage.dirty.length) {
          // A changing range cannot be reported as verified. The acknowledged
          // write count remains durable, and later requests can recheck it.
          unverified()
        } else this.measure(task, checkpoint.coverage, this.rechecks.has(task.id) ? [] : this.isolated.has(task.id)
          ? [...task.unavailableRanges, ...(entry.freshUnavailable ?? [])] : [...task.unavailableRanges, ...entry.unavailable])
      } catch (error) {
        unverified()
        throw error
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
  async waitFor(id, { failFast = false } = {}) {
    await this.start(); this.assertOpen()
    const task = this.requireTask(id)
    if (failFast && task.lastError) throw this.requestError(task)
    if (terminal.has(task.status) && !this.controls.has(task.id)) return clone(task)
    return new Promise((resolve, reject) => { const values = this.waiters.get(id) ?? []; values.push({ resolve, reject, failFast }); this.waiters.set(id, values) })
  }
  async whenIdle() { await this.start(); this.assertOpen(); if (this.isIdle()) return; return new Promise((resolve, reject) => this.idleWaiters.push({ resolve, reject })) }
  demands(group) { return [...group.tasks].map(id => this.tasks.get(id)).filter(task => task && !terminal.has(task.status)) }
  ready(group) { return this.demands(group).filter(task => task.status !== 'waiting' && (task.status !== 'retry' || task.nextAttemptAt <= this.now())) }
  sourceQuery(entry, bounds) {
    // Keep this callback intact through adapters: MarketService.get accepts it
    // in its fifth argument, { getPriority }, and reevaluates queued admission.
    const getPriority = () => this.demands(entry.group).filter(task => !entry.bounds || intersects(task, entry.bounds))
      .sort((a, b) => priorities[b.priority] - priorities[a.priority])[0]?.priority ?? 'background'
    return { instrument: entry.group.instrument, timeframe: entry.group.timeframe, source: entry.group.source, ...bounds,
      priority: getPriority(), getPriority, cursor: null, signal: entry.controller.signal }
  }
  invalidate(query) {
    if (!query || typeof query.instrument !== 'string' || !query.instrument.trim() || !Object.hasOwn(intervals, query.timeframe)
      || typeof query.source !== 'string' || !this.sources.has(query.source)) {
      // An unknown identity cannot safely be assigned to just one series.
      // A read may already be awaiting its version before its group exists.
      for (const key of new Set([...this.groups.keys(), ...this.coverageReaders.keys()])) {
        const [instrument, timeframe, source] = JSON.parse(key)
        this.invalidate({ instrument, timeframe, source, from: NaN, through: NaN })
      }
      return
    }
    const step = intervals[query.timeframe], valid = Number.isSafeInteger(query.from) && query.from >= 0
      && Number.isSafeInteger(query.through) && query.from <= query.through && query.from % step === 0 && query.through % step === 0
    const affected = valid ? { from: query.from, through: query.through } : { from: 0, through: Math.floor(Number.MAX_SAFE_INTEGER / step) * step }
    const key = seriesKey(query), cached = this.coverageChecks.get(key)
    const active = this.groups.get(key)?.active
    if (active?.inspectionBounds?.some(bounds => intersects(bounds, affected))) active.inspectionInvalidated = true
    if (this.coverageReaders.has(key)) {
      const previousEpoch = this.coverageEpochs.get(key) ?? 0
      const epoch = previousEpoch >= Number.MAX_SAFE_INTEGER ? 0 : previousEpoch + 1
      this.coverageEpochs.set(key, epoch)
      let journal = this.coverageInvalidations.get(key)
      if (epoch === 0 && journal) journal.length = 0
      if (!journal && this.coverageInvalidations.size < MAX_ACTIVE_COVERAGE_JOURNALS) {
        journal = []; this.coverageInvalidations.set(key, journal)
      }
      if (journal) {
        journal.push({ epoch, range: valid ? affected : null })
        if (journal.length > MAX_COVERAGE_INVALIDATIONS) journal.shift()
      }
    }
    if (cached) cached.dirty = merged([...cached.dirty, ...clipped([affected], cached)], step)
    let wake = false
    for (const id of this.groups.get(key)?.tasks ?? []) {
      const task = this.tasks.get(id), held = this.heldCoverage.get(id)
      if (!task || terminal.has(task.status) || !held || !intersects(held, affected)) continue
      // A shared snapshot can cover more than this consumer. Keep the entire
      // snapshot valid for any overlapping consumer that reuses it later.
      held.dirty = merged([...held.dirty, ...clipped([affected], held)], step)
      if (this.holds.has(id) && intersects(task, affected)) {
        // A source boundary may have changed during the hold. A local
        // refresh needs current inspection rather than old shared evidence.
        task.unavailableRanges = []
        this.rechecks.add(id); this.isolated.add(id)
        if (task.status === 'waiting') { task.status = 'queued'; wake = true }
      }
    }
    if (wake) this.kick()
  }

  async missing(query, requestPriority, pinned, { materializeRanges = [query], signal, maxAttempts = Infinity, returnCoverage = false } = {}) {
    const key = seriesKey(query), step = intervals[query.timeframe]
    let previous = pinned ?? this.coverageChecks.get(key)
    this.coverageReaders.set(key, (this.coverageReaders.get(key) ?? 0) + 1)
    try {
      let attempts = 0
      while (true) {
        attempts++
        signal?.throwIfAborted()
        const epoch = this.coverageEpochs.get(key) ?? 0, version = await this.store.coverageVersion?.(query)
        signal?.throwIfAborted()
        // A series has one coverage cache shared by every active consumer.
        // Only consumers intersecting this read can extend its shared window.
        // A held archive range and an unrelated old/new interactive range must
        // never expand a bounded request into years of intervening rows.
        const retained = [...this.group(query).tasks].map(id => this.tasks.get(id)).filter(task => task && intersects(task, query) && (!terminal.has(task.status) || this.controls.has(task.id)))
        const shared = { from: Math.min(query.from, ...retained.map(task => task.from)), through: Math.max(query.through, ...retained.map(task => task.through)) }
        const maxSlots = Math.max(MAX_SHARED_COVERAGE_SLOTS, (query.through - query.from) / step + 1)
        const bounds = slots([shared], step) <= maxSlots ? shared : { from: query.from, through: query.through }
        let gaps = clipped(previous?.remaining ?? [], bounds), leases = clipped(previous?.leases ?? [], bounds)
        // Gaps observed for progress alone have not been checked for derivable
        // prices. A later foreground request or release must materialize them.
        let unmaterialized = clipped(previous?.unmaterialized ?? [], bounds)
        const materializedBounds = merged(materializeRanges.flatMap(value => clipped([value], bounds)), step)
        let refresh = previous ? [...subtract([bounds], [previous], step), ...clipped(previous.dirty, bounds), ...leases.filter(lease => lease.expiresAt <= this.now())] : [bounds]
        refresh.push(...materializedBounds.flatMap(value => clipped(unmaterialized, value)))
        if (previous && (version === undefined || previous.version !== version)) {
          const changed = version === undefined ? null : await this.store.coverageChanges?.(query, previous.version)
          signal?.throwIfAborted()
          refresh.push(...clipped(changed && changed.revision === version && validRanges(changed.ranges, step) ? changed.ranges : [bounds], bounds))
        }
        const requested = merged(refresh, step)
        const portions = [...materializedBounds.flatMap(value => clipped(requested, value)).map(value => ({ ...value, materialize: true })),
          ...subtract(requested, materializedBounds, step).map(value => ({ ...value, materialize: false }))]
        for (const portion of portions) {
          signal?.throwIfAborted()
          const request = { ...descriptor(query), ...portion, intervalMS: step }
          delete request.materialize
          const result = await this.store.missingCandleRanges(request, requestPriority, { materialize: portion.materialize })
          signal?.throwIfAborted()
          if (!Array.isArray(result)) throw new TypeError('store.missingCandleRanges must return an array.')
          const checked = result.map(value => range(value, step))
          if (checked.some(value => value.from < portion.from || value.through > portion.through)) throw new TypeError('Store gaps must be inside the requested range.')
          gaps = merged([...subtract(gaps, [portion], step), ...checked], step)
          unmaterialized = merged([...subtract(unmaterialized, [portion], step), ...(portion.materialize ? [] : checked)], step)
          const observed = this.store.coverageLeases?.(request) ?? []
          if (!Array.isArray(observed)) throw new TypeError('store.coverageLeases must return an array.')
          for (const lease of observed) {
            range(lease, step); integer(lease.expiresAt, 'expiresAt')
            if (lease.from < portion.from || lease.through > portion.through) throw new TypeError('Coverage leases must be inside the verified range.')
          }
          leases = [...subtract(leases, [portion], step), ...observed]
        }
        const cached = { ...bounds, version, remaining: gaps, leases, unmaterialized, dirty: [] }
        const afterVersion = await this.store.coverageVersion?.(query), afterEpoch = this.coverageEpochs.get(key) ?? 0
        signal?.throwIfAborted()
        let dirty = []
        if (epoch !== afterEpoch) {
          const journal = this.coverageInvalidations.get(key), changes = Array.isArray(journal) && journal.every(change => change && Number.isSafeInteger(change.epoch))
            ? journal.filter(change => change.epoch > epoch && change.epoch <= afterEpoch) : []
          if (!changes.length || changes[0].epoch !== epoch + 1 || changes.at(-1).epoch !== afterEpoch
            || changes.some((change, index) => change.epoch !== epoch + index + 1 || !validRanges([change.range], step))) dirty = [bounds]
          else dirty.push(...changes.map(change => change.range))
        }
        if (version !== afterVersion) {
          const changed = Number.isSafeInteger(version) && Number.isSafeInteger(afterVersion) && afterVersion > version
            ? await this.store.coverageChanges?.(query, version) : null
          signal?.throwIfAborted()
          const validChanges = changed && changed.revision === afterVersion && validRanges(changed.ranges, step)
          if (!validChanges || afterVersion !== await this.store.coverageVersion?.(query)) dirty = [bounds]
          else dirty.push(...changed.ranges)
          signal?.throwIfAborted()
        }
        if (afterEpoch !== (this.coverageEpochs.get(key) ?? 0)) dirty = [bounds]
        cached.dirty = merged(clipped(dirty, bounds), step)
        if (cached.dirty.length && attempts >= maxAttempts) {
          // The changed range is not trustworthy. Retire all shared and held
          // coverage for this series, including any in-flight inspection.
          this.invalidate({ ...descriptor(query), from: 0, through: Math.floor(Number.MAX_SAFE_INTEGER / step) * step })
          return null
        }
        this.coverageChecks.set(key, cached)
        if (cached.dirty.length) { previous = cached; continue }
        return returnCoverage ? { ranges: clipped(gaps, query), coverage: cached } : clipped(gaps, query)
      }
    } finally {
      const readers = this.coverageReaders.get(key) - 1
      if (readers) this.coverageReaders.set(key, readers)
      else { this.coverageReaders.delete(key); this.coverageEpochs.delete(key); this.coverageInvalidations.delete(key) }
    }
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
        const entry = { group, bounds: null, controller: new AbortController(), promise: null, writing: false, writePromise: null, unavailable: [] }
        const demand = this.sourceQuery(entry, {})
        Object.defineProperty(entry, 'rank', { get: () => priorities[demand.getPriority()] })
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

  async callSource(operation, query) {
    const { signal } = query
    const queuedAt = performance.now(), queued = beginOperation({ category: 'cpu', name: 'history.source.queue', resource: query.source, attributes: { priority: query.priority } })
    let result
    const admission = this.requestTail.then(async () => {
      signal.throwIfAborted()
      const delay = Math.max(0, (this.lastRequestAt ?? -Infinity) + this.minRequestIntervalMS - this.now())
      if (delay) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delay)
        const abort = () => { clearTimeout(timer); reject(signal.reason) }
        signal.addEventListener('abort', abort, { once: true })
      })
      signal.throwIfAborted(); this.lastRequestAt = this.now()
      queued.end({ attributes: { priority: query.getPriority(), queueMS: performance.now() - queuedAt } })
      result = operation()
    })
    this.requestTail = admission.catch(() => undefined)
    try { await admission } catch (error) { queued.end({ status: signal.aborted ? 'cancelled' : 'error', attributes: { queueMS: performance.now() - queuedAt } }); throw error }
    return result
  }

  async run(entry) {
    const { group, controller } = entry, { signal } = controller, step = intervals[group.timeframe]
    const initial = this.ready(group)
    const sourceEligible = new Set(initial.filter(task => !this.holds.has(task.id)).map(task => task.id))
    const bounds = merged(initial, step), source = this.sources.get(group.source)
    try {
      let gaps = [], unavailable = initial.flatMap(task => task.unavailableRanges), freshUnavailable = []
      const observedCoverage = []
      entry.inspectionBounds = [...bounds]
      for (const portion of bounds) {
        const query = this.sourceQuery(entry, portion)
        const pinned = initial.map(task => this.heldCoverage.get(task.id)).find(value => value && value.from <= portion.from && value.through >= portion.through)
        // An already-inspected hold only reports durable local progress.
        // Its initial inspection and release still materialize all derivable
        // prices before the consumer can complete or fetch from the source.
        const materializeRanges = initial.filter(task => !this.holds.has(task.id) || !this.heldCoverage.has(task.id))
        // Initial coverage may stop when its source demand is withdrawn.
        // An accepted write still completes before its bounded checkpoint.
        const raw = await this.missing(query, query.priority, pinned, { materializeRanges, signal })
        // missing() also reads retained consumers' ranges to share coverage.
        // Any of those ranges may be assessed after inspection, even when
        // they do not intersect the currently selected consumer's bounds.
        const cached = this.coverageChecks.get(group.key)
        if (cached) {
          entry.inspectionBounds.push({ from: cached.from, through: cached.through })
          observedCoverage.push(cached)
        }
        signal.throwIfAborted()
        const excluded = source.inspect ? this.unavailable(query, await source.inspect(query)) : []
        // A hold can be released, or a mutation can invalidate this range,
        // while source inspection is suspended. Never complete a consumer
        // from the coverage snapshot that preceded that change.
        if (entry.inspectionInvalidated || observedCoverage.some(value => value.dirty.length)) return
        unavailable.push(...excluded); freshUnavailable.push(...excluded); gaps.push(...subtract(raw, freshUnavailable, step))
      }
      // A foreground consumer may arrive while a progress-only read is in
      // flight. It must upgrade those gaps before this run can fetch them.
      if (this.ready(group).some(task => !this.holds.has(task.id) && !sourceEligible.has(task.id)
        && observedCoverage.some(cached => cached.unmaterialized.some(portion => intersects(task, portion))))) return
      entry.inspectionBounds = null
      for (const task of initial) this.rechecks.delete(task.id)
      this.assess(group, unavailable, observedCoverage, freshUnavailable)
      const ready = this.ready(group).sort((a, b) => priorities[b.priority] - priorities[a.priority] || a.createdAt - b.createdAt)
      const needed = task => clipped(subtract(gaps, task.unavailableRanges, step), task)
      const available = ready.filter(task => needed(task).length)
      const selected = group.urgentPages >= 8 ? available.find(task => priorities[task.priority] < priorities.continuity) ?? available[0] : available[0]
      if (!selected) return
      group.urgentPages = priorities[selected.priority] >= priorities.continuity ? group.urgentPages + 1 : 0
      // A ready interactive consumer may share a group with a held archive.
      // Extend a page only through ranges owned by consumers actually ready
      // for source access; a held gap alone cannot authorize prefetch.
      const admitted = merged(ready.flatMap(needed), step)
      const wanted = needed(selected).at(-1), connected = admitted.find(value => intersects(value, wanted))
      const size = integer(source.pageSize ?? (group.source === 'candles' ? 300 : 100), 'source.pageSize', 1)
      const from = Math.max(connected.from, wanted.through - (size - 1) * step)
      const page = { from, through: Math.min(connected.through, from + (size - 1) * step) }
      entry.bounds = page
      const participants = this.demands(group).filter(task => intersects(task, page))
      for (const task of participants) {
        task.status = this.holds.has(task.id) ? this.rechecks.has(task.id) ? 'queued' : 'waiting' : 'running'
        task.nextAttemptAt = null; this.notify(task)
      }
      const query = this.sourceQuery(entry, page)
      const response = await this.callSource(() => source.fetchGap(query), query)
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
      entry.freshUnavailable = freshUnavailable
      const observeUnavailable = () => {
        if (result.unavailable) {
          const observed = this.unavailable(query, result)
          unavailable.push(...observed); freshUnavailable.push(...observed)
        }
      }
      const persist = async () => {
        // The physical write and its facts settle even if all demand stops.
        await this.write(records, { ...clone(selected), ...page, priority: query.getPriority() })
        // A hold can arrive after this page started or be cancelled while
        // its admitted durable write drains. Both still own this checkpoint.
        const holders = [...group.tasks].map(id => this.tasks.get(id)).filter(task => task && this.heldDownloads.has(task.id)
          && (!terminal.has(task.status) || this.controls.has(task.id)))
        for (const task of holders) {
          const fetched = records.filter(row => row.timestamp >= task.from && row.timestamp <= task.through)
            .map(row => ({ from: row.timestamp, through: row.timestamp }))
          this.heldDownloads.set(task.id, merged([...this.heldDownloads.get(task.id), ...fetched], step))
        }
        this.invalidate({ ...query, from: Math.min(...records.map(row => row.timestamp)), through: Math.max(...records.map(row => row.timestamp)) })
        for (const task of participants) task.writtenRecords += records.filter(row => row.timestamp >= task.from && row.timestamp <= task.through).length
        observeUnavailable()
      }
      const assessWrite = async () => {
        // This source read can stop after its demand is withdrawn. A stopped
        // consumer separately verifies its accepted write with a bounded read.
        const checked = await this.missing(query, selected.priority, undefined, { signal, returnCoverage: true })
        // Another reader may have dirtied or replaced the result while this
        // continuation was waiting. Requeue instead of using mixed snapshots.
        if (checked.coverage.dirty.length || this.coverageChecks.get(group.key) !== checked.coverage) return
        const after = checked.ranges
        for (const task of participants) if (!terminal.has(task.status)) task.status = this.holds.has(task.id) && !this.rechecks.has(task.id) ? 'waiting' : 'queued'
        this.assess(group, unavailable, [checked.coverage], freshUnavailable)
        if (slots(subtract(after, selected.unavailableRanges, step), step) >= before && this.demands(group).some(task => intersects(task, page))) throw new Error('The history source made no persisted coverage progress.')
        for (const task of participants) if (!terminal.has(task.status)) { task.attempts = 0; task.lastError = null }
      }
      if (records.length) {
        entry.writing = true
        entry.writePromise = persist()
        try { await entry.writePromise; await assessWrite() } finally { entry.writing = false }
      } else { observeUnavailable(); await assessWrite() }

    } catch (error) {
      if (signal.aborted || this.closed) {
        for (const task of this.demands(group)) if (task.status === 'running') task.status = 'queued'
        return
      }
      for (const task of this.demands(group).filter(task => (!entry.bounds || !this.holds.has(task.id)) && (!entry.bounds || intersects(task, entry.bounds)))) {
        task.attempts++; task.lastError = error instanceof Error ? error.message : String(error)
        task.status = task.attempts >= this.maxAttempts ? 'paused' : 'retry'
        if (task.status === 'paused') this.holds.delete(task.id)
        const now = this.now(), retryAt = Number.isSafeInteger(error?.retryAt) ? error.retryAt : 0
        const retryAfter = Number.isFinite(error?.retryAfter) && error.retryAfter >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(now + error.retryAfter)) : 0
        task.nextAttemptAt = task.status === 'retry' ? Math.max(retryAt, retryAfter,
          now + Math.min(this.maxRetryDelayMS, this.retryBaseMS * 2 ** Math.min(30, task.attempts - 1))) : null
        this.notify(task); this.settle(task)
      }
      try { await this.onError?.(error, this.getTask(initial[0]?.id)) } catch { /* Observers cannot stop acquisition. */ }
    }
  }

  assess(group, unavailable, coverage = [this.coverageChecks.get(group.key)], freshUnavailable = unavailable) {
    for (const task of this.demands(group)) {
      // A released hold cannot use an in-flight page's older source proof.
      if (this.rechecks.has(task.id)) continue
      // A newly admitted consumer outside this coverage read remains queued.
      const cached = coverage.find(value => value && !value.dirty.length && task.from >= value.from && task.through <= value.through)
      if (!cached) continue
      const proof = this.isolated.has(task.id) ? [...task.unavailableRanges, ...freshUnavailable] : unavailable
      this.measure(task, cached, proof)
      // Coverage ranges are replaced via clipped/merged/subtract, never
      // mutated. Holds share them and retain only an independent dirty list.
      if (this.heldDownloads.has(task.id)) this.heldCoverage.set(task.id, { ...cached, dirty: cached.dirty.map(value => ({ ...value })) })
      const step = intervals[task.timeframe]
      if (this.holds.has(task.id)) task.status = 'waiting'
      else if (!subtract(task.remaining, task.unavailableRanges, step).length) {
        task.status = task.remaining.length ? 'unavailable' : 'completed'; task.nextAttemptAt = null; task.attempts = 0; task.lastError = null
      }
      this.notify(task); this.settle(task)
    }
  }
  measure(task, cached, unavailable) {
    if (!cached || task.from < cached.from || task.through > cached.through) return
    const step = intervals[task.timeframe]
    task.remaining = merged(clipped([...cached.remaining, ...cached.leases.filter(lease => lease.expiresAt <= this.now())], task), step)
    task.unavailableRanges = [...new Map(clipped(unavailable, task).map(value => [JSON.stringify(value), value])).values()]
    const coveredLeases = subtract(merged(clipped(cached.leases.filter(lease => lease.expiresAt > this.now()), task), step), task.remaining, step)
    const unavailableMissing = [...task.remaining, ...coveredLeases].flatMap(portion => clipped(task.unavailableRanges, portion))
    task.coveredRecords = slots([task], step) - slots(task.remaining, step) - slots(coveredLeases, step)
    task.emptyRecords = slots(subtract(coveredLeases, task.unavailableRanges, step), step)
    task.unavailableRecords = slots(merged(unavailableMissing, step), step)
    if (this.heldDownloads.has(task.id)) {
      const numeric = subtract([task], merged([...task.remaining, ...coveredLeases], step), step)
      task.localRecords = slots(subtract(numeric, this.heldDownloads.get(task.id), step), step)
    } else if (!task.inspected) task.localRecords = task.coveredRecords
    task.inspected = true
  }
  notify(task) { task.updatedAt = this.now(); try { Promise.resolve(this.onProgress?.(clone(task))).catch(() => undefined) } catch { /* Detached observer. */ } }
  requestError(task) { return Object.assign(new Error(task.lastError), { retryAt: task.nextAttemptAt }) }
  settle(task) {
    const waiting = this.waiters.get(task.id) ?? [], remaining = []
    for (const waiter of waiting) {
      if (waiter.failFast && task.lastError) waiter.reject(this.requestError(task))
      else if (terminal.has(task.status) && !this.controls.has(task.id)) waiter.resolve(clone(task))
      else remaining.push(waiter)
    }
    if (remaining.length) this.waiters.set(task.id, remaining)
    else this.waiters.delete(task.id)
  }
  prune() {
    const finished = [...this.tasks.values()].filter(task => terminal.has(task.status) && !this.waiters.has(task.id) && !this.controls.has(task.id))
    for (const task of finished.slice(0, Math.max(0, finished.length - this.maxRetainedTerminalTasks))) { this.holds.delete(task.id); this.rechecks.delete(task.id); this.isolated.delete(task.id); this.heldDownloads.delete(task.id); this.heldCoverage.delete(task.id); this.tasks.delete(task.id); this.group(task).tasks.delete(task.id) }
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
    this.closing = (async () => {
      await this.started?.catch(() => undefined)
      await Promise.all([...this.active.values()].map(entry => entry.promise))
      await Promise.allSettled([...this.controls.values()])
      this.holds.clear(); this.rechecks.clear(); this.isolated.clear(); this.heldDownloads.clear(); this.heldCoverage.clear()
    })()
    return this.closing
  }
}
