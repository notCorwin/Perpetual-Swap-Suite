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
    this.held = new Map()
    this.heldProgress = { available: 0, empty: 0, unavailable: 0, reused: 0 }
    this.job = null
    this.timer = null
    this.closed = false
    if (this.report.phase === 'running') {
      this.report.phase = 'cancelled'; this.report.finishedAt = now(); this.report.updatedAt = now()
      this.report.active = []; this.report.error = 'The application stopped. Start a new download to continue from saved data.'
      metadata.saveHistoryDownload(this.report)
    }
  }

  snapshot() { if (this.job) this.update(); return clone(this.report) }

  publish(immediate = false) {
    const flush = () => {
      clearTimeout(this.timer); this.timer = null
      if (this.job) this.update()
      this.report.updatedAt = this.now()
      try { this.metadata.saveHistoryDownload(this.report) }
      catch (error) {
        this.report.error = `Could not save download progress: ${message(error)}`
        if (this.job) {
          this.job.cancelled = true; this.job.failure = this.report.error
          for (const id of [...this.active.keys(), ...this.held.keys()]) void this.sync.cancel(id).catch(() => undefined)
        }
        this.report.phase = 'failed'
      }
      try { this.onChange?.(clone(this.report)) } catch { /* UI observers cannot stop a download. */ }
    }
    if (immediate) flush()
    else this.timer ??= setTimeout(flush, 100)
  }

  start(instruments) {
    if (this.closed) throw new Error('History downloader is closed.')
    if (this.job) return this.snapshot()
    this.active.clear()
    this.held.clear()
    this.heldProgress = { available: 0, empty: 0, unavailable: 0, reused: 0 }
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
      this.active.clear(); this.held.clear(); this.report.finishedAt = this.now(); this.report.active = []
      this.job = null; this.publish(true)
    })
    return this.snapshot()
  }

  observe(task) {
    const held = this.held.get(task.id), item = this.active.get(task.id) ?? held
    if (!item) return
    if (held) this.adjustHeld(item.task, -1)
    item.task = task
    if (held) this.adjustHeld(task, 1)
    this.publish()
    if (task.status === 'waiting') item.onWaiting?.()
  }

  adjustHeld(task, direction) {
    this.heldProgress.available += direction * (task.coveredRecords ?? 0)
    this.heldProgress.empty += direction * (task.emptyRecords ?? 0)
    this.heldProgress.unavailable += direction * (task.unavailableRecords ?? 0)
    this.heldProgress.reused += direction * Math.min(task.localRecords ?? 0, task.coveredRecords ?? 0)
  }

  update() {
    const streams = this.job?.streams ?? []
    const progress = this.report.progress
    progress.available = streams.reduce((sum, value) => sum + value.available, 0)
    progress.empty = streams.reduce((sum, value) => sum + value.empty, 0)
    progress.unavailable = streams.reduce((sum, value) => sum + value.unavailable, 0)
    progress.failed = streams.reduce((sum, value) => sum + value.failed, 0)
    progress.reused = streams.reduce((sum, value) => sum + value.reused, 0)
    progress.available += this.heldProgress.available
    progress.empty += this.heldProgress.empty
    progress.unavailable += this.heldProgress.unavailable
    progress.reused += this.heldProgress.reused
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
    const states = job.streams.map(stream => ({ stream, through: stream.through, settledFrom: null, terminal: false, running: false, queued: false, pending: null }))
    const fine = new Map(states.filter(({ stream }) => stream.source === 'candles' && stream.timeframe === '5m').map(state => [state.stream.instrument, state]))
    const parents = new Map()
    for (const state of states) if (state.stream.source === 'candles' && state.stream.timeframe !== '5m') {
      const values = parents.get(state.stream.instrument) ?? []
      values.push(state); parents.set(state.stream.instrument, values)
    }
    for (const state of states) if (state.through < state.stream.from) { state.terminal = true; state.stream.done = true }
    const ready = [], active = new Set()
    let head = 0
    const schedule = state => {
      if (job.cancelled || state.terminal || state.running || state.queued) return
      state.queued = true; ready.push(state)
    }
    const readyForSource = (state, bounds) => {
      const child = fine.get(state.stream.instrument)
      if (!child || child.terminal) return true
      // Require every fine child of every parent in this bounded page. A
      // boundary parent spanning two fine pages waits for both to settle.
      return child.settledFrom !== null && child.settledFrom <= bounds.from
        && child.stream.through >= bounds.through + state.stream.step - child.stream.step
    }
    const wakeParents = child => {
      if (child.stream.source !== 'candles' || child.stream.timeframe !== '5m') return
      for (const parent of parents.get(child.stream.instrument) ?? []) if (parent.pending
        && (parent.pending.settled || readyForSource(parent, parent.pending.bounds))) schedule(parent)
    }
    const runPage = async state => {
      const { stream } = state
      let pending = state.pending
      const bounds = pending?.bounds ?? { from: Math.max(stream.from, state.through - (this.chunkSlots - 1) * stream.step), through: state.through }
      const { from, through } = bounds
      const attempt = { from, through, checked: 0 }
      let releaseError = null
      try {
        if (!pending) {
          const hold = stream.source === 'candles' && stream.timeframe !== '5m' && !readyForSource(state, bounds)
          const task = await this.sync.enqueue({ instrument: stream.instrument, timeframe: stream.timeframe, source: stream.source, from, through, priority: 'background' }, { hold })
          let onWaiting
          const waiting = new Promise(resolve => { onWaiting = resolve })
          const item = { stream, task: this.sync.getTask(task.id) ?? task, onWaiting }
          pending = { id: task.id, bounds, item, waiting, settled: false, outcome: null }
          state.pending = pending
          pending.outcome = this.sync.waitFor(task.id).then(result => ({ result }), error => ({ error })).then(outcome => {
            pending.settled = true
            if (state.pending === pending) schedule(state)
            return outcome
          })
          this.active.set(task.id, item)
          this.update(); this.publish()
          if (job.cancelled) await this.sync.cancel(task.id)
          if (hold && !job.cancelled) {
            const first = await Promise.race([pending.waiting.then(() => 'waiting'), pending.outcome.then(() => 'settled')])
            if (first === 'waiting' && !pending.settled) {
              // A locally checked hold is not active network work and must
              // not consume a download slot or enlarge the UI active list.
              this.active.delete(task.id); this.held.set(task.id, item); this.adjustHeld(item.task, 1)
              this.update(); this.publish()
              return
            }
          }
        } else {
          const item = this.held.get(pending.id)
          if (item) {
            this.held.delete(pending.id); this.adjustHeld(item.task, -1); this.active.set(pending.id, item)
            this.update(); this.publish()
          }
          if (!pending.settled && readyForSource(state, bounds)) {
            try { this.sync.release(pending.id) }
            catch (error) {
              releaseError = error
              // A retired target may have removed the consumer already. If
              // it still exists, settle it before dropping this checkpoint.
              await this.sync.cancel(pending.id).catch(() => undefined)
            }
          }
        }
        let outcome
        try {
          outcome = await pending.outcome
          if (releaseError && !outcome.error) outcome = { error: releaseError }
        } finally {
          // A fatal scheduler error can reject the waiter after earlier pages
          // committed. Keep the last verified durable checkpoint.
          const checkpoint = outcome?.result ?? this.sync.getTask(pending.id) ?? this.active.get(pending.id)?.task
          stream.available += checkpoint?.coveredRecords ?? 0
          stream.empty += checkpoint?.emptyRecords ?? 0
          stream.unavailable += checkpoint?.unavailableRecords ?? 0
          stream.reused += Math.min(checkpoint?.localRecords ?? 0, checkpoint?.coveredRecords ?? 0)
          attempt.checked = (checkpoint?.coveredRecords ?? 0) + (checkpoint?.emptyRecords ?? 0) + (checkpoint?.unavailableRecords ?? 0)
          this.active.delete(pending.id); state.pending = null
          this.update(); this.publish()
        }
        if (job.cancelled) return
        if (outcome.error) throw outcome.error
        const result = outcome.result
        if (!['completed', 'unavailable'].includes(result.status)) throw new Error(result.lastError || `Source task ${result.status}.`)
        state.settledFrom = from
        state.through = from - stream.step
        if (state.through < stream.from) { state.terminal = true; stream.done = true }
      } catch (error) {
        if (!job.cancelled) {
          // Failed fine work releases its parent dependency, not source absence.
          // The parent checks local coverage and acquires its own missing slots.
          state.terminal = true
          stream.failed += Math.max(0, count(from, through, stream.step) - attempt.checked)
          this.report.failures.push({ instrument: stream.instrument, timeframe: stream.timeframe, source: stream.source,
            from, through, error: message(error) })
        }
      } finally {
        state.running = false
        this.update(); this.publish()
      }
    }
    for (const state of states) schedule(state)
    while (!job.cancelled) {
      while (active.size < this.concurrency && head < ready.length) {
        const state = ready[head++]; state.queued = false; state.running = true
        const task = runPage(state).finally(() => {
          active.delete(task)
          if (state.pending) {
            if (state.pending.settled || readyForSource(state, state.pending.bounds)) schedule(state)
          } else schedule(state)
          wakeParents(state)
        })
        active.add(task)
      }
      if (head > 1024 && head * 2 >= ready.length) { ready.splice(0, head); head = 0 }
      if (!active.size) {
        if (states.every(state => state.terminal)) break
        throw new Error('History download has blocked work without an active source.')
      }
      await Promise.race(active)
    }
    await Promise.all(active)
    // Cancellation also owns locally checked held consumers. Their final
    // checkpoints remain reportable without restarting their source work.
    for (const state of states) if (state.pending) {
      const pending = state.pending, item = this.held.get(pending.id)
      if (item) { this.held.delete(pending.id); this.adjustHeld(item.task, -1); this.active.set(pending.id, item) }
      state.running = true; await runPage(state)
    }
    this.update()
    this.report.phase = job.failure ? 'failed' : job.cancelled ? 'cancelled' : this.report.failures.length || this.report.error ? 'failed' : 'completed'
  }

  async cancel() {
    const job = this.job
    if (!job) return this.snapshot()
    job.cancelled = true
    // A target can be retired, or the scheduler closed, while cancellation
    // is being dispatched. Drain every other consumer and the job regardless.
    await Promise.allSettled([...this.active.keys(), ...this.held.keys()].map(id => this.sync.cancel(id)))
    await job.promise
    return this.snapshot()
  }

  async close() {
    this.closed = true
    await this.cancel()
    clearTimeout(this.timer); this.timer = null
  }
}
