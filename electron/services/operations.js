// Shared by Node workers and the isolated renderer. Payloads, SQL parameters,
// credentials and error messages deliberately never enter the operation log.
const sinks = new Set()
const active = new Set()
let sequence = 0
let context = { sessionId: 'unattached', executionId: 'renderer' }
let cpuClock
const categories = new Set(['cpu', 'gpu', 'network', 'database'])
const statuses = new Set(['ok', 'error', 'cancelled'])
const allowedAttributes = new Set(['count', 'rows', 'bytes', 'sentBytes', 'receivedBytes', 'statusCode', 'errorName', 'lane', 'priority', 'method', 'measurement', 'queryCount', 'changes', 'inputRows', 'outputRows', 'cache', 'threadId', 'blockingDurationMS', 'renderDurationMS', 'width', 'height', 'reason', 'incomplete', 'durationSource', 'role', 'candles', 'intervalMS', 'checkpoint', 'execution', 'projection', 'bidLevels', 'askLevels', 'bookResident', 'inspected', 'transport', 'stream', 'connection', 'path', 'httpStatus', 'declaredResponseBytes', 'timedOut', 'code', 'clean', 'cpuPercent', 'residentKB', 'processId'])

function attributes(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key, item]) => allowedAttributes.has(key)
    && (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)
      || typeof item === 'string' && item.length <= 160)))
}

export function configureOperationContext(value, clock) { context = { ...context, ...value }; cpuClock = clock }
export function attachOperationSink(sink) { sinks.add(sink); return () => sinks.delete(sink) }

export function recordOperation(value) {
  if (!sinks.size || !categories.has(value.category) || !statuses.has(value.status)
    || !Number.isFinite(value.startedAt) || !Number.isFinite(value.durationMS) || value.durationMS < 0) return
  const entry = {
    schemaVersion: 1, ...context, id: `${context.executionId}:${++sequence}`,
    category: value.category, name: String(value.name).slice(0, 160),
    ...(value.resource ? { resource: String(value.resource).slice(0, 256) } : {}),
    startedAt: value.startedAt, durationMS: value.durationMS, status: value.status,
    attributes: attributes(value.attributes),
    ...(Number.isFinite(value.cpuTimeMS) ? { cpuTimeMS: Math.max(0, value.cpuTimeMS) } : {}),
  }
  for (const sink of sinks) { try { sink(entry) } catch { /* Diagnostics cannot change business outcomes. */ } }
}

const noop = { end() {} }
export function beginOperation(specification) {
  if (!sinks.size) return noop
  const started = performance.now(), startedAt = performance.timeOrigin + started
  const cpu = specification.category === 'cpu' ? cpuClock?.() : undefined
  let ended = false
  const span = { end(result = {}) {
    if (ended) return
    ended = true; active.delete(span)
    recordOperation({ ...specification, startedAt, durationMS: performance.now() - started,
      status: result.status ?? 'ok', attributes: { ...specification.attributes, ...result.attributes },
      ...(cpu !== undefined ? { cpuTimeMS: cpuClock() - cpu } : {}) })
  } }
  active.add(span)
  return span
}

export function finishActiveOperations(reason = 'execution-stopped') {
  for (const span of active) span.end({ status: 'cancelled', attributes: { incomplete: true, reason } })
}

export function measureOperation(specification, operation) {
  const span = beginOperation(specification)
  const failed = error => { span.end({ status: error?.name === 'AbortError' ? 'cancelled' : 'error', attributes: { errorName: error?.name ?? 'Error' } }); throw error }
  try {
    const value = operation()
    if (value && typeof value.then === 'function') return Promise.resolve(value).then(result => { span.end(); return result }, failed)
    span.end(); return value
  } catch (error) { return failed(error) }
}
