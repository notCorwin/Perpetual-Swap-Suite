import { randomUUID } from 'node:crypto'
import { setImmediate as yieldToBackground } from 'node:timers/promises'

const DAY = 86_400_000
const INTERVALS = { '5m': 300_000, '15m': 900_000, '1H': 3_600_000 }
const ACTIVE = new Set(['queued', 'running'])
const clone = value => structuredClone(value)
const message = error => error instanceof Error ? error.message : String(error)
const matches = (left, right) => left.instrument === right.instrument && left.timeframe === right.timeframe && left.source === right.source
const overlaps = (left, right) => matches(left, right) && left.from <= right.through && right.from <= left.through
const issueKey = issue => JSON.stringify([issue.instrument, issue.timeframe, issue.source, issue.from, issue.through, issue.reason, issue.file ?? null])
const rangeOf = issue => ({ instrument: issue.instrument, timeframe: issue.timeframe, source: issue.source, from: issue.from, through: issue.through })

function targetOf(target) {
  if (!target || typeof target !== 'object' || typeof target.instrument !== 'string' || !target.instrument.trim()) throw new TypeError('An audit target needs an instrument.')
  if (!Object.hasOwn(INTERVALS, target.timeframe)) throw new TypeError('Audit timeframe must be 5m, 15m, or 1H.')
  if (target.source !== undefined && target.source !== 'candles') throw new TypeError('Audit source must be candles.')
  if (!Number.isSafeInteger(target.from) || target.from < 0 || !Number.isSafeInteger(target.through) || target.through < target.from) throw new TypeError('An audit target needs an ordered, nonnegative integer range.')
  return { instrument: target.instrument, timeframe: target.timeframe, source: 'candles', from: target.from, through: target.through }
}

function findingsOf(result, target) {
  if (!result || !Array.isArray(result.issues) || !Number.isSafeInteger(result.checkedRows) || result.checkedRows < 0 || !Number.isSafeInteger(result.files) || result.files < 0) throw new TypeError('The audit inspector returned an invalid result.')
  const findings = [...result.issues]
  for (const range of result.missingRanges ?? []) {
    if (!findings.some(issue => issue.reason === 'gap' && issue.from <= range.from && issue.through >= range.through)) findings.push({ ...target, ...range, reason: 'gap', repairable: true })
  }
  const unique = new Map()
  for (const issue of findings) {
    const normalized = targetOf({ ...target, ...issue })
    const interval = INTERVALS[target.timeframe]
    const envelope = { ...target, from: Math.floor(target.from / interval) * interval, through: Math.min(Number.MAX_SAFE_INTEGER, Math.ceil((target.through + 1) / interval) * interval - 1) }
    // A damaged partition has to be replaced as a whole. Preserve the full
    // inspector range even when the request checked only part of that day.
    // Off-grid observations are reported at their containing candle bucket.
    if (!matches(normalized, target) || !overlaps(normalized, envelope)) throw new TypeError('An audit finding must overlap its inspected target.')
    if (typeof issue.reason !== 'string' || !issue.reason.trim() || typeof issue.repairable !== 'boolean') throw new TypeError('An audit finding needs a reason and repairability.')
    const finding = { ...normalized, reason: issue.reason, repairable: issue.repairable }
    if (issue.file !== undefined) {
      if (typeof issue.file !== 'string') throw new TypeError('An audit finding file must be a string.')
      finding.file = issue.file
    }
    if (issue.detail !== undefined) {
      if (typeof issue.detail !== 'string') throw new TypeError('An audit finding detail must be a string.')
      finding.detail = issue.detail
    }
    unique.set(issueKey(finding), finding)
  }
  return [...unique.values()]
}

