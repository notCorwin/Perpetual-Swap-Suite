// Browser-safe operation identity and lifecycle. Node installs async context
// propagation; browser callbacks use the same API for synchronous scopes.
const sinks = new Set(), journalSinks = new Set(), active = new Set(), imports = new Map()
let operationSequence = 0, journalSequence = 0
let identity = { sessionId: 'unattached', executionId: `renderer-${globalThis.crypto?.randomUUID?.() ?? performance.timeOrigin}` }
let cpuClock, synchronousContext = {}, propagation
const categories = new Set(['cpu', 'gpu', 'network', 'database', 'io', 'ipc'])
const statuses = new Set(['ok', 'error', 'cancelled'])
const normalizedSpecifications = new WeakSet()
const allowedAttributes = new Set(['count', 'rows', 'bytes', 'sentBytes', 'receivedBytes', 'statusCode', 'errorName', 'lane', 'priority', 'method', 'measurement', 'queryCount', 'changes', 'inputRows', 'outputRows', 'cache', 'threadId', 'blockingDurationMS', 'renderDurationMS', 'width', 'height', 'reason', 'incomplete', 'durationSource', 'role', 'candles', 'intervalMS', 'checkpoint', 'execution', 'projection', 'bidLevels', 'askLevels', 'bookResident', 'inspected', 'transport', 'stream', 'connection', 'path', 'httpStatus', 'declaredResponseBytes', 'timedOut', 'code', 'clean', 'cpuPercent', 'residentKB', 'processId', 'source', 'queueMS', 'transferMS', 'executionMS', 'calls', 'hook', 'expected', 'workerRole', 'sequence', 'batchSize', 'attempt', 'misses', 'hits', 'invalidations', 'generation', 'revision', 'parameterHash', 'inputHash', 'heapUsedBytes', 'heapTotalBytes', 'rssBytes', 'gcKind', 'gcFlags', 'eventLoopDelayMS', 'bufferedBytes', 'omitted', 'command', 'nativeTimestampUS', 'nativeDurationUS', 'nativeEventName', 'nativeCategory', 'nativeEventId', 'clockDomain', 'nativeStatus'])
const safeText = (value, maximum = 160) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0')
const safeID = value => safeText(value, 256) && /^[\w.:/-]+$/.test(value)
function attributes(value, base) {
  const result = base ?? {}
  for (const key of Object.keys(value ?? {})) {
    if (!allowedAttributes.has(key)) continue
    const item = value[key]
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)
      || typeof item === 'string' && item.length <= 160) result[key] = item
    else if (base) delete result[key]
  }
  return result
}
const current = () => propagation?.get() ?? synchronousContext
const runContext = (context, operation) => {
  if (propagation) return propagation.run(context, operation)
  const previous = synchronousContext; synchronousContext = context
  try { return operation() } finally { synchronousContext = previous }
}
export function configureOperationContext(value, clock) {
  if (value.sessionId) identity.sessionId = value.sessionId
  if (value.executionId && value.executionId !== identity.executionId) { identity.executionId = value.executionId; operationSequence = 0; journalSequence = 0 }
  if (value.scenarioId) identity.scenarioId = value.scenarioId
  if (clock !== undefined) cpuClock = clock
}
export function configureOperationPropagation(value) { propagation = value }
export function getOperationContext() {
  const context = current(), scenarioId = context.scenarioId ?? identity.scenarioId
  return { ...(context.traceId ? { traceId: context.traceId } : {}), ...(context.parentId ? { parentId: context.parentId } : {}), ...(scenarioId ? { scenarioId } : {}) }
}
const validatedContextID = value => safeID(value) ? value : undefined
function applyContextIDs(context, traceId, parentId, scenarioId) {
  if (traceId === undefined) delete context.traceId; else context.traceId = traceId
  if (parentId === undefined) delete context.parentId; else context.parentId = parentId
  if (scenarioId === undefined) delete context.scenarioId; else context.scenarioId = scenarioId
  return context
}
export function runWithOperationContext(value, operation) {
  if (value === undefined) return operation()
  const context = { ...current() }
  return runContext(applyContextIDs(context, validatedContextID(value?.traceId), validatedContextID(value?.parentId), validatedContextID(value?.scenarioId)), operation)
}
export function captureOperationContext() {
  const captured = current(), traceId = validatedContextID(captured.traceId), parentId = validatedContextID(captured.parentId),
    scenarioId = validatedContextID(captured.scenarioId ?? identity.scenarioId)
  // Only immutable validated IDs belong to registration. Suppression and other
  // execution fields belong to each invocation, including mutable providers.
  return operation => {
    const context = current()
    if (context.traceId === traceId && context.parentId === parentId && context.scenarioId === scenarioId) return operation()
    return runContext(applyContextIDs({ ...context }, traceId, parentId, scenarioId), operation)
  }
}
export function withOperationSuppressed(operation) { return runContext({ ...current(), suppressed: true }, operation) }
export function isOperationSuppressed() { return current().suppressed === true }
export function hasOperationRecording() { return sinks.size > 0 || journalSinks.size > 0 }
export function readOperationCPUTime() { return cpuClock?.() }
export function attachOperationSink(sink) { sinks.add(sink); return () => sinks.delete(sink) }
export function attachOperationJournalSink(sink) { journalSinks.add(sink); return () => journalSinks.delete(sink) }
function publish(event) {
  let accepted = true
  for (const sink of journalSinks) { try { sink(event) } catch { accepted = false } }
  if (event.phase === 'end') for (const sink of sinks) { try { sink(event) } catch { /* See above. */ } }
  return accepted
}
function localEvent(base, phase, durationMS, status, eventAttributes, cpuTimeMS) {
  const event = { schemaVersion: base.schemaVersion, sessionId: base.sessionId, executionId: base.executionId,
    id: base.id, traceId: base.traceId, parentId: base.parentId, scenarioId: base.scenarioId,
    category: base.category, name: base.name, resource: base.resource, startedAt: base.startedAt,
    phase, sequence: ++journalSequence, durationMS, status, attributes: eventAttributes, cpuTimeMS }
  publish(event); return event
}
function start(specification, startedAt = performance.timeOrigin + performance.now()) {
  const context = current(), id = `${identity.executionId}:${++operationSequence}`, normalized = normalizedSpecifications.has(specification)
  const base = { schemaVersion: 2, sessionId: identity.sessionId, executionId: identity.executionId,
    id, traceId: context.traceId || id, parentId: context.parentId || undefined, scenarioId: context.scenarioId || identity.scenarioId,
    category: specification.category, name: normalized ? specification.name : String(specification.name).slice(0, 160),
    resource: normalized ? specification.resource : specification.resource ? String(specification.resource).slice(0, 256) : undefined,
    startedAt, attributes: normalized ? { ...specification.attributes } : attributes(specification.attributes) }
  // Mutable start observers cannot alter the private validated terminal baseline.
  localEvent(base, 'start', 0, 'running', { ...base.attributes }, undefined); return base
}
function complete(base, detail, durationMS = detail.durationMS) {
  // Completion consumes the private baseline. Starts already own an isolated
  // copy, and an ended span cannot publish this baseline a second time.
  const terminalAttributes = detail.attributes === undefined ? base.attributes : attributes(detail.attributes, base.attributes)
  localEvent(base, 'end', Math.max(0, durationMS), detail.status ?? 'ok', terminalAttributes,
    Number.isFinite(detail.cpuTimeMS) ? Math.max(0, detail.cpuTimeMS) : undefined)
}

