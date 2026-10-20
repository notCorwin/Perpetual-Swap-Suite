import { mkdirSync, openSync, readFileSync, writeFileSync, writeSync, write, closeSync, fdatasync, fdatasyncSync, renameSync, unlinkSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { AsyncLocalStorage } from 'node:async_hooks'
import { threadId, workerData } from 'node:worker_threads'
import { installSandboxNetworkBoundary } from './sandbox-network.js'
import { installOperationHooks, getOperationHookCapabilities, getInstalledOperationHooks } from './operation-hooks.js'
import { encodeOperationJournal, operationJournalSuffix } from './operation-journal.js'
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
    closeSync(descriptor); descriptor = undefined
    renameSync(temporary, path)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
})

function journalWriter(directory, sessionId, executionId, participant, hooks, capabilities = () => []) {
  const file = join(directory, `${executionId}${operationJournalSuffix}`), healthFile = join(directory, `${executionId}.health.json`)
  const descriptor = suppress(() => openSync(file, 'wx', 0o600))
  const prefix = suppress(() => encodeOperationJournal(Buffer.alloc(0)))
  suppress(() => {
    let offset = 0
    while (offset < prefix.length) {
      const written = writeSync(descriptor, prefix, offset, prefix.length - offset, offset)
      if (!written) throw new Error('Operation journal write made no progress.')
      offset += written
    }
  })
  const counts = { recorded: 0, persisted: 0, durableRecords: 0, uncompressedBytes: 0, journalBytes: prefix.length,
    failed: 0, recordedOperations: 0, startedOperations: 0, sourceFailures: 0, omittedRecords: 0 }
  let lastDurableAt = null
  const queue = new Map()
  let nextSequence = 1, bytes = 0, position = prefix.length, timer, writing, accepting = true, closed = false, closing, flushBarrier = Promise.resolve(), lastHealthState
  let serializing = 0, building = false, draining = 0, serializationBarrier, finishSerialization
  const health = () => {
    const snapshot = capabilities()
    return { schemaVersion: 2, ...counts, pending: counts.recorded - counts.persisted,
      activeOperations: counts.startedOperations - counts.recordedOperations, executionId, sessionId, participantId: participant.id,
      role: participant.role, closed, enabledHooks: typeof hooks === 'function' ? hooks(snapshot) : hooks,
      hookCapabilities: snapshot, encoding: 'brotli-frames-q0-crc32-v1',
      durability: 'fdatasync-on-flush-and-5s-checkpoint', updatedAt: Date.now(), lastDurableAt,
      runtime: { node: process.version, electron: process.versions.electron ?? null, v8: process.versions.v8 } }
  }
  const failed = error => { counts.failed++; suppress(() => console.error(`Operation journal failed (${error.code ?? error.name}).`)) }
  const writeHealth = () => {
    const value = health(), state = JSON.stringify({ ...value, updatedAt: undefined })
    if (state === lastHealthState) return
    // Reuse the complete state encoding; only the update timestamp is volatile.
    const encoded = `${state.slice(0, -1)},"updatedAt":${JSON.stringify(value.updatedAt)}}`
    try { jsonWrite(healthFile, value, encoded); lastHealthState = state }
    catch (error) { failed(error); throw error }
  }
  const serializeFlush = operation => {
    const task = flushBarrier.then(operation)
    // A failed flush must remain observable to its caller while allowing close
    // to drain later batches and publish the permanent failed health state.
    flushBarrier = task.catch(() => {})
    return task
  }
  const releaseAdmission = () => {
    if (serializing || building || draining) return
    const completed = finishSerialization
    finishSerialization = undefined; serializationBarrier = undefined
    completed?.()
  }
  const take = () => {
    clearTimeout(timer); timer = undefined
    if (serializing || building || queue.get(nextSequence) === undefined) return { count: 0, buffer: Buffer.alloc(0), offset: position }
    building = true
    try {
      const lines = []
      let through = nextSequence
      for (;;) {
        const line = queue.get(through)
        if (line === undefined) break
        through++
        // A failed serialization owns its sequence but contributes no fake line.
        if (line !== null) lines.push(line)
      }
      const raw = lines.length ? Buffer.from(`${lines.join('\n')}\n`) : Buffer.alloc(0)
      const buffer = lines.length ? encodeOperationJournal(raw) : Buffer.alloc(0)
      const batch = { count: lines.length, buffer, offset: position }
      // New observations may arrive during encoding. Remove only this complete
      // prefix; absolute sequence keys keep their later admissions independent.
      for (let sequence = nextSequence; sequence < through; sequence++) queue.delete(sequence)
      nextSequence = through; bytes -= raw.length
      counts.uncompressedBytes += raw.length; counts.journalBytes += buffer.length
      position += buffer.length; return batch
    } finally { building = false; releaseAdmission() }
  }
  const scheduleWrite = () => {
    if (serializing || building || draining || !queue.size || closed) return
    if (bytes >= 256 * 1024 && queue.get(nextSequence) !== undefined) pressureWrite()
    else if (!timer && !writing) { timer = setTimeout(startWrite, 250); timer.unref() }
  }
  const pressureWrite = () => suppress(() => {
    draining++
    try {
      const { count, buffer, offset } = take()
      if (!count) return
      let written = 0
      while (written < buffer.length) {
        const size = writeSync(descriptor, buffer, written, buffer.length - written, offset + written)
        if (!size) throw new Error('Operation journal write made no progress.')
        written += size
      }
      counts.persisted += count
    } catch (error) { failed(error) }
    finally { draining--; try { scheduleWrite() } finally { releaseAdmission() } }
  })
  const startWrite = () => suppress(() => {
    if (writing) return writing
    draining++
    try {
      const { count, buffer, offset } = take()
      if (!count) return Promise.resolve()
      // Reserved offsets keep old async and newer pressure batches disjoint.
      writing = (async () => {
        let written = 0
        while (written < buffer.length) {
          const size = await new Promise((resolve, reject) => write(descriptor, buffer, written, buffer.length - written, offset + written,
            (error, size) => error ? reject(error) : resolve(size)))
          if (!size) throw new Error('Operation journal write made no progress.')
          written += size
        }
        counts.persisted += count
      })().catch(failed).finally(() => {
        writing = undefined
        scheduleWrite()
      })
      return writing
    } finally { draining--; try { scheduleWrite() } finally { releaseAdmission() } }
  })
  const flush = ({ durable = true } = {}) => {
    const target = counts.recorded
    return serializeFlush(() => suppress(async () => {
      do {
        if (serializing || building || draining || queue.size && queue.get(nextSequence) === undefined) await (serializationBarrier ??= new Promise(resolve => { finishSerialization = resolve }))
        await startWrite()
      } while (counts.persisted < target && (writing || queue.size))
      if (writing) await writing
      if (durable && !closed && counts.durableRecords < target) {
        try {
          await new Promise((resolve, reject) => fdatasync(descriptor, error => error ? reject(error) : resolve()))
          counts.durableRecords = Math.max(counts.durableRecords, Math.min(target, counts.persisted)); lastDurableAt = Date.now()
        }
        catch (error) { failed(error) }
      }
      writeHealth()
      if (counts.failed || counts.persisted < target || counts.sourceFailures || counts.omittedRecords) throw new Error('Operation journal persistence did not complete.')
    }))
  }
  const enqueue = entry => {
    if (!accepting) {
      counts.sourceFailures++; counts.omittedRecords++
      if (!closed && entry.sequence >= nextSequence && !queue.has(entry.sequence)) queue.set(entry.sequence, null)
      finishSerialization?.(); serializationBarrier = undefined; finishSerialization = undefined
      writeHealth()
      throw new Error('A closing or closed operation journal cannot accept records.')
    }
    // A native/CDP interrupt can publish a later sequence before this function
    // even starts. The producer's absolute sequence owns its immutable line.
    serializing++
    const sequence = entry.sequence, terminal = Number(entry.phase === 'end'), started = Number(entry.phase === 'start')
    counts.recorded++; counts.recordedOperations += terminal; counts.startedOperations += started
    try {
      const line = JSON.stringify(entry), length = Buffer.byteLength(line) + 1
      queue.set(sequence, line); bytes += length
    } catch (error) {
      queue.set(sequence, null)
      counts.recorded--; counts.recordedOperations -= terminal; counts.startedOperations -= started
      counts.sourceFailures++; counts.omittedRecords++; failed(error)
      throw error
    } finally {
      if (--serializing === 0) {
        try { scheduleWrite() } finally { releaseAdmission() }
      }
    }
  }
  const exit = () => { pressureWrite(); writeHealth() }
  const markIncomplete = (reason, count = 1) => {
    counts.sourceFailures++; counts.omittedRecords += Number.isSafeInteger(count) && count > 0 ? count : 0
    participant.failure = String(reason).slice(0, 160); jsonWrite(join(directory, `${participant.id}.participant.json`), participant); writeHealth()
  }
  const close = () => {
    if (!closing) {
      accepting = false
      clearInterval(checkpointTimer)
      closing = (async () => {
        try {
          await flush()
          while (queue.size || writing) await flush()
        } finally {
          // Explicit renderer ACKs may be flushing concurrently with shutdown.
          // Queue descriptor closure behind every previously admitted fdatasync;
          // later flushes see closed and never touch the released descriptor.
          await serializeFlush(() => suppress(() => { closed = true; closeSync(descriptor); writeHealth() }))
        }
      })()
    }
    return closing
  }
  // A long-lived worker must leave fresh durable progress even when it never
  // receives a renderer ACK or an explicit diagnostics request.
  const checkpointTimer = setInterval(() => { if (accepting) void flush().catch(() => {}) }, 5000)
  checkpointTimer.unref()
  writeHealth()
  return { enqueue, flush, close, exit, health, markIncomplete }
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
      unsubscribe(); closed = true
      const stopped = await Promise.allSettled([...writers.values()].map(writer => writer.close()))
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
