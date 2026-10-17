import { createHash } from 'node:crypto'

const intervals = { '5m': 300_000, '15m': 900_000, '1H': 3_600_000 }
const statuses = new Set(['queued', 'running', 'retry', 'paused', 'cancelled', 'completed', 'unavailable'])
const terminal = new Set(['paused', 'cancelled', 'completed', 'unavailable'])
const expirable = new Set(['cancelled', 'completed', 'unavailable'])
const foregroundReady = Symbol('Foreground history is ready for the source lane.')
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
const key = task => createHash('sha256').update(JSON.stringify([task.instrument, task.timeframe, task.source, task.from, task.through])).digest('hex')
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
 * One source-request lane shared by background targets and foreground repairs.
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
    this.active = null
    this.lastRequestAt = null
    this.persistTail = Promise.resolve()
    this.fatalError = null
  }

  start() {
    if (this.closed) return Promise.reject(new Error('HistorySync is closed.'))
    if (!this.started) this.started = this.restore().then(() => { this.kick(); return this })
    return this.started
  }

  async restore() {
    const tasks = await this.metadata.listSyncTasks()
    if (!Array.isArray(tasks)) throw new TypeError('metadata.listSyncTasks must return an array.')
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
      if (task.id !== key(task)) throw new TypeError('Persisted history task ID does not match its target.')
      if (this.tasks.has(task.id)) throw new TypeError('Duplicate persisted history task ID.')
      this.tasks.set(task.id, task)
      if (task.status === 'running') {
        task.status = 'queued'
        task.nextAttemptAt = null
        await this.save(task)
      }
    }
    await this.pruneTerminalTasks()
  }

  async enqueue(input) {
    await this.start()
    this.assertOpen()
    const identity = descriptor(input)
    if (!this.sources.has(identity.source)) throw new TypeError(`History source is unavailable: ${identity.source}.`)
    const bounds = range(input, intervals[identity.timeframe])
    const requestedPriority = priority(input.priority ?? 'background')
    const purpose = input.purpose ?? 'requested'
    if (!['requested', 'history', 'warmup'].includes(purpose)) throw new TypeError('Invalid history purpose.')
    const id = key({ ...identity, ...bounds })
    // Foreground callers wait for their exact range, never a containing history
    // target. All tasks still share the lane and recheck Parquet before each page.
    let task = this.tasks.get(id) ?? (requestedPriority === 'background' ? [...this.tasks.values()].find(value => value.instrument === identity.instrument
      && value.timeframe === identity.timeframe && value.source === identity.source
      && value.from <= bounds.from && value.through >= bounds.through
      && ['queued', 'running', 'retry'].includes(value.status)) : undefined)
    if (task) {
      if (requestedPriority === 'foreground') task.priority = 'foreground'
      if (['paused', 'cancelled', 'completed'].includes(task.status)) {
        task.status = 'queued'
        task.attempts = 0
        task.nextAttemptAt = null
        task.lastError = null
      }
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
    const history = await this.enqueue({ ...identity, from, through, priority: input.priority, purpose: 'history' })
    const warmup = warmupCandles && from >= intervalMS
      ? await this.enqueue({ ...identity, from: Math.max(0, from - warmupCandles * intervalMS), through: from - intervalMS, priority: input.priority, purpose: 'warmup' })
      : null
    return { history, warmup }
  }

  getTask(id) {
    const task = this.tasks.get(text(id, 'task ID'))
    return task ? clone(task) : null
  }

  listTasks() { return [...this.tasks.values()].map(clone) }

  async pause(id) { return this.control(id, 'paused') }
  async cancel(id) { return this.control(id, 'cancelled') }

  async control(id, status) {
    await this.start()
    this.assertOpen()
    const task = this.requireTask(id)
    task.status = status
    task.nextAttemptAt = null
    if (this.active?.id === task.id) this.active.controller.abort()
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

  save(task) {
    task.updatedAt = this.timestamp()
    const snapshot = clone(task)
    const persistence = this.persistTail.then(() => this.metadata.putSyncTask(snapshot))
    this.persistTail = persistence.catch(() => undefined)
    return persistence.then(() => {
      try { Promise.resolve(this.onProgress?.(clone(snapshot))).catch(() => undefined) } catch { /* Observers cannot interrupt synchronization. */ }
    })
  }

  pruneTerminalTasks() {
    // Coordination checkpoints are not historical market data. Retain a
    // bounded recent result history; Parquet remains the coverage authority
    // when an expired target is requested again.
    const persistence = this.persistTail.then(async () => {
      const candidates = [...this.tasks.values()].reverse().filter(task => expirable.has(task.status)
        && task.id !== this.active?.id && !this.waiters.has(task.id))
        .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      for (const task of candidates.slice(this.maxRetainedTerminalTasks)) {
        if (this.tasks.get(task.id) !== task || !expirable.has(task.status)
          || task.id === this.active?.id || this.waiters.has(task.id)) continue
        // Remove before awaiting persistence so a concurrent enqueue creates a
        // fresh task whose save is ordered after this deletion.
        this.tasks.delete(task.id)
        try { await this.metadata.deleteSyncTask(task.id) }
        catch (error) { if (!this.tasks.has(task.id)) this.tasks.set(task.id, task); throw error }
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

  async missing(task) {
    const intervalMS = intervals[task.timeframe]
    const values = await this.store.missingCandleRanges({ instrument: task.instrument, timeframe: task.timeframe, source: task.source, from: task.from, through: task.through, intervalMS }, task.priority)
    if (!Array.isArray(values)) throw new TypeError('store.missingCandleRanges must return an array.')
    const sorted = values.map(value => range(value, intervalMS)).sort((a, b) => a.from - b.from)
    let previous = null
    for (const value of sorted) {
      if (value.from < task.from || value.through > task.through || (previous && value.from <= previous.through)) throw new TypeError('Store gaps must be disjoint and inside the requested range.')
      previous = value
    }
    task.remaining = sorted
    return subtract(sorted, task.unavailableRanges, intervalMS)
  }

  kick() {
    if (this.closed || this.fatalError) return
    clearTimeout(this.timer)
    this.timer = null
    if (this.draining) return
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
    while (!this.closed) {
      const timestamp = this.timestamp()
      const task = [...this.tasks.values()].filter(value => value.status === 'queued' || (value.status === 'retry' && value.nextAttemptAt <= timestamp))
        .sort((a, b) => Number(b.priority === 'foreground') - Number(a.priority === 'foreground') || a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
      if (!task) break
      await this.run(task)
    }
  }

  async callSource(operation, signal, task) {
    if (this.lastRequestAt !== null) await this.delay(Math.max(0, this.lastRequestAt + this.minRequestIntervalMS - this.timestamp()), signal)
    signal.throwIfAborted()
    // A foreground request may arrive during inspection or rate-limit pacing.
    // Yield before admitting the next HTTP call; an active page still finishes.
    if (task.priority === 'background' && [...this.tasks.values()].some(value => value.priority === 'foreground'
      && (value.status === 'queued' || (value.status === 'retry' && value.nextAttemptAt <= this.timestamp())))) throw foregroundReady
    this.lastRequestAt = this.timestamp()
    return operation()
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

  async run(task) {
    const controller = new AbortController(), { signal } = controller
    this.active = { id: task.id, controller }
    task.status = 'running'
    task.nextAttemptAt = null
    await this.save(task)
    try {
      let gaps = await this.missing(task)
      signal.throwIfAborted()
      const source = this.sources.get(task.source)
      if (gaps.length && source.inspect && !task.inspected) {
        const inspection = await this.callSource(() => source.inspect({ instrument: task.instrument, timeframe: task.timeframe, source: task.source, priority: task.priority, from: task.from, through: task.through, signal, cursor: task.cursor }), signal, task)
        signal.throwIfAborted()
        task.unavailableRanges.push(...this.unavailable(task, inspection))
        task.inspected = true
        gaps = await this.missing(task)
        signal.throwIfAborted()
        await this.save(task)
      }
      if (!gaps.length) return await this.finish(task)
      const intervalMS = intervals[task.timeframe]
      const gap = gaps.find(value => task.cursorRange && intersects(value, task.cursorRange)) ?? gaps[0]
      if (!task.cursorRange || gap.from !== task.cursorRange.from || gap.through !== task.cursorRange.through) {
        task.cursor = null
        task.cursorRange = clone(gap)
      }
      const before = slots(gaps, intervalMS)
      const response = await this.callSource(() => source.fetchGap({ instrument: task.instrument, timeframe: task.timeframe, source: task.source, priority: task.priority, ...gap, cursor: task.cursor, signal }), signal, task)
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
        await this.write(records, clone(task))
        task.writtenRecords += records.length
      }
      // A cancelled request cannot publish a cursor or completion state. Any
      // already admitted Parquet write is recovered by the next coverage read.
      signal.throwIfAborted()
      if (result.unavailable !== undefined) task.unavailableRanges.push(...this.unavailable({ ...task, ...gap }, result))
      const after = await this.missing(task)
      signal.throwIfAborted()
      if (Object.hasOwn(result, 'cursor')) {
        this.validateCursor(result.cursor)
        task.cursor = result.cursor
      } else task.cursor = null
      task.cursorRange = clone(after.find(value => intersects(value, gap)) ?? null)
      if (!task.cursorRange) task.cursor = null
      if (!after.length) return await this.finish(task)
      if (slots(after, intervalMS) >= before) throw new Error('The history source made no persisted coverage progress.')
      task.attempts = 0
      task.lastError = null
      task.status = 'queued'
      await this.save(task)
    } catch (error) {
      if (signal.aborted || error === foregroundReady) {
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
    } finally {
      this.active = null
      this.settle(task)
      await this.pruneTerminalTasks()
    }
  }

  async finish(task) {
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

  isIdle() { return !this.draining && ![...this.tasks.values()].some(task => ['queued', 'running', 'retry'].includes(task.status)) }

  settleIdle() {
    if (!this.isIdle()) return
    this.idleWaiters.splice(0).forEach(waiter => waiter.resolve())
  }

  fail(error) {
    this.fatalError = error
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
    this.active?.controller.abort()
    this.closing = (async () => {
      await this.started?.catch(() => undefined)
      await this.draining
      await this.persistTail
      const error = new Error('HistorySync is closed.')
      this.waiters.forEach(waiters => waiters.forEach(waiter => waiter.reject(error)))
      this.waiters.clear()
      this.idleWaiters.splice(0).forEach(waiter => waiter.reject(error))
    })()
    return this.closing
  }
}