export function recordOperation(value) {
  if (!hasOperationRecording() || isOperationSuppressed() || !categories.has(value.category)) return
  const { status, startedAt, durationMS, cpuTimeMS } = value
  if (!statuses.has(status) || !Number.isFinite(startedAt) || !Number.isFinite(durationMS) || durationMS < 0) return
  // A completed observation owns one validated snapshot. Start observers cannot
  // revise its terminal facts by mutating the caller's input during publication.
  complete(start(value, startedAt), { status, cpuTimeMS }, durationMS)
}
const noop = { context: {}, end() {}, run: operation => operation() }
class LocalOperationSpan {
  #base; #started; #ended = false; #context; #publicContext
  constructor(base, started) {
    this.#base = base; this.#started = started
  }
  get context() {
    const base = this.#base
    return this.#publicContext ??= { traceId: base.traceId, parentId: base.id, ...(base.scenarioId ? { scenarioId: base.scenarioId } : {}) }
  }
  run(operation) {
    // IDs belong to this span; suppression belongs to the execution that calls it.
    const base = this.#base, context = this.#context ??= { traceId: base.traceId, parentId: base.id, scenarioId: base.scenarioId }
    return runContext(current().suppressed === true ? { ...context, suppressed: true } : context, operation)
  }
  end(result = {}) {
    if (this.#ended) return
    this.#ended = true; active.delete(this)
    complete(this.#base, result, performance.now() - this.#started)
  }
}
export function beginOperation(specification) {
  if (!hasOperationRecording() || isOperationSuppressed() || !categories.has(specification.category)) return noop
  const started = performance.now(), span = new LocalOperationSpan(start(specification, performance.timeOrigin + started), started)
  active.add(span); return span
}

export function finishActiveOperations(reason = 'execution-stopped') {
  for (const span of active) span.end({ status: 'cancelled', attributes: { incomplete: true, reason } })
}
function failOperation(span, error) {
  span.end({ status: error?.name === 'AbortError' ? 'cancelled' : 'error', attributes: { errorName: error?.name ?? 'Error' } }); throw error
}
export function measureOperation(specification, operation) {
  const span = beginOperation(specification), cpu = cpuClock && span !== noop ? cpuClock() : undefined
  try {
    const value = span.run(operation)
    // A clock measured across await would include unrelated thread work.
    if (value && typeof value.then === 'function') return Promise.resolve(value).then(result => { span.end(); return result }, error => failOperation(span, error))
    span.end(cpu === undefined ? {} : { cpuTimeMS: cpuClock() - cpu }); return value
  } catch (error) { return failOperation(span, error) }
}

const hookedMethods = new WeakMap()
export function hookOperationMethods(target, specifications) {
  const installed = hookedMethods.get(target) ?? new Set()
  hookedMethods.set(target, installed)
  for (const [name, specification] of Object.entries(specifications)) {
    if (installed.has(name)) continue
    const descriptor = Object.getOwnPropertyDescriptor(target, name)
    if (!descriptor || typeof descriptor.value !== 'function') throw new TypeError(`Missing operation method: ${name}`)
    const method = descriptor.value
    let template
    if (typeof specification !== 'function') {
      // Static metadata is a registration snapshot. Each span still owns its
      // mutable attribute baseline and the separate copy seen by start observers.
      template = Object.freeze({ category: specification.category, name: String(specification.name).slice(0, 160),
        resource: specification.resource ? String(specification.resource).slice(0, 256) : undefined,
        attributes: Object.freeze(attributes(specification.attributes)) })
      normalizedSpecifications.add(template)
    }
    const wrapped = function (...args) {
      const spec = template ?? Reflect.apply(specification, this, args)
      return measureOperation(spec, () => Reflect.apply(method, this, args))
    }
    Object.defineProperty(wrapped, 'name', { value: method.name })
    Object.defineProperty(target, name, { ...descriptor, value: wrapped })
    installed.add(name)
  }
}
export function registerOperationImportSource(executionId, sessionId) {
  if (!safeID(executionId) || !safeID(sessionId)) throw new TypeError('Invalid operation source identity.')
  if (!imports.has(executionId)) imports.set(executionId, { sessionId, sequence: 0 })
}
export function importOperationEvents(events) {
  let accepted = 0, duplicates = 0, rejected = 0, lastSequence = 0
  for (const value of events) {
    const source = imports.get(value?.executionId)
    if (!source || value.schemaVersion !== 2 || value.sessionId !== source.sessionId || !Number.isSafeInteger(value.sequence) || value.sequence < 1
      || !safeID(value.id) || !value.id.startsWith(`${value.executionId}:`) || !safeID(value.traceId) || value.parentId !== undefined && !safeID(value.parentId)
      || !categories.has(value.category) || !safeText(value.name) || !Number.isFinite(value.startedAt) || !Number.isFinite(value.durationMS) || value.durationMS < 0
      || !['start', 'end'].includes(value.phase) || value.phase === 'start' && (value.status !== 'running' || value.durationMS !== 0)
      || value.phase === 'end' && !statuses.has(value.status)) { rejected++; continue }
    if (value.sequence <= source.sequence) { duplicates++; lastSequence = source.sequence; continue }
    if (value.sequence !== source.sequence + 1) { rejected++; continue }
    const entry = { schemaVersion: 2, sessionId: source.sessionId, executionId: value.executionId, id: value.id,
      sequence: value.sequence, traceId: value.traceId, ...(value.parentId ? { parentId: value.parentId } : {}),
      ...(safeID(value.scenarioId) ? { scenarioId: value.scenarioId } : {}), phase: value.phase, category: value.category,
      name: value.name, ...(typeof value.resource === 'string' ? { resource: value.resource.slice(0, 256) } : {}),
      startedAt: value.startedAt, durationMS: value.durationMS, status: value.status, attributes: attributes({ ...value.attributes, execution: 'renderer' }),
      ...(Number.isFinite(value.cpuTimeMS) ? { cpuTimeMS: Math.max(0, value.cpuTimeMS) } : {}) }
    if (!publish(entry)) { rejected++; continue }
    source.sequence = value.sequence; lastSequence = source.sequence; accepted++
  }
  return { accepted, duplicates, rejected, lastSequence }
}
