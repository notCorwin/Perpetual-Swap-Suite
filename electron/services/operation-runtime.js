import { mkdirSync, openSync, writeSync, write, closeSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { threadId } from 'node:worker_threads'
import { installSandboxNetworkBoundary } from './sandbox-network.js'
import { attachOperationSink, configureOperationContext, finishActiveOperations } from './operations.js'

installSandboxNetworkBoundary()
let current
// The writer is intentionally outside database/network instrumentation. One
// bounded batch is appended asynchronously; pressure flushes synchronously
// rather than dropping records or growing memory without a limit.
export function initializeOperationRecording({ directory = process.env.PERPETUAL_SWAP_OPERATION_DIR, label = 'node' } = {}) {
  if (current || !directory) return current
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const executionId = `${process.pid}-${threadId}-${randomUUID()}`
  const file = join(directory, `${executionId}.jsonl`)
  const descriptor = openSync(file, 'wx', 0o600)
  const counts = { recorded: 0, persisted: 0, failed: 0 }
  let queue = [], bytes = 0, timer, closed = false, writing, closeTask, position = 0
  configureOperationContext({ sessionId: process.env.PERPETUAL_SWAP_OPERATION_SESSION ?? (basename(directory) === 'operations' ? basename(dirname(directory)) : basename(directory)), executionId }, process.threadCpuUsage
    ? () => { const time = process.threadCpuUsage(); return (time.user + time.system) / 1000 } : undefined)
  const error = failure => { counts.failed += 1; console.error(`Operation log write failed (${failure.code ?? failure.name}).`) }
  const take = () => {
    clearTimeout(timer); timer = undefined
    const count = queue.length, buffer = Buffer.from(queue.join('')), offset = position
    queue = []; bytes = 0; position += buffer.length
    return { count, buffer, offset }
  }
  const persistSync = () => {
    const { count, buffer, offset } = take()
    if (!count) return
    try {
      let written = 0
      while (written < buffer.length) {
        const size = writeSync(descriptor, buffer, written, buffer.length - written, offset + written)
        if (!size) throw new Error('Operation journal write made no progress.')
        written += size
      }
      counts.persisted += count
    } catch (failure) { error(failure) }
  }
  const startWrite = () => {
    if (writing) return writing
    const { count, buffer, offset } = take()
    if (!count) return Promise.resolve()
    // Explicit disjoint file offsets preserve event order even when pressure
    // writes complete before an older async batch. Partial writes are retried.
    writing = (async () => {
      let written = 0
      while (written < buffer.length) {
        const size = await new Promise((resolve, reject) => write(descriptor, buffer, written, buffer.length - written, offset + written,
          (failure, size) => failure ? reject(failure) : resolve(size)))
        if (!size) throw new Error('Operation journal write made no progress.')
        written += size
      }
      counts.persisted += count
    })().catch(error).finally(() => {
      writing = undefined
      if (queue.length && !closed && !timer) { timer = setTimeout(startWrite, 250); timer.unref() }
    })
    return writing
  }
  const flush = async () => { do { await startWrite() } while (queue.length || writing) }
  const unsubscribe = attachOperationSink(entry => {
    if (closed) return
    const line = `${JSON.stringify(entry)}\n`
    counts.recorded++; queue.push(line); bytes += line.length
    if (bytes >= 256 * 1024) persistSync()
    else if (!timer && !writing) { timer = setTimeout(startWrite, 250); timer.unref() }
  })
  // Separate status file makes interrupted sessions and missing events visible.
  const healthFile = join(directory, `${executionId}.health.json`)
  const health = () => ({ ...counts, pending: counts.recorded - counts.persisted, executionId, label, closed,
    runtime: { node: process.version, electron: process.versions.electron ?? null, v8: process.versions.v8 } })
  const writeHealth = () => {
    const fd = openSync(healthFile, 'w', 0o600)
    try {
      const buffer = Buffer.from(`${JSON.stringify(health())}\n`)
      let offset = 0
      while (offset < buffer.length) {
        const size = writeSync(fd, buffer, offset, buffer.length - offset)
        if (!size) throw new Error('Operation health write made no progress.')
        offset += size
      }
    } finally { closeSync(fd) }
  }
  const exit = () => { if (!closed) { finishActiveOperations(); persistSync(); writeHealth() } }
  current = { directory, flush, health, close() {
    if (!closeTask) closeTask = (async () => {
      finishActiveOperations(); await flush(); unsubscribe(); closed = true
      process.off('exit', exit); closeSync(descriptor); writeHealth()
    })()
    return closeTask
  } }
  process.on('exit', exit)
  process.once('beforeExit', () => { void current.close() })
  writeHealth()
  return current
}

export function flushOperationRecording() { return current?.flush() ?? Promise.resolve() }
export function closeOperationRecording() { return current?.close() ?? Promise.resolve() }
initializeOperationRecording()
