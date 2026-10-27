import { randomUUID } from 'node:crypto'
import { CANDLE_INTERVALS } from './market-store.js'

const clone = value => structuredClone(value)
const count = (from, through, step) => Math.max(0, Math.floor((through - from) / step) + 1)
const message = error => error instanceof Error ? error.message : String(error)
export const emptyHistoryDownload = () => ({
  schemaVersion: 2, phase: 'idle', startedAt: null, updatedAt: null, finishedAt: null,
  contracts: { completed: 0, total: 0 }, streams: { completed: 0, total: 0 },
  progress: { checked: 0, total: 0, available: 0, empty: 0, unavailable: 0, failed: 0, reused: 0, pending: 0 },
  active: [], failures: [], error: '',
})

/** A finite, explicit archive request. Checkpoints describe verified durable
 * source slots, not requests sent or bytes received. No work resumes on boot. */
export class HistoryDownload {
  constructor({ sync, metadata, onChange, now = Date.now, chunkSlots = 2400, concurrency = 4 }) {
    if (!Number.isSafeInteger(chunkSlots) || chunkSlots < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('Invalid history download limits.')
    Object.assign(this, { sync, metadata, onChange, now, chunkSlots, concurrency })
    const saved = metadata.getHistoryDownload()
    // Old combined absence counters cannot be split without source evidence.
    // Retire that report; a fresh explicit run still reuses all durable values.
    this.report = saved?.schemaVersion === 2 ? saved : emptyHistoryDownload()
    if (saved && saved.schemaVersion !== 2) metadata.saveHistoryDownload(this.report)
    this.active = new Map()
    this.job = null
    this.timer = null
    this.closed = false
    if (this.report.phase === 'running') {
      this.report.phase = 'cancelled'; this.report.finishedAt = now(); this.report.updatedAt = now()
      this.report.active = []; this.report.error = 'The application stopped. Start a new download to continue from saved data.'
      metadata.saveHistoryDownload(this.report)
    }
  }

  snapshot() { return clone(this.report) }

  publish(immediate = false) {
    const flush = () => {
      clearTimeout(this.timer); this.timer = null
      this.report.updatedAt = this.now()
      try { this.metadata.saveHistoryDownload(this.report) }
      catch (error) {
        this.report.error = `Could not save download progress: ${message(error)}`
        if (this.job) {
          this.job.cancelled = true; this.job.failure = this.report.error
          for (const id of this.active.keys()) void this.sync.cancel(id).catch(() => undefined)
        }
        this.report.phase = 'failed'
      }
      try { this.onChange?.(this.snapshot()) } catch { /* UI observers cannot stop a download. */ }
    }
    if (immediate) flush()
    else this.timer ??= setTimeout(flush, 100)
  }

  start(instruments) {
    if (this.closed) throw new Error('History downloader is closed.')
    if (this.job) return this.snapshot()
    this.active.clear()
    const startedAt = this.now(), streams = [], failures = []
    const unique = [...new Map(instruments.map(instrument => [instrument.instId, instrument])).values()]
    for (const instrument of unique) {
      const listing = Number(instrument.listTime)
      if (!Number.isSafeInteger(listing) || listing <= 0 || listing > startedAt) {
        failures.push({ instrument: instrument.instId, timeframe: '', source: '', from: 0, through: startedAt, error: 'A valid listing time is required to determine the full history range.' })
        continue
      }
      for (const [timeframe, step] of Object.entries(CANDLE_INTERVALS)) {
        const from = Math.ceil(listing / step) * step, through = Math.floor(startedAt / step) * step - step
        for (const source of ['candles', 'oi', 'taker']) streams.push({ instrument: instrument.instId, timeframe, source, from, through, step, available: 0, empty: 0, unavailable: 0, failed: 0, reused: 0, done: false })
      }
    }
    this.report = { ...emptyHistoryDownload(), id: randomUUID(), phase: 'running', startedAt,
      contracts: { completed: 0, total: unique.length }, streams: { completed: 0, total: streams.length },
      progress: { ...emptyHistoryDownload().progress, total: streams.reduce((sum, stream) => sum + count(stream.from, stream.through, stream.step), 0) },
      failures, error: unique.length ? '' : 'No currently qualified contracts are available. Wait for qualification or update the saved conditions.' }
    this.report.progress.pending = this.report.progress.total
    const job = { streams, cancelled: false, failure: '', promise: null }
    this.job = job
    this.publish(true)
    // Allow start to return immediately with its immutable denominator.
    job.promise = Promise.resolve().then(() => this.run(job)).catch(error => {
      this.report.phase = 'failed'; this.report.error = message(error)
    }).finally(() => {
      this.active.clear(); this.report.finishedAt = this.now(); this.report.active = []
      this.job = null; this.publish(true)
    })
    return this.snapshot()
  }

  observe(task) {
    const item = this.active.get(task.id)
    if (!item) return
    item.task = task
    this.update()
    this.publish()
  }

  update() {
    const streams = this.job?.streams ?? []
    const progress = this.report.progress
    progress.available = streams.reduce((sum, value) => sum + value.available, 0)
    progress.empty = streams.reduce((sum, value) => sum + value.empty, 0)
    progress.unavailable = streams.reduce((sum, value) => sum + value.unavailable, 0)
    progress.failed = streams.reduce((sum, value) => sum + value.failed, 0)
    progress.reused = streams.reduce((sum, value) => sum + value.reused, 0)
    for (const { task } of this.active.values()) {
      progress.available += task.coveredRecords ?? 0
      progress.empty += task.emptyRecords ?? 0
      progress.unavailable += task.unavailableRecords ?? 0
      progress.reused += Math.min(task.localRecords ?? 0, task.coveredRecords ?? 0)
    }
    progress.checked = progress.available + progress.empty + progress.unavailable
    progress.pending = Math.max(0, progress.total - progress.checked - progress.failed)
    this.report.streams.completed = streams.filter(stream => stream.done).length
    const byInstrument = new Map()
    for (const stream of streams) {
      const values = byInstrument.get(stream.instrument) ?? []
      values.push(stream); byInstrument.set(stream.instrument, values)
    }
    this.report.contracts.completed = [...byInstrument.values()].filter(values => values.every(stream => stream.done)).length
    this.report.active = [...this.active.values()].map(({ task }) => ({ instrument: task.instrument, timeframe: task.timeframe, source: task.source,
      from: task.from, through: task.through, status: task.status, attempts: task.attempts, nextAttemptAt: task.nextAttemptAt, error: task.lastError ?? '' }))
  }

  async run(job) {
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(this.concurrency, job.streams.length) }, async () => {
      while (!job.cancelled && cursor < job.streams.length) {
        const stream = job.streams[cursor++]
        let attempt = null
        try {
          for (let through = stream.through; through >= stream.from && !job.cancelled;) {
            const from = Math.max(stream.from, through - (this.chunkSlots - 1) * stream.step)
            attempt = { from, through, checked: 0 }
            const task = await this.sync.enqueue({ instrument: stream.instrument, timeframe: stream.timeframe, source: stream.source, from, through, priority: 'background' })
            let result
            try {
              this.active.set(task.id, { stream, task: this.sync.getTask(task.id) ?? task })
              this.update(); this.publish()
              if (job.cancelled) await this.sync.cancel(task.id)
              result = await this.sync.waitFor(task.id)
            } finally {
              // A fatal scheduler error can reject the waiter after earlier
              // pages committed. Keep the last verified durable checkpoint.
              const checkpoint = result ?? this.sync.getTask(task.id) ?? this.active.get(task.id)?.task
              stream.available += checkpoint?.coveredRecords ?? 0
              stream.empty += checkpoint?.emptyRecords ?? 0
              stream.unavailable += checkpoint?.unavailableRecords ?? 0
              stream.reused += Math.min(checkpoint?.localRecords ?? 0, checkpoint?.coveredRecords ?? 0)
              attempt.checked = (checkpoint?.coveredRecords ?? 0) + (checkpoint?.emptyRecords ?? 0) + (checkpoint?.unavailableRecords ?? 0)
              this.active.delete(task.id)
              this.update(); this.publish()
            }
            if (job.cancelled) break
            if (!['completed', 'unavailable'].includes(result.status)) throw new Error(result.lastError || `Source task ${result.status}.`)
            through = from - stream.step
            attempt = null
          }
          if (!job.cancelled) stream.done = true
        } catch (error) {
          if (!job.cancelled) {
            // Only this attempted chunk failed. Older chunks which were never
            // admitted remain pending; failure establishes no source absence.
            if (attempt) stream.failed += Math.max(0, count(attempt.from, attempt.through, stream.step) - attempt.checked)
            this.report.failures.push({ instrument: stream.instrument, timeframe: stream.timeframe, source: stream.source,
              from: attempt?.from ?? stream.from, through: attempt?.through ?? stream.through, error: message(error) })
          }
        }
        this.update(); this.publish()
      }
    }))
    this.update()
    this.report.phase = job.failure ? 'failed' : job.cancelled ? 'cancelled' : this.report.failures.length || this.report.error ? 'failed' : 'completed'
  }

  async cancel() {
    const job = this.job
    if (!job) return this.snapshot()
    job.cancelled = true
    await Promise.all([...this.active.keys()].map(id => this.sync.cancel(id)))
    await job.promise
    return this.snapshot()
  }

  async close() {
    this.closed = true
    await this.cancel()
    clearTimeout(this.timer); this.timer = null
  }
}
