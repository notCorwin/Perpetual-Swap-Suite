import { mkdirSync, openSync, open, readFileSync, readSync, writeFileSync, writeFile, writeSync, write, closeSync, close, fdatasync, fdatasyncSync, renameSync, unlinkSync, unlink } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { threadId, workerData } from 'node:worker_threads'
import { installSandboxNetworkBoundary } from './sandbox-network.js'
import { installOperationHooks, getOperationHookCapabilities, getInstalledOperationHooks } from './operation-hooks.js'
import { encodeOperationJournal, operationJournalSuffix } from './operation-journal.js'
import { createRecorderSelfTiming } from './recorder-self-timing.js'
import { attachOperationJournalSink, configureOperationContext, configureOperationPropagation, finishActiveOperations,
  registerOperationImportSource, withOperationSuppressed } from './operations.js'

const scopes = new AsyncLocalStorage()
configureOperationPropagation({ get: () => scopes.getStore(), run: (context, operation) => scopes.run(context, operation) })
const startupContext = workerData?.operationContext ?? (process.env.PERPETUAL_SWAP_PARENT_OPERATION_CONTEXT
  ? JSON.parse(process.env.PERPETUAL_SWAP_PARENT_OPERATION_CONTEXT) : {})
scopes.enterWith(Object.fromEntries(['traceId', 'parentId', 'scenarioId'].filter(key => typeof startupContext[key] === 'string'
  && /^[\w.:/-]{1,256}$/.test(startupContext[key])).map(key => [key, startupContext[key]])))
