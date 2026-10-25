import { createOperationWorker, createOperationProcess, createWorkerRequest } from './worker-operations.js'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANDLE_INTERVALS, validateQuery } from './market-records.js'
export { CANDLE_INTERVALS, validateCandle } from './market-records.js'

const keyOf = (instrument, timeframe) => `${instrument}:${timeframe}`
const priorityRank = value => ({ interactive: 5, foreground: 4, prepared: 4, repair: 4, continuity: 3, statistics: 2, prefetch: 1, chartWarm: 1, background: 0 })[value] ?? 0
const PRIORITY_BUCKET_COUNT = 6

function emptyPriorityBuckets() {
  return Array.from({ length: PRIORITY_BUCKET_COUNT }, () => ({ head: null, tail: null }))
}

function enqueue(buckets, job) {
  const bucket = buckets[job.rank]
  const node = { job, next: null }
  if (bucket.tail) bucket.tail.next = node
  else bucket.head = node
  bucket.tail = node
}

function dequeue(bucket) {
  const node = bucket.head
  if (!node) return null
  bucket.head = node.next
  if (!bucket.head) bucket.tail = null
  return node.job
}

/** A bounded set of database connections; SQLite work never runs on Electron's event loop. */
class DatabaseWorkers {
  constructor(workers, onMutation) {
    this.workers = workers
    this.onMutation = onMutation
    this.buckets = emptyPriorityBuckets()
    this.queuedCount = 0
    this.tasks = new Set()
    this.nextID = 0
    this.foregroundBurst = 0
    this.failed = null
    this.closing = false
    this.metrics = { requests: 0, completed: 0, failed: 0, maximumQueued: 0, rowsReturned: 0, durationMS: 0 }
    for (const worker of workers) {
      worker.busy = false
      worker.on('message', message => {
        if (message.ready) return
        const job = worker.current
        if (!job || job.id !== message.id) return
        worker.current = null; worker.busy = false
        if (message.error) {
          this.metrics.failed += 1
          const error = new Error(message.error.message); error.name = message.error.name; error.code = message.error.code
          job.reject(error)
        } else {
          this.metrics.completed += 1; this.metrics.durationMS += message.durationMS ?? 0
          if (Array.isArray(message.result)) this.metrics.rowsReturned += message.result.length
          if (message.mutations?.length) this.onMutation?.(message.mutations, message.durationMS)
          job.resolve(message.result)
        }
        this.drain()
        if (!worker.busy) worker.unref()
      })
      worker.on('error', error => this.fail(error))
      worker.on('exit', code => { if (!this.closing) this.fail(new Error(`Market database worker exited (${code}).`)) })
      worker.unref()
    }
  }
  fail(error) {
    this.failed = error
    for (const worker of this.workers) { worker.current?.reject(error); worker.current = null; worker.busy = false }
    while (this.queuedCount) {
      let rank = -1, oldestID = Infinity
      for (let candidate = 0; candidate < PRIORITY_BUCKET_COUNT; candidate += 1) {
        const job = this.buckets[candidate].head?.job
        if (job && job.id < oldestID) { rank = candidate; oldestID = job.id }
      }
      dequeue(this.buckets[rank]).reject(error)
      this.queuedCount -= 1
    }
  }
  request(command, args = [], priority = 'background') {
    if (this.failed) return Promise.reject(this.failed)
    const task = new Promise((resolve, reject) => {
      const request = createWorkerRequest('market-store', command, resolve, reject, { priority })
      enqueue(this.buckets, { id: ++this.nextID, command, args, priority, rank: priorityRank(priority), ...request })
      this.queuedCount += 1
      this.metrics.requests += 1; this.metrics.maximumQueued = Math.max(this.metrics.maximumQueued, this.queuedCount)
      this.drain()
    })
    this.tasks.add(task)
    task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }
  drain() {
    for (const worker of this.workers) {
      if (worker.busy || !this.queuedCount) continue
      let rank = -1
      if (this.foregroundBurst >= 8) {
        let oldestLowPriorityID = Infinity
        for (let candidate = 0; candidate < 3; candidate += 1) {
          const job = this.buckets[candidate].head?.job
          if (job && job.id < oldestLowPriorityID) { rank = candidate; oldestLowPriorityID = job.id }
        }
      }
      if (rank < 0) {
        for (let candidate = PRIORITY_BUCKET_COUNT - 1; candidate >= 0; candidate -= 1) {
          if (this.buckets[candidate].head) { rank = candidate; break }
        }
      }
      const job = dequeue(this.buckets[rank])
      this.queuedCount -= 1
      this.foregroundBurst = job.rank >= 3 ? this.foregroundBurst + 1 : 0
      worker.busy = true; worker.current = job; worker.ref()
      try { job.dispatch(worker, { id: job.id, command: job.command, args: job.args }) }
      catch (error) { worker.current = null; worker.busy = false; worker.unref(); job.reject(error); queueMicrotask(() => this.drain()) }
    }
  }
  async close() {
    // The owner joins admitted work before calling this method.
    await Promise.allSettled([...this.tasks])
    this.closing = true
    try {
      await Promise.all(this.workers.map(worker => new Promise((resolve, reject) => {
        const id = ++this.nextID
        const request = createWorkerRequest('market-store', 'close', resolve, reject)
        worker.current = { id, ...request }; worker.busy = true; worker.ref()
        request.dispatch(worker, { id, command: 'close', args: [] })
      })))
    } finally { await Promise.all(this.workers.map(worker => worker.terminate())) }
  }
}