function recoveredJob(row) {
  const job = clone(row)
  const integer = (value, field) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid audit checkpoint: ${field}.`)
  }
  if (!job || job.schemaVersion !== 1 || typeof job.id !== 'string' || !job.id.trim()) throw new TypeError('Invalid audit checkpoint identity or schema.')
  if (!['queued', 'running', 'paused', 'completed', 'cancelled', 'failed'].includes(job.status) || !['inspect', 'repair', 'verify'].includes(job.phase)) throw new TypeError('Invalid audit checkpoint state.')
  if (!Array.isArray(job.targets) || !job.targets.length) throw new TypeError('Invalid audit checkpoint targets.')
  job.targets = job.targets.map(targetOf)
  if (!job.cursor || typeof job.cursor !== 'object') throw new TypeError('Invalid audit checkpoint cursor.')
  integer(job.cursor.targetIndex, 'targetIndex')
  if (job.cursor.targetIndex > job.targets.length) throw new TypeError('Invalid audit checkpoint targetIndex.')
  const target = job.targets[job.cursor.targetIndex]
  if (target) {
    integer(job.cursor.nextFrom, 'nextFrom')
    if (job.cursor.nextFrom < target.from || job.cursor.nextFrom > target.through) throw new TypeError('Invalid audit checkpoint nextFrom.')
  } else if (job.cursor.nextFrom !== null) throw new TypeError('Invalid audit checkpoint final cursor.')
  if (!Array.isArray(job.issues) || !Array.isArray(job.repairTargets) || !Array.isArray(job.verifyTargets)) throw new TypeError('Invalid audit checkpoint findings or repair ranges.')
  const ids = new Set()
  for (const issue of job.issues) {
    Object.assign(issue, targetOf(issue))
    if (typeof issue.id !== 'string' || !issue.id || ids.has(issue.id) || !['open', 'resolved'].includes(issue.status) || typeof issue.reason !== 'string' || !issue.reason || typeof issue.repairable !== 'boolean') throw new TypeError('Invalid audit checkpoint issue.')
    if (issue.repairStatus !== undefined && !['pending', 'repaired', 'failed'].includes(issue.repairStatus)) throw new TypeError('Invalid audit checkpoint repair state.')
    if (issue.originalRange) targetOf({ ...issue, ...issue.originalRange })
    ids.add(issue.id)
  }
  for (const range of job.repairTargets) {
    Object.assign(range, targetOf(range))
    if (!ids.has(range.issueId)) throw new TypeError('Invalid audit checkpoint repair reference.')
  }
  job.verifyTargets = job.verifyTargets.map(targetOf)
  for (const field of ['checkedRows', 'files', 'repairIndex', 'verifyIndex', 'verificationCheckedRows', 'verificationFiles', 'createdAt', 'updatedAt']) integer(job[field], field)
  if (job.completedAt !== null) integer(job.completedAt, 'completedAt')
  if (job.repairIndex > job.repairTargets.length || job.verifyIndex > job.verifyTargets.length) throw new TypeError('Invalid audit checkpoint repair or verification cursor.')
  if (job.phase !== 'inspect' && target) throw new TypeError('Invalid audit checkpoint: inspection is incomplete.')
  if (job.phase === 'verify' && job.repairIndex !== job.repairTargets.length) throw new TypeError('Invalid audit checkpoint: repairs are incomplete.')
  if (job.status === 'completed' && (target || job.phase === 'repair' || (job.phase === 'verify' && job.verifyIndex !== job.verifyTargets.length))) throw new TypeError('Invalid audit checkpoint completion.')
  return job
}

// Verification also covers known findings that overlap a repaired range. That
// makes the result authoritative without declaring a partially checked finding
// resolved or leaving stale ranges in the report.
function verificationRanges(repaired, issues) {
  let ranges = repaired.map(rangeOf)
  let expanded = true
  while (expanded) {
    expanded = false
    for (const range of ranges) {
      for (const issue of issues) {
        if (issue.status !== 'open' || !overlaps(range, issue)) continue
        const from = Math.min(range.from, issue.from)
        const through = Math.max(range.through, issue.through)
        if (from !== range.from || through !== range.through) { range.from = from; range.through = through; expanded = true }
      }
    }
    const merged = []
    ranges.sort((left, right) => left.instrument.localeCompare(right.instrument) || left.timeframe.localeCompare(right.timeframe) || left.from - right.from)
    for (const range of ranges) {
      const previous = merged.at(-1)
      if (previous && overlaps(previous, range)) {
        previous.through = Math.max(previous.through, range.through)
        expanded = true
      } else merged.push(range)
    }
    ranges = merged
  }
  return ranges
}

/** A durable background audit of Parquet facts; SQLite stores only this report. */
export class DataAudit {
  constructor({ store, metadata, inspect, repair, onCheckpoint, now = Date.now, chunkMilliseconds = DAY }) {
    if (!metadata || typeof metadata.saveAudit !== 'function' || typeof metadata.listAudits !== 'function') throw new TypeError('DataAudit needs a metadata store.')
    if (!inspect && typeof store?.inspectCandles !== 'function') throw new TypeError('DataAudit needs a candle inspector.')
    if (!Number.isSafeInteger(chunkMilliseconds) || chunkMilliseconds < INTERVALS['1H']) throw new TypeError('Audit chunks must span at least one hour.')
    if (onCheckpoint !== undefined && typeof onCheckpoint !== 'function') throw new TypeError('Audit onCheckpoint must be a function.')
    this.metadata = metadata
    this.inspect = inspect ?? ((target, _options) => store.inspectCandles(target, 'background'))
    this.repairRange = repair
    this.onCheckpoint = onCheckpoint
    this.now = now
    this.chunkMilliseconds = chunkMilliseconds
    this.jobs = new Map()
    this.queue = []
    this.pending = new Set()
    this.controllers = new Map()
    this.runner = null
    this.closed = false
    this.closeTask = null
    for (const job of metadata.listAudits().map(recoveredJob)) {
      this.jobs.set(job.id, job)
      if (ACTIVE.has(job.status)) {
        job.status = 'queued'
        this.save(job)
        this.enqueue(job.id)
      }
    }
  }

  assertOpen() {
    if (this.closed) throw new Error('DataAudit is closed.')
  }

  requireJob(id) {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`Audit not found: ${id}`)
    return job
  }

  save(job) {
    job.updatedAt = this.now()
    job.summary = {
      open: job.issues.filter(issue => issue.status === 'open').length,
      resolved: job.issues.filter(issue => issue.status === 'resolved').length,
      repairFailed: job.issues.filter(issue => issue.status === 'open' && issue.repairStatus === 'failed').length,
    }
    this.metadata.saveAudit(clone(job))
    // Actions can publish before replacing jobs.get(id). The saved payload,
    // rather than a subsequent read, is the authoritative checkpoint.
    try { Promise.resolve(this.onCheckpoint?.(clone(job))).catch(() => undefined) }
    catch { /* Observer failures cannot change durable audit progress. */ }
  }

  start(request) {
    this.assertOpen()
    if (!request || !Array.isArray(request.targets) || !request.targets.length) throw new TypeError('An audit needs at least one target.')
    const id = request.id ?? randomUUID()
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('An audit ID must be a nonempty string.')
    if (this.jobs.has(id)) throw new Error(`Audit already exists: ${id}`)
    const targets = [...new Map(request.targets.map(target => { const normalized = targetOf(target); return [JSON.stringify(normalized), normalized] })).values()]
    const timestamp = this.now()
    const job = {
      id, schemaVersion: 1, status: 'queued', phase: 'inspect', targets,
      cursor: { targetIndex: 0, nextFrom: targets[0].from },
      issues: [], checkedRows: 0, files: 0,
      repairTargets: [], repairIndex: 0, verifyTargets: [], verifyIndex: 0,
      verificationCheckedRows: 0, verificationFiles: 0,
      createdAt: timestamp, updatedAt: timestamp, completedAt: null,
    }
    this.save(job)
    this.jobs.set(id, job)
    this.enqueue(id)
    return clone(job)
  }

  get(id) { const job = this.jobs.get(id); return job ? clone(job) : null }
  status(id) { return this.get(id) }
  list() { return [...this.jobs.values()].map(clone) }

  cancel(id) {
    this.assertOpen()
    const current = this.requireJob(id)
    if (!ACTIVE.has(current.status)) return clone(current)
    const job = clone(current)
    job.status = 'cancelled'
    this.save(job)
    this.jobs.set(id, job)
    this.controllers.get(id)?.abort()
    return clone(job)
  }

  resume(id) {
    this.assertOpen()
    const current = this.requireJob(id)
    if (ACTIVE.has(current.status) || current.status === 'completed') return clone(current)
    if (current.phase === 'repair' && typeof this.repairRange !== 'function') throw new Error('A repair callback is required to resume this audit.')
    const job = clone(current)
    job.status = 'queued'
    delete job.error
    this.save(job)
    this.jobs.set(id, job)
    this.enqueue(id)
    return clone(job)
  }

  repair(id) {
    this.assertOpen()
    const current = this.requireJob(id)
    if (current.status !== 'completed') throw new Error('Complete or resume the audit before requesting repair.')
    const repairTargets = current.issues.filter(issue => issue.status === 'open' && issue.repairable).map(issue => ({ ...rangeOf(issue), issueId: issue.id }))
    if (!repairTargets.length) return clone(current)
    if (typeof this.repairRange !== 'function') throw new Error('A repair callback is required; audit never invents missing market data.')
    const job = clone(current)
    job.phase = 'repair'
    job.status = 'queued'
    job.completedAt = null
    delete job.error
    job.repairTargets = repairTargets
    job.repairIndex = 0
    job.verifyTargets = verificationRanges(repairTargets, job.issues)
    job.verifyIndex = 0
    job.verificationCheckedRows = 0
    job.verificationFiles = 0
    for (const target of repairTargets) {
      const issue = job.issues.find(row => row.id === target.issueId)
      issue.repairStatus = 'pending'
      delete issue.repairError
    }
    this.save(job)
    this.jobs.set(id, job)
    this.enqueue(id)
    return clone(job)
  }

  enqueue(id) {
    if (!this.pending.has(id)) { this.pending.add(id); this.queue.push(id) }
    if (this.runner || this.closed) return
    this.runner = Promise.resolve().then(() => this.drain()).finally(() => {
      this.runner = null
      if (this.queue.length && !this.closed) this.enqueue(this.queue[0])
    })
  }

  async drain() {
    while (this.queue.length && !this.closed) {
      const id = this.queue.shift()
      this.pending.delete(id)
      const job = this.jobs.get(id)
      if (!job || job.status !== 'queued') continue
      const controller = new AbortController()
      this.controllers.set(id, controller)
      try {
        job.status = 'running'
        this.save(job)
        if (job.phase === 'repair' && typeof this.repairRange !== 'function') throw new Error('A repair callback is required to resume this audit.')
        while (this.isCurrent(job, controller.signal)) {
          await yieldToBackground()
          if (!this.isCurrent(job, controller.signal)) break
          if (job.phase === 'inspect') await this.inspectNext(job, controller.signal)
          else if (job.phase === 'repair') await this.repairNext(job, controller.signal)
          else if (job.phase === 'verify') await this.verifyNext(job, controller.signal)
          else throw new Error('Unsupported audit phase.')
        }
      } catch (error) {
        if (this.isCurrent(job, controller.signal)) {
          job.status = 'failed'
          job.error = message(error)
          this.save(job)
        }
      } finally {
        if (this.controllers.get(id) === controller) this.controllers.delete(id)
      }
    }
  }

  isCurrent(job, signal) { return !this.closed && !signal.aborted && this.jobs.get(job.id) === job && job.status === 'running' }

  complete(job) {
    job.status = 'completed'
    job.completedAt = this.now()
    delete job.error
    this.save(job)
  }

  async inspectNext(job, signal) {
    const target = job.targets[job.cursor.targetIndex]
    if (!target) { this.complete(job); return }
    const from = job.cursor.nextFrom ?? target.from
    const interval = INTERVALS[target.timeframe]
    const boundary = (Math.floor(from / this.chunkMilliseconds) + 1) * this.chunkMilliseconds
    const nextFrom = Math.ceil(boundary / interval) * interval
    const through = Math.min(target.through, nextFrom - 1)
    const query = { ...target, from, through }
    const result = await this.inspect(query, { signal, priority: 'background' })
    if (!this.isCurrent(job, signal)) return
    const findings = findingsOf(result, query)
    for (const finding of findings) {
      if (!job.issues.some(issue => issueKey(issue) === issueKey(finding))) job.issues.push({ ...finding, id: randomUUID(), status: 'open' })
    }
    job.checkedRows += result.checkedRows
    job.files += result.files
    if (through === target.through) {
      job.cursor.targetIndex += 1
      job.cursor.nextFrom = job.targets[job.cursor.targetIndex]?.from ?? null
    } else job.cursor.nextFrom = nextFrom
    this.save(job)
  }

  async repairNext(job, signal) {
    const target = job.repairTargets[job.repairIndex]
    if (!target) { job.phase = 'verify'; this.save(job); return }
    const issue = job.issues.find(row => row.id === target.issueId)
    if (!issue) throw new Error('The audit repair checkpoint references a missing issue.')
    try {
      await this.repairRange(clone(issue), { signal })
      if (!this.isCurrent(job, signal)) return
      issue.repairStatus = 'repaired'
      delete issue.repairError
    } catch (error) {
      if (!this.isCurrent(job, signal)) return
      issue.repairStatus = 'failed'
      issue.repairError = message(error)
    }
    job.repairIndex += 1
    this.save(job)
  }

  async verifyNext(job, signal) {
    const target = job.verifyTargets[job.verifyIndex]
    if (!target) { this.complete(job); return }
    const result = await this.inspect(clone(target), { signal, priority: 'background' })
    if (!this.isCurrent(job, signal)) return
    const findings = findingsOf(result, target)
    const previous = job.issues.filter(issue => issue.status === 'open' && matches(issue, target) && issue.from >= target.from && issue.through <= target.through)
    const retained = new Set()
    for (const finding of findings) {
      const existing = previous.find(issue => !retained.has(issue.id) && issueKey(issue) === issueKey(finding))
        ?? previous.find(issue => !retained.has(issue.id) && issue.reason === finding.reason && overlaps(issue, finding) && issue.file === finding.file)
      if (existing) {
        if (existing.from !== finding.from || existing.through !== finding.through) existing.originalRange ??= { from: existing.from, through: existing.through }
        Object.assign(existing, finding)
        retained.add(existing.id)
      } else job.issues.push({ ...finding, id: randomUUID(), status: 'open' })
    }
    for (const issue of previous) {
      if (!retained.has(issue.id)) { issue.status = 'resolved'; issue.resolvedAt = this.now() }
    }
    job.verificationCheckedRows += result.checkedRows
    job.verificationFiles += result.files
    job.verifyIndex += 1
    this.save(job)
  }

  async whenIdle() { while (this.runner) await this.runner }

  close() {
    if (this.closeTask) return this.closeTask
    this.closed = true
    for (const [id, current] of this.jobs) {
      if (current.status !== 'running') continue
      const job = clone(current)
      job.status = 'queued'
      this.save(job)
      this.jobs.set(id, job)
    }
    for (const controller of this.controllers.values()) controller.abort()
    this.closeTask = this.whenIdle()
    return this.closeTask
  }
}