installSandboxNetworkBoundary()
let current
const suppress = withOperationSuppressed
const validID = value => typeof value === 'string' && /^[\w.:-]{1,256}$/.test(value)
const jsonWrite = (path, value, encoded) => suppress(() => {
  const temporary = join(dirname(path), `.tmp-${randomUUID()}-${basename(path)}`)
  let descriptor
  try {
    writeFileSync(temporary, `${encoded ?? JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    descriptor = openSync(temporary, 'r')
    fdatasyncSync(descriptor)
    const closing = descriptor; descriptor = undefined
    closeSync(closing)
    renameSync(temporary, path)
  } finally {
    try { if (descriptor !== undefined) closeSync(descriptor) }
    finally { try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  }
})

function journalWriter(directory, sessionId, executionId, participant, hooks, capabilities = () => []) {
  const file = join(directory, `${executionId}${operationJournalSuffix}`), healthFile = join(directory, `${executionId}.health.json`)
  const selfTiming = createRecorderSelfTiming()
  const descriptor = suppress(() => openSync(file, 'wx', 0o600))
  const prefix = suppress(() => encodeOperationJournal(Buffer.alloc(0)))
  const writeAll = (fd, buffer, position) => {
    let written = 0
    while (written < buffer.length) {
      const size = writeSync(fd, buffer, written, buffer.length - written, position + written)
      if (!size) throw new Error('Operation journal write made no progress.')
      written += size
    }
  }
  suppress(() => writeAll(descriptor, prefix, 0))
  const counts = { recorded: 0, persisted: 0, durableRecords: 0, uncompressedBytes: 0, journalBytes: prefix.length,
    failed: 0, recordedOperations: 0, startedOperations: 0, sourceFailures: 0, omittedRecords: 0 }
  let lastDurableAt = null
  const queue = new Map(), jobs = new Set(), nativeRequests = new Set(), healthTemps = new Set()
  // Bounds apply to retained serialized lines and complete compressed write jobs.
  // A synchronous producer cannot await a full queue: excess records are spooled
  // synchronously, or a complete batch is written synchronously, without loss.
  const batchLimit = 256 * 1024, memoryLimit = 1024 * 1024, recordLimit = 4096, jobLimit = 4, jobBytesLimit = 1024 * 1024
  let nextSequence = 1, maximumSequence = 0, pendingBytes = 0, memoryBytes = 0, position = prefix.length, inFlightBytes = 0
  let timer, accepting = true, closed = false, exiting = false, closing, closeFinished = false, lastHealthState, journalFailure = false
  let activeFlush, pendingFlush
  let serializing = 0, building = false, draining = 0, serializationBarrier, finishSerialization
  let healthGeneration = 0, healthCommitting = false, healthRepair = false
  let spill, spillCount = 0, spillFirst = Infinity
  const health = (includeSelfTiming = true) => {
    const snapshot = capabilities()
    return { schemaVersion: 2, ...counts, pending: counts.recorded - counts.persisted,
      activeOperations: counts.startedOperations - counts.recordedOperations, executionId, sessionId, participantId: participant.id,
      role: participant.role, closed, enabledHooks: typeof hooks === 'function' ? hooks(snapshot) : hooks,
      hookCapabilities: snapshot, encoding: 'brotli-frames-q0-crc32-v1',
      durability: 'fdatasync-on-flush-and-5s-checkpoint', updatedAt: Date.now(), lastDurableAt,
      runtime: { node: process.version, electron: process.versions.electron ?? null, v8: process.versions.v8 },
      ...(includeSelfTiming ? { selfTiming: selfTiming.snapshot() } : {}) }
  }
  const failed = error => { counts.failed++; suppress(() => console.error(`Operation journal failed (${error.code ?? error.name}).`)) }
  const healthSnapshot = () => {
    const value = health(false), state = JSON.stringify({ ...value, updatedAt: undefined })
    // Diagnostics never invalidate an unchanged durable state.
    const encoded = `${state.slice(0, -1)},"updatedAt":${JSON.stringify(value.updatedAt)},"selfTiming":${JSON.stringify(selfTiming.snapshot())}}\n`
    return { value, state, encoded }
  }
  // A reentrant synchronous publication during a commit is repaired before the
  // enclosing synchronous call returns. No asynchronous callback can interleave.
  const commitHealth = operation => {
    if (healthCommitting) { healthRepair = true; return }
    healthCommitting = true
    try { operation() }
    finally {
      healthCommitting = false
      if (healthRepair) { healthRepair = false; writeHealthSync() }
    }
  }
  const writeHealthSync = () => {
    const generation = ++healthGeneration
    if (healthCommitting) { healthRepair = true; return }
    try {
      commitHealth(() => {
        const { value, state, encoded } = healthSnapshot()
        if (generation !== healthGeneration) { healthRepair = true; return }
        if (state !== lastHealthState) selfTiming.measure('health-publish', () => {
          jsonWrite(healthFile, value, encoded.slice(0, -1)); lastHealthState = state
        })
      })
    } catch (error) { failed(error); throw error }
  }
  const writeHealthTerminal = () => {
    // A process exit may itself be reentrant inside a health rename. It cannot
    // wait for the interrupted commit to resume, so publish directly now. If a
    // synthetic handoff does return, the enclosing commit still repairs itself.
    const outerCommit = healthCommitting
    if (outerCommit) healthRepair = true
    healthCommitting = true
    try {
      for (;;) {
        const generation = ++healthGeneration
        const { value, state, encoded } = healthSnapshot()
        if (generation !== healthGeneration) continue
        if (state !== lastHealthState) selfTiming.measure('health-publish', () => jsonWrite(healthFile, value, encoded.slice(0, -1)))
        if (generation !== healthGeneration) continue
        lastHealthState = state
        break
      }
    } catch (error) { failed(error) }
    finally { healthCommitting = outerCommit; if (!outerCommit) healthRepair = false }
  }
  const callback = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (error, value) => error ? reject(error) : resolve(value)))
  const writeHealth = async () => {
    // A failed cleanup cannot accumulate one temporary path per later flush.
    // The failure remains permanent even if a later cleanup succeeds.
    for (const temporary of healthTemps) {
      try { await callback(unlink, temporary) }
      catch (error) { if (error.code !== 'ENOENT') { failed(error); throw error } }
      healthTemps.delete(temporary)
    }
    const generation = ++healthGeneration
    let snapshot
    try { snapshot = healthSnapshot() } catch (error) { failed(error); throw error }
    const { state, encoded } = snapshot
    if (generation !== healthGeneration || state === lastHealthState) return
    const temporary = join(dirname(healthFile), `.tmp-${randomUUID()}-${basename(healthFile)}`)
    healthTemps.add(temporary)
    const finishWait = selfTiming.startWait('health-publish-wait')
    let fd, failure
    try {
      await callback(writeFile, temporary, encoded, { mode: 0o600, flag: 'wx' })
      fd = await callback(open, temporary, 'r')
      await callback(fdatasync, fd)
      const closingFD = fd; fd = undefined
      await callback(close, closingFD)
      // No await separates the generation check and atomic rename. A newer
      // synchronous failure/terminal publication invalidates this snapshot.
      commitHealth(() => {
        if (generation === healthGeneration) selfTiming.measure('health-commit', () => {
          renameSync(temporary, healthFile); lastHealthState = state
        })
      })
    } catch (error) { failure = error }
    finally {
      if (fd !== undefined) try { await callback(close, fd) } catch (error) { failure ??= error }
      try { await callback(unlink, temporary); healthTemps.delete(temporary) }
      catch (error) { if (error.code === 'ENOENT') healthTemps.delete(temporary); else failure ??= error }
      finishWait(failure ? 'error' : 'ok')
    }
    if (failure) { failed(failure); throw failure }
  }
  const releaseAdmission = () => {
    if (serializing || building || draining) return
    const completed = finishSerialization
    finishSerialization = undefined; serializationBarrier = undefined
    completed?.()
  }
  const admissionWait = () => serializationBarrier ??= new Promise(resolve => { finishSerialization = resolve })
  const openSpill = () => {
    if (spill) return spill
    const dataPath = join(directory, `.tmp-${randomUUID()}-${executionId}.spill`), indexPath = `${dataPath}.index`
    const data = openSync(dataPath, 'wx+', 0o600)
    try { spill = { data, index: openSync(indexPath, 'wx+', 0o600), dataPath, indexPath, end: 0 } }
    catch (error) { closeSync(data); unlinkSync(dataPath); throw error }
    return spill
  }
  const clearSpill = () => {
    if (!spill || spillCount) return
    const current = spill; spill = undefined; spillFirst = Infinity
    let failure
    for (const fd of [current.data, current.index]) try { closeSync(fd) } catch (error) { failure ??= error }
    for (const path of [current.dataPath, current.indexPath]) {
      try { unlinkSync(path) } catch (error) { if (error.code !== 'ENOENT') failure ??= error }
    }
    if (failure) throw failure
  }
  const spillPosition = sequence => {
    const offset = (sequence - 1) * 16
    if (!Number.isSafeInteger(offset)) throw new Error('Operation journal sequence exceeds spill capacity.')
    return offset
  }
  const put = (sequence, line, length) => {
    const memory = line === null ? 0 : line.length * 2
    if (queue.size < recordLimit && memoryBytes + memory <= memoryLimit) {
      // The immutable serialized line keeps its admitted UTF-8 size, including
      // its delimiter, through every timer, pressure drain and flush lookup.
      queue.set(sequence, { line, length, stored: false }); memoryBytes += memory
    } else suppress(() => {
      // A sparse on-disk index preserves sequence holes without an unbounded
      // in-memory index when a reentrant producer has not admitted its prefix.
      const target = openSpill(), index = Buffer.alloc(16)
      const data = line === null ? null : Buffer.from(line)
      if (data && data.length >= 0xffffffff) throw new Error('Operation journal record exceeds spill capacity.')
      index.writeBigUInt64LE(BigInt(target.end) + 1n, 0); index.writeUInt32LE(data ? data.length : 0xffffffff, 8)
      if (data) { writeAll(target.data, data, target.end); target.end += data.length }
      writeAll(target.index, index, spillPosition(sequence)); spillCount++; spillFirst = Math.min(spillFirst, sequence)
    })
    pendingBytes += length
  }
  const get = sequence => {
    const retained = queue.get(sequence)
    if (retained) return retained
    if (!spillCount || sequence < spillFirst) return undefined
    return suppress(() => {
      const index = Buffer.alloc(16)
      let indexRead = 0
      while (indexRead < index.length) {
        const size = readSync(spill.index, index, indexRead, index.length - indexRead, spillPosition(sequence) + indexRead)
        if (!size) {
          if (indexRead) throw new Error('Operation journal spill index is truncated.')
          return undefined
        }
        indexRead += size
      }
      if (index.readBigUInt64LE(0) === 0n) return undefined
      const length = index.readUInt32LE(8)
      if (length === 0xffffffff) return { line: null, length: 0, stored: true }
      const data = Buffer.allocUnsafe(length), offset = Number(index.readBigUInt64LE(0) - 1n)
      let read = 0
      while (read < length) {
        const size = readSync(spill.data, data, read, length - read, offset + read)
        if (!size) throw new Error('Operation journal spill read made no progress.')
        read += size
      }
      return { line: data.toString(), length: length + 1, stored: true }
    })
  }
  const queued = () => queue.size + spillCount
  const take = () => {
    clearTimeout(timer); timer = undefined
    if (serializing || building) return undefined
    building = true
    try {
      return selfTiming.measure('batch-build', () => {
        const lines = [], entries = []
        let through = nextSequence, rawBytes = 0
        while (entries.length < recordLimit) {
          const entry = get(through)
          if (!entry) break
          const length = entry.length
          if (lines.length && rawBytes + length > batchLimit) break
          entries.push(entry); through++; rawBytes += length
          if (entry.line !== null) lines.push(entry.line)
        }
        if (!entries.length) return undefined
        const raw = lines.length ? Buffer.from(`${lines.join('\n')}\n`) : Buffer.alloc(0)
        const buffer = lines.length ? encodeOperationJournal(raw) : Buffer.alloc(0)
        const batch = { first: nextSequence, through: through - 1, count: lines.length, buffer, offset: position }
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index]
          if (entry.stored) spillCount--
          else { queue.delete(nextSequence + index); if (entry.line !== null) memoryBytes -= entry.line.length * 2 }
        }
        nextSequence = through; pendingBytes -= rawBytes
        counts.uncompressedBytes += raw.length; counts.journalBytes += buffer.length; position += buffer.length
        clearSpill()
        return batch
      })
    } finally { building = false; releaseAdmission() }
  }
  const finishJob = (job, error) => {
    if (job.completed) return
    job.completed = true; jobs.delete(job); inFlightBytes -= job.buffer.length
    if (error) { journalFailure = true; failed(error) } else counts.persisted += job.count
    job.finishWait(error ? 'error' : 'ok'); job.resolve()
    scheduleWrite(); releaseAdmission()
  }
  const dispatch = batch => {
    if (!batch.count) return
    if (jobs.size >= jobLimit || inFlightBytes + batch.buffer.length > jobBytesLimit) {
      selfTiming.measure('pressure-write', () => writeAll(descriptor, batch.buffer, batch.offset))
      counts.persisted += batch.count
      return
    }
    const job = { ...batch, written: 0, completed: false, finishWait: selfTiming.startWait('journal-write-wait') }
    job.promise = new Promise(resolve => { job.resolve = resolve })
    jobs.add(job); inFlightBytes += batch.buffer.length
    const issue = () => {
      const request = {}
      request.promise = new Promise(resolve => { request.resolve = resolve })
      nativeRequests.add(request)
      try {
        write(descriptor, job.buffer, job.written, job.buffer.length - job.written, job.offset + job.written, (error, size) => {
          nativeRequests.delete(request); request.resolve()
          if (job.completed) return
          if (error) return finishJob(job, error)
          if (!size || size > job.buffer.length - job.written) return finishJob(job, new Error('Operation journal write made no progress.'))
          job.written += size
          if (job.written < job.buffer.length) issue()
          else finishJob(job)
        })
      } catch (error) { nativeRequests.delete(request); request.resolve(); finishJob(job, error) }
    }
    issue()
  }
  const startWrite = () => suppress(() => {
    if (serializing || building || draining || closed || journalFailure) return
    draining++
    try { const batch = take(); if (batch) dispatch(batch) }
    catch (error) { journalFailure = true; failed(error) }
    finally { draining--; releaseAdmission() }
  })
  const scheduleWrite = () => {
    if (serializing || building || draining || !queued() || closed || exiting || journalFailure) return
    try {
      while (!journalFailure && pendingBytes >= batchLimit && get(nextSequence)) startWrite()
      if (queued() && !timer && get(nextSequence)) { timer = setTimeout(() => { timer = undefined; startWrite(); scheduleWrite() }, 250); timer.unref() }
    } catch (error) { journalFailure = true; failed(error) }
  }
  const performFlush = ({ target, targetSequence, durable }) => suppress(async () => {
      while (nextSequence <= targetSequence && !journalFailure) {
        let available
        try { available = !serializing && !building && !draining && get(nextSequence) }
        catch (error) { journalFailure = true; failed(error); break }
        if (!available) await admissionWait()
        else startWrite()
      }
      // Later completed writes cannot stand in for an older in-flight prefix.
      await Promise.all([...jobs].filter(job => job.first <= targetSequence).map(job => job.promise))
      if (durable && !closed && !journalFailure && counts.durableRecords < target) {
        try {
          // The target may include an admission whose serialization failed
          // after the call. Only count records already written before this sync.
          const synchronizedRecords = Math.min(target, counts.recorded, counts.persisted)
          await callback(fdatasync, descriptor)
          counts.durableRecords = Math.max(counts.durableRecords, synchronizedRecords); lastDurableAt = Date.now()
        } catch (error) { failed(error) }
      }
      await writeHealth()
      if (counts.failed || journalFailure || nextSequence <= targetSequence || counts.persisted < target || counts.sourceFailures || counts.omittedRecords) throw new Error('Operation journal persistence did not complete.')
  })
  const flush = ({ durable = true } = {}) => {
    if (closing && !closeFinished) return closing.then(() => flush({ durable }))
    const request = { target: counts.recorded, targetSequence: maximumSequence, durable }
    const merge = group => {
      group.target = Math.max(group.target, request.target)
      group.targetSequence = Math.max(group.targetSequence, request.targetSequence)
      group.durable ||= request.durable
    }
    // A running barrier and one coalesced successor are enough regardless of
    // how many synchronous callers request an ACK while I/O is held.
    if (activeFlush && !activeFlush.group.started) { merge(activeFlush.group); return activeFlush.promise }
    if (pendingFlush) { merge(pendingFlush.group); return pendingFlush.promise }
    const group = { ...request, started: false }, previous = activeFlush?.promise
    const entry = { group }
    const start = () => {
      if (pendingFlush === entry) { activeFlush = entry; pendingFlush = undefined }
      group.started = true
      return performFlush(group)
    }
    entry.promise = previous ? previous.then(start, start) : Promise.resolve().then(start)
    if (previous) pendingFlush = entry; else activeFlush = entry
    const finish = () => { if (activeFlush === entry && !pendingFlush) activeFlush = undefined }
    void entry.promise.then(finish, finish)
    return entry.promise
  }
  const enqueue = entry => {
    if (!accepting || journalFailure) {
      counts.sourceFailures++; counts.omittedRecords++
      if (!closed && !journalFailure && entry.sequence >= nextSequence && !queue.has(entry.sequence)) put(entry.sequence, null, 0)
      releaseAdmission(); writeHealthSync()
      throw new Error('A closing, closed, or failed operation journal cannot accept records.')
    }
    serializing++
    const sequence = entry.sequence, terminal = Number(entry.phase === 'end'), started = Number(entry.phase === 'start')
    maximumSequence = Math.max(maximumSequence, sequence)
    counts.recorded++; counts.recordedOperations += terminal; counts.startedOperations += started
    try {
      const line = JSON.stringify(entry), length = Buffer.byteLength(line) + 1
      put(sequence, line, length)
    } catch (error) {
      try { put(sequence, null, 0) } catch { journalFailure = true }
      counts.recorded--; counts.recordedOperations -= terminal; counts.startedOperations -= started
      counts.sourceFailures++; counts.omittedRecords++; failed(error)
      throw error
    } finally {
      if (--serializing === 0) {
        try { scheduleWrite() } finally { releaseAdmission() }
      }
    }
  }
  const exit = () => suppress(() => {
    if (exiting) return
    accepting = false; exiting = true; clearTimeout(timer); clearInterval(checkpointTimer)
    // In-flight native writes may finish after this handler starts. Rewriting the
    // immutable whole buffer to its disjoint reserved offset is idempotent; the
    // callback observes completed and cannot count it twice or submit a suffix.
    for (const job of [...jobs]) {
      try { selfTiming.measure('exit-write', () => writeAll(descriptor, job.buffer, job.offset)); finishJob(job) }
      catch (error) { finishJob(job, error) }
    }
    if (!serializing && !building && !draining && !journalFailure) {
      draining++
      try {
        while (nextSequence <= maximumSequence) {
          const batch = take()
          if (!batch) break
          if (batch.count) { selfTiming.measure('exit-write', () => writeAll(descriptor, batch.buffer, batch.offset)); counts.persisted += batch.count }
        }
      } catch (error) { journalFailure = true; failed(error) }
      finally { draining-- }
    }
    if (serializing || building || nextSequence <= maximumSequence) {
      // The missing prefix can no longer be admitted after terminal handoff.
      // Make later close/flush fail instead of waiting forever or claiming it.
      journalFailure = true; counts.sourceFailures++; counts.omittedRecords++
    }
    try {
      if (!closed && !journalFailure) {
        fdatasyncSync(descriptor); counts.durableRecords = counts.persisted; lastDurableAt = Date.now()
      }
    } catch (error) { failed(error) }
    // Callbacks cannot finish cleanup once the process exits. Remove any
    // already-created temporary snapshots; an in-flight open may still race
    // process termination, but it can never commit a stale health file.
    for (const temporary of healthTemps) {
      try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') failed(error) }
    }
    writeHealthTerminal()
  })
  const markIncomplete = (reason, count = 1) => {
    counts.sourceFailures++; counts.omittedRecords += Number.isSafeInteger(count) && count > 0 ? count : 0
    participant.failure = String(reason).slice(0, 160); jsonWrite(join(directory, `${participant.id}.participant.json`), participant); writeHealthSync()
  }
  const closeWriter = () => {
    if (!closing) {
      accepting = false
      clearTimeout(timer); clearInterval(checkpointTimer)
      closing = (async () => {
        const failures = []
        try { await flush() } catch (error) { failures.push(error) }
        await suppress(async () => {
          // Every submitted write, including later disjoint batches, must stop
          // using the descriptor before it can be closed or reused.
          await Promise.all([...jobs].map(job => job.promise))
          await Promise.all([...nativeRequests].map(request => request.promise))
          closed = true
          try { closeSync(descriptor) } catch (error) { failed(error); failures.push(error) }
          try { if (spill) { spillCount = 0; clearSpill() } } catch (error) { failed(error); failures.push(error) }
          // Cleanup failures are permanent and must appear in the final health
          // even when another finalizer has already failed.
          try { await writeHealth() } catch (error) { failures.push(error) }
        })
        if (failures.length === 1) throw failures[0]
        if (failures.length) throw new AggregateError(failures, 'Operation journal did not close cleanly.', { cause: failures[0] })
      })().finally(() => { closeFinished = true })
    }
    return closing
  }
  const checkpointTimer = setInterval(() => { if (accepting) void flush().catch(() => {}) }, 5000)
  checkpointTimer.unref()
  writeHealthSync()
  return { enqueue, flush, close: closeWriter, exit, health, markIncomplete }
}

export function initializeOperationRecording({ directory = process.env.PERPETUAL_SWAP_OPERATION_DIR, label, role = process.env.PERPETUAL_SWAP_OPERATION_ROLE } = {}) {
  if (current || !directory) return current
  suppress(() => mkdirSync(directory, { recursive: true, mode: 0o700 }))
  const executionId = `${process.pid}-${threadId}-${randomUUID()}`
  const sessionId = process.env.PERPETUAL_SWAP_OPERATION_SESSION ?? (basename(directory) === 'operations' ? basename(dirname(directory)) : basename(directory))
  const participantId = process.env.PERPETUAL_SWAP_OPERATION_PARTICIPANT
  let participant
  if (participantId) {
    if (!validID(participantId)) throw new TypeError('Invalid operation participant.')
    participant = suppress(() => JSON.parse(readFileSync(join(directory, `${participantId}.participant.json`), 'utf8')))
    if (participant.id !== participantId || participant.executionId) throw new Error('An operation participant cannot be claimed twice.')
  } else participant = { schemaVersion: 2, id: randomUUID(), role: role ?? label ?? (process.versions.electron && threadId === 0 ? 'electron-main' : threadId > 0 ? 'worker' : 'node'), registeredAt: Date.now() }
  Object.assign(participant, { status: 'ready', executionId })
  jsonWrite(join(directory, `${participant.id}.participant.json`), participant)
  configureOperationContext({ sessionId, executionId, ...(process.env.PERPETUAL_SWAP_OPERATION_SCENARIO ? { scenarioId: process.env.PERPETUAL_SWAP_OPERATION_SCENARIO } : {}) }, process.threadCpuUsage
    ? () => { const value = process.threadCpuUsage(); return (value.user + value.system) / 1000 } : undefined)
  suppress(() => installOperationHooks())
  const writers = new Map([[executionId, journalWriter(directory, sessionId, executionId, participant, getInstalledOperationHooks, getOperationHookCapabilities)]])
  let closed = false, closeTask
  const unsubscribe = attachOperationJournalSink(entry => {
    const writer = writers.get(entry.executionId)
    if (!writer) throw new Error('An unregistered operation source cannot write a journal.')
    writer.enqueue(entry)
  })
  const flush = async options => { await Promise.all([...writers.values()].map(writer => writer.flush(options))) }
  const exit = () => { if (!closed) { finishActiveOperations(); for (const writer of writers.values()) writer.exit() } }
  current = { directory, sessionId, executionId, writers, get enabledHooks() { return getInstalledOperationHooks() }, flush, health: () => writers.get(executionId).health(), close() {
    if (!closeTask) closeTask = (async () => {
      finishActiveOperations()
      const flushed = await Promise.allSettled([...writers.values()].map(writer => writer.flush()))
      unsubscribe()
      const stopped = await Promise.allSettled([...writers.values()].map(writer => writer.close()))
      closed = true
      process.off('exit', exit)
      const failures = [...flushed, ...stopped].filter(value => value.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(value => value.reason), 'Operation journals did not close cleanly.')
    })()
    return closeTask
  } }
  process.on('exit', exit)
  process.once('beforeExit', () => { void current.close().catch(error => console.error(error.message)) })
  return current
}

export function registerOperationParticipant(role) {
  if (!current) return { id: undefined, env: {} }
  if (typeof role !== 'string' || !/^[\w.-]{1,80}$/.test(role)) throw new TypeError('Invalid operation participant role.')
  const participant = { schemaVersion: 2, id: randomUUID(), role, parentExecutionId: current.executionId,
    registeredAt: Date.now(), status: 'registered' }
  jsonWrite(join(current.directory, `${participant.id}.participant.json`), participant)
  return { id: participant.id, env: { PERPETUAL_SWAP_OPERATION_PARTICIPANT: participant.id, PERPETUAL_SWAP_OPERATION_ROLE: role } }
}
export function claimExternalOperationParticipant(participantId, executionId) {
  if (!current || !validID(participantId) || !validID(executionId)) throw new TypeError('Invalid external operation participant.')
  const path = join(current.directory, `${participantId}.participant.json`)
  const participant = suppress(() => JSON.parse(readFileSync(path, 'utf8')))
  if (participant.parentExecutionId !== current.executionId || participant.role !== 'renderer'
    || participant.executionId && participant.executionId !== executionId) throw new Error('Invalid external operation participant claim.')
  if (!current.writers.has(executionId)) {
    Object.assign(participant, { executionId, status: 'ready' }); jsonWrite(path, participant)
    current.writers.set(executionId, journalWriter(current.directory, current.sessionId, executionId, participant, ['renderer-ipc', 'performance-observer'], () => [
      { api: 'preload.request', enabled: true, scope: 'renderer bridge request lifecycle' },
      { api: 'preload.notification', enabled: true, scope: 'renderer bridge event delivery' },
      { api: 'PerformanceObserver', enabled: false, scope: 'optional browser entry types', reason: 'entry availability is browser dependent' },
    ]))
    registerOperationImportSource(executionId, current.sessionId)
  }
  return { sessionId: current.sessionId, executionId,
    ...(process.env.PERPETUAL_SWAP_OPERATION_SCENARIO ? { scenarioId: process.env.PERPETUAL_SWAP_OPERATION_SCENARIO } : {}) }
}
export function markExternalOperationSourceIncomplete(executionId, reason, count = 1) {
  current?.writers.get(executionId)?.markIncomplete(reason, count)
}
export function closeExternalOperationSource(executionId) { return current?.writers.get(executionId)?.close() ?? Promise.resolve() }
/** A renderer ACK promises durability for that registered source only. */
export async function flushExternalOperationSource(executionId) {
  const writer = current?.writers.get(executionId)
  if (!writer || executionId === current.executionId) throw new TypeError('Unknown external operation source.')
  await writer.flush()
}
export function flushOperationRecording(options) { return current?.flush(options) ?? Promise.resolve() }
export function closeOperationRecording() { return current?.close() ?? Promise.resolve() }
initializeOperationRecording()