async function createDatabaseWorker(path, reader = false) {
  const worker = createOperationWorker(new URL('./market-store-worker.js', import.meta.url), { workerData: { path, reader } }, reader ? 'market-reader' : 'market-writer')
  await new Promise((resolve, reject) => {
    const ready = message => { if (message.ready) { worker.off('error', reject); worker.off('message', ready); resolve() } }
    worker.on('message', ready); worker.once('error', reject)
  })
  return worker
}

export class MarketStore {
  static async open(root) {
    await mkdir(root, { recursive: true })
    const path = join(root, 'market.sqlite'), writer = await createDatabaseWorker(path)
    let readers
    try { readers = await Promise.all([createDatabaseWorker(path, true), createDatabaseWorker(path, true)]) }
    catch (error) { await writer.terminate(); throw error }
    const store = new MarketStore(root, path, writer, readers)
    // Scanning/importing the previous storage is asynchronous and resumable.
    // The application can display current prices while this migration runs.
    store.migrationReady = store.startMigration().catch(error => { store.migrationError = error })
    return store
  }

  constructor(root, path, writer, readers) {
    this.root = root; this.path = path; this.closed = false; this.closeTask = null
    this.revisions = new Map(); this.priceRevisions = new Map(); this.mutations = new Map(); this.operations = new Set()
    this.listeners = new Set(); this.migration = null; this.migrationPending = new Map(); this.migrationWrites = new Set(); this.nextMigrationID = 0
    this.writeMetrics = { partitions: 0, rowsSubmitted: 0, bytesRead: 0, bytesWritten: 0, durationMS: 0 }
    this.writer = new DatabaseWorkers([writer], (mutations, duration) => this.committed(mutations, duration))
    this.readers = new DatabaseWorkers(readers)
    this.workerThreadIds = { writer: writer.threadId, readers: readers.map(worker => worker.threadId) }
  }

  operation(callback) {
    if (this.closed) return Promise.reject(new Error('MarketStore is closed.'))
    const task = Promise.resolve().then(callback)
    this.operations.add(task)
    task.then(() => this.operations.delete(task), () => this.operations.delete(task))
    return task
  }

  committed(changes, duration = 0) {
    this.writeMetrics.durationMS += duration
    for (const change of changes) {
      const key = keyOf(change.instrument, change.timeframe), revision = (this.revisions.get(key) ?? 0) + 1
      this.revisions.set(key, revision)
      if (change.priceFrom !== null) this.priceRevisions.set(key, (this.priceRevisions.get(key) ?? 0) + 1)
      const journal = this.mutations.get(key) ?? []
      journal.push({ revision, range: { from: change.from, through: change.through } })
      if (journal.length > 256) journal.shift()
      this.mutations.set(key, journal)
      for (const listener of this.listeners) { try { listener({ ...change, revision }) } catch { /* Observers cannot interrupt a durable commit. */ } }
    }
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  candleRevision(instrument, timeframe) { return this.revisions.get(keyOf(instrument, timeframe)) ?? 0 }
  candlePriceRevision(instrument, timeframe) { return this.priceRevisions.get(keyOf(instrument, timeframe)) ?? 0 }
  candleChangesSince(instrument, timeframe, previousRevision) {
    const revision = this.candleRevision(instrument, timeframe)
    if (previousRevision === revision) return { revision, ranges: [] }
    const changes = this.mutations.get(keyOf(instrument, timeframe)) ?? []
    if (!Number.isSafeInteger(previousRevision) || previousRevision < 0 || previousRevision > revision || !changes.length || previousRevision < changes[0].revision - 1) return { revision, ranges: null }
    const ranges = []
    for (const value of changes.filter(change => change.revision > previousRevision).map(change => change.range).sort((a, b) => a.from - b.from)) {
      const previous = ranges.at(-1)
      if (previous && value.from <= previous.through) previous.through = Math.max(previous.through, value.through)
      else ranges.push({ ...value })
    }
    return { revision, ranges }
  }
  getWriteMetrics() { return { ...this.writeMetrics } }
  getDiagnostics() { return { workerThreadIds: this.workerThreadIds, reads: { ...this.readers.metrics, queued: this.readers.queuedCount }, writes: { ...this.writer.metrics, queued: this.writer.queuedCount }, migrationComplete: this.migrationComplete ?? false, migrationProcessId: this.migration?.pid ?? null } }

  async startMigration() {
    if (await this.writer.request('migrationState', ['__complete__'])) { this.migrationComplete = true; return }
    try { if (!(await stat(join(this.root, 'candles'))).isDirectory()) return }
    catch (error) { if (error.code === 'ENOENT') { this.migrationComplete = true; return } throw error }
    if (this.closed) return
    // DuckDB's native addon cannot safely survive worker-thread termination.
    // A process owns its native lifetime; SQLite transactions remain here.
    const child = createOperationProcess(fileURLToPath(new URL('./market-store-migration.js', import.meta.url)), [this.root, this.path], {
      execPath: process.execPath, execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }, 'market-migration')
    this.migration = child
    let stderr = ''
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-4096) })
    const reply = message => { if (child.connected) child.send(message, () => {}) }
    const commit = (task, sequence, accepted) => {
      this.migrationWrites.add(task)
      task.then(() => { accepted?.(); reply({ ack: sequence }) }, error => reply({ ack: sequence, error: error.message }))
        .finally(() => this.migrationWrites.delete(task))
    }
    child.on('message', message => {
      if (this.closed && message.sequence) { reply({ ack: message.sequence, error: 'MarketStore is closed.' }); return }
      if (message.import) {
        const { rows, partition } = message.import
        commit(this.writer.request('append', [rows, { importing: true, partition }], message.priority), message.sequence,
          () => { this.writeMetrics.partitions += 1; this.writeMetrics.rowsSubmitted += rows.length })
      } else if (message.failure) {
        commit(this.writer.request('migrationFailure', [message.failure]), message.sequence)
      } else if (message.complete) {
        commit(this.writer.request('migrationComplete'), message.sequence, () => {
          this.migrationComplete = true
          this.migrationWarning = ''
          for (const pending of this.migrationPending.values()) pending.resolve()
          this.migrationPending.clear()
        })
      } else if (message.warning) this.migrationWarning = message.warning
      else if (message.id) {
        const pending = this.migrationPending.get(message.id)
        if (pending) { this.migrationPending.delete(message.id); message.error ? pending.reject(new Error(message.error)) : pending.resolve() }
      }
    })
    child.on('error', error => {
      if (this.migrationComplete) { this.migrationWarning = error.message; return }
      this.migrationError = error
      for (const task of this.migrationPending.values()) task.reject(error)
      this.migrationPending.clear()
    })
    this.migrationExit = new Promise(resolve => child.once('close', (code, signal) => {
      if (this.migration === child) this.migration = null
      if (!this.closed && !this.migrationComplete) {
        const error = new Error(`Market archive importer exited before a successful cutover (${signal ?? code}).${stderr ? ` ${stderr.trim()}` : ''}`)
        this.migrationError = error
        for (const task of this.migrationPending.values()) task.reject(error)
        this.migrationPending.clear()
      } else if (!this.closed && (code !== 0 || signal)) this.migrationWarning = `Market archive importer stopped after durable cutover (${signal ?? code}).`
      resolve({ code, signal })
    }))
    child.unref(); child.channel?.unref(); child.stderr.unref?.()
  }

  async imported(query, priority, tolerateIssues = false) {
    await this.migrationReady
    if (this.closed) throw new Error('MarketStore is closed.')
    if (this.migrationComplete) return
    if (this.migrationError) throw this.migrationError
    if (!this.migration) return
    const child = this.migration
    const id = ++this.nextMigrationID
    await new Promise((resolve, reject) => {
      const request = createWorkerRequest('market-migration', 'import', resolve, reject, { priority })
      this.migrationPending.set(id, request)
      child.ref(); child.channel?.ref()
      request.dispatch(child, { id, query: validateQuery(query), priority: priorityRank(priority) >= 3 ? 'foreground' : 'background', tolerateIssues }, error => {
        if (!error) return
        this.migrationPending.delete(id); request.reject(error)
      })
    })
    if (!this.migrationPending.size) { child.unref(); child.channel?.unref() }
  }

  read(command, query, priority = 'background', ...args) {
    return this.operation(async () => {
      validateQuery(query)
      // Metadata describes committed SQLite facts. Asking for a watermark or
      // a current tail must never make the viewport wait for the full archive.
      if (!['coverage', 'watermark', 'checkpointRead'].includes(command)) await this.imported(query, priority, command === 'inspect')
      return this.readers.request(command, [query, ...args], priority)
    })
  }
  appendCandles(candles, priority = 'background') {
    return this.operation(async () => {
      let result = 0
      if (candles.length > 2_048) {
        // Validate the entire logical batch before the first bounded transaction.
        await this.writer.request('validateCandles', [candles], priority)
        for (let offset = 0; offset < candles.length; offset += 2_048) result += await this.writer.request('append', [candles.slice(offset, offset + 2_048)], priority)
      } else result = await this.writer.request('append', [candles], priority)
      this.writeMetrics.rowsSubmitted += candles.length
      return result
    })
  }
  replaceCandles(query, candles, priority = 'background') {
    return this.operation(async () => {
      const range = validateQuery(query), step = CANDLE_INTERVALS[range.timeframe]
      if (range.from % step || range.through % step || !Array.isArray(candles)) throw new TypeError('Repair range must lie on the candle grid.')
      for (const candle of candles) if (candle.instrument !== range.instrument || candle.timeframe !== range.timeframe || candle.timestamp < range.from || candle.timestamp > range.through) throw new TypeError('Replacement candle lies outside its repair range.')
      return this.writer.request('append', [candles, { replacement: range }], priority)
    })
  }
  aggregateCandles(query, priority = 'background') {
    return this.operation(() => {
      if (!query || typeof query !== 'object' || !Object.hasOwn(query, 'from') || !Object.hasOwn(query, 'through')) {
        throw new TypeError('Candle aggregation requires an explicit parent range.')
      }
      const range = validateQuery(query), step = CANDLE_INTERVALS[range.timeframe]
      if (!['15m', '1H'].includes(range.timeframe) || range.from % step || range.through % step
        || query.invalidateIncomplete !== undefined && typeof query.invalidateIncomplete !== 'boolean') {
        throw new TypeError('Invalid candle aggregation range.')
      }
      return this.writer.request('aggregateCandles', [{ ...range, invalidateIncomplete: query.invalidateIncomplete === true }], priority)
    })
  }
  appendStatistics(input, priority = 'background') { return this.operation(() => this.writer.request('appendStatistics', [input], priority)) }
  candles(query, priority = 'background') { return this.read('candles', query, priority) }
  statistics(query, priority = 'background') { return this.read('statistics', query, priority) }
  coverage(instrument, timeframe, priority = 'background') { return this.read('coverage', { instrument, timeframe }, priority) }
  candleWatermark(instrument, timeframe, priority = 'background') { return this.read('watermark', { instrument, timeframe }, priority, false) }
  priceWatermark(instrument, timeframe, priority = 'background') { return this.read('watermark', { instrument, timeframe }, priority, true) }
  missingCandleRanges(query, priority = 'background') {
    const timeframe = query.timeframe ?? '5m'
    if (query.intervalMS !== undefined && query.intervalMS !== CANDLE_INTERVALS[timeframe]) return Promise.reject(new TypeError('Candle interval must match timeframe.'))
    return this.read('missingRanges', { ...query, timeframe }, priority, 'candles')
  }
  statisticsMissingRanges(query, priority = 'background') { return this.read('missingRanges', query, priority, query.source) }
  inspectCandles(query, priority = 'background') { return this.read('inspect', query, priority) }
  integrityCheck() { return this.operation(() => this.readers.request('integrity')) }
  migrationStatus() { return this.operation(async () => { await this.migrationReady; const report = await this.readers.request('migrationReport'); return { ...report, complete: this.migrationComplete || report.complete, error: this.migrationError?.message ?? this.migrationWarning ?? '' } }) }
  readIndicatorCheckpoint(query, priority = 'background') { return this.read('checkpointRead', { ...query, through: query.before }, priority) }
  writeIndicatorCheckpoint(query, priority = 'background') { return this.operation(() => this.writer.request('checkpointWrite', [query], priority)) }

  close() {
    if (this.closeTask) return this.closeTask
    this.closed = true
    this.closeTask = (async () => {
      await this.migrationReady?.catch(() => undefined)
      // A read must not make shutdown finish a multi-year archive migration.
      // Only already admitted durable transactions must drain before exit.
      if (this.migration) {
        const child = this.migration
        for (const pending of this.migrationPending.values()) pending.reject(new Error('MarketStore is closed.'))
        this.migrationPending.clear()
        child.ref(); child.channel?.ref()
        if (child.connected) child.send({ stop: true }, () => {})
        // No new importer writes are admitted after closed=true. Finish every
        // transaction already accepted before stopping native archive reads.
        await Promise.allSettled([...this.migrationWrites])
        const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
        try { await this.migrationExit } finally { clearTimeout(timeout) }
      }
      await Promise.allSettled([...this.operations])
      await this.readers.close()
      await this.writer.close()
    })()
    return this.closeTask
  }
}
