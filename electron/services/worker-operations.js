import { Worker, workerData } from 'node:worker_threads'
import { fork } from 'node:child_process'
import { beginOperation, getOperationContext, recordOperation, runWithOperationContext } from './operations.js'
import { registerOperationParticipant, closeOperationRecording } from './operation-runtime.js'

const instrumented = new WeakSet()
const requests = new WeakMap()
const now = () => performance.timeOrigin + performance.now()
const failureStatus = error => error?.name === 'AbortError' ? 'cancelled' : 'error'
const commandOf = message => String(message?.command ?? message?.method ?? message?.type ?? (message?.ack ? 'ack' : message?.sequence ? 'commit' : message?.id ? 'result' : 'notification')).slice(0, 80)

/** Every message carries its causal context without changing its domain fields. */
export function instrumentOperationEndpoint(endpoint, role) {
  if (instrumented.has(endpoint)) return endpoint
  instrumented.add(endpoint)
  const sendMethod = typeof endpoint.postMessage === 'function' ? 'postMessage' : 'send'
  const send = endpoint[sendMethod].bind(endpoint)
  endpoint[sendMethod] = (message, ...args) => {
    const operation = beginOperation({ category: 'ipc', name: 'worker.dispatch', resource: role, attributes: { command: commandOf(message), measurement: 'serialization-submission' } })
    try {
      const context = operation.context.traceId ? operation.context : getOperationContext()
      const value = operation.run(() => send({ ...message, operationContext: context, operationDispatchedAt: now() }, ...args))
      operation.end()
      return value
    } catch (error) { operation.end({ status: failureStatus(error), attributes: { errorName: error.name } }); throw error }
  }
  // Worker/ChildProcess owner handlers are synchronous dispatchers. Their async
  // descendants retain the restored context through Node AsyncLocalStorage.
  const emit = endpoint.emit.bind(endpoint)
  endpoint.emit = (event, ...args) => {
    if (event !== 'message') return emit(event, ...args)
    const message = args[0]
    return runWithOperationContext(message?.operationContext, () => {
      const operation = beginOperation({ category: 'ipc', name: 'worker.receive', resource: role, attributes: { command: commandOf(message) } })
      try { const result = operation.run(() => emit(event, ...args)); operation.end(); return result }
      catch (error) { operation.end({ status: failureStatus(error), attributes: { errorName: error.name } }); throw error }
    })
  }
  return endpoint
}

export function createOperationWorker(url, options = {}, role = 'worker') {
  const participant = registerOperationParticipant(role)
  const startup = beginOperation({ category: 'ipc', name: 'worker.start', resource: role })
  let worker
  try {
    worker = startup.run(() => new Worker(url, { ...options,
      env: { ...process.env, ...options.env, ...participant?.env },
      workerData: { ...options.workerData, operationContext: startup.context },
    }))
  } catch (error) { startup.end({ status: 'error', attributes: { errorName: error.name } }); throw error }
  instrumentOperationEndpoint(worker, role)
  const lifetime = beginOperation({ category: 'ipc', name: 'worker.lifetime', resource: role, attributes: { threadId: worker.threadId } })
  worker.once('online', () => startup.end())
  worker.on('error', error => {
    startup.end({ status: 'error', attributes: { errorName: error.name } })
    for (const request of [...(requests.get(worker) ?? [])]) request.reject(error)
  })
  worker.once('exit', code => {
    startup.end({ status: code === 0 ? 'cancelled' : 'error', attributes: { code } })
    lifetime.end({ status: code === 0 || code === 1 && worker.operationTerminationRequested ? 'ok' : 'error', attributes: { code } })
    for (const request of [...(requests.get(worker) ?? [])]) request.reject(Object.assign(new Error('Worker exited before responding.'), { name: 'WorkerExitError' }))
  })
  const terminate = worker.terminate.bind(worker)
  worker.terminate = (...args) => { worker.operationTerminationRequested = true; return terminate(...args) }
  return worker
}

export function createOperationProcess(entry, args = [], options = {}, role = 'process') {
  const participant = registerOperationParticipant(role)
  const startup = beginOperation({ category: 'ipc', name: 'worker.start', resource: role })
  let child
  try {
    child = startup.run(() => fork(entry, args, { ...options, env: { ...process.env, ...options.env, ...participant?.env,
      PERPETUAL_SWAP_PARENT_OPERATION_CONTEXT: JSON.stringify(startup.context) } }))
  } catch (error) { startup.end({ status: 'error', attributes: { errorName: error.name } }); throw error }
  instrumentOperationEndpoint(child, role)
  const lifetime = beginOperation({ category: 'ipc', name: 'worker.lifetime', resource: role, attributes: { processId: child.pid } })
  child.once('spawn', () => startup.end())
  child.on('error', error => {
    startup.end({ status: 'error', attributes: { errorName: error.name } })
    for (const request of [...(requests.get(child) ?? [])]) request.reject(error)
  })
  child.once('close', (code, signal) => {
    startup.end({ status: 'error', attributes: { code } })
    lifetime.end({ status: code === 0 && !signal ? 'ok' : 'error', attributes: { code } })
    for (const request of [...(requests.get(child) ?? [])]) request.reject(Object.assign(new Error('Worker process exited before responding.'), { name: 'WorkerExitError' }))
  })
  return child
}

/** Admission owns the queue wait; settlement always closes the whole request. */
export function createWorkerRequest(role, command, resolve, reject, attributes = {}) {
  const operation = beginOperation({ category: 'ipc', name: 'worker.request', resource: role, attributes: { ...attributes, command } })
  const queuedAt = performance.now()
  const queue = operation.run(() => beginOperation({ category: 'ipc', name: 'worker.queue', resource: role, attributes: { ...attributes, command } }))
  let target, settled = false, queueMS
  const finish = (error, value) => {
    if (settled) return
    settled = true
    queue.end({ status: error ? failureStatus(error) : 'ok' })
    operation.end({ status: error ? failureStatus(error) : 'ok', attributes: { ...(queueMS === undefined ? {} : { queueMS }), ...(error ? { errorName: error.name } : {}) } })
    requests.get(target)?.delete(request)
    error ? reject(error) : resolve(value)
  }
  const request = {
    context: operation.context,
    resolve: value => finish(null, value),
    reject: error => finish(error),
    dispatch(endpoint, message, ...args) {
      if (settled) return
      target = endpoint
      const pending = requests.get(endpoint) ?? new Set()
      requests.set(endpoint, pending); pending.add(request)
      queueMS = performance.now() - queuedAt
      queue.end({ attributes: { queueMS } })
      try { return operation.run(() => endpoint[typeof endpoint.postMessage === 'function' ? 'postMessage' : 'send'](message, ...args)) }
      catch (error) { request.reject(error); throw error }
    },
  }
  return request
}

/** Worker entrypoints share one async execution boundary and shutdown policy. */
export function onOperationMessage(endpoint, role, handler, { closeWhen = () => false } = {}) {
  instrumentOperationEndpoint(endpoint, role)
  const listener = message => runWithOperationContext(message?.operationContext, async () => {
    const receivedAt = now()
    if (Number.isFinite(message?.operationDispatchedAt)) recordOperation({ category: 'ipc', name: 'worker.transport.queue', resource: role,
      startedAt: message.operationDispatchedAt, durationMS: Math.max(0, receivedAt - message.operationDispatchedAt), status: 'ok', attributes: { command: commandOf(message), measurement: 'message-transfer' } })
    const operation = beginOperation({ category: 'ipc', name: 'worker.execute', resource: role, attributes: { command: commandOf(message) } })
    try {
      const response = await operation.run(() => handler(message))
      operation.end({ status: response?.error ? 'error' : 'ok' })
      if (closeWhen(message)) await closeOperationRecording()
      if (response !== undefined) runWithOperationContext(operation.context, () => endpoint[typeof endpoint.postMessage === 'function' ? 'postMessage' : 'send'](response))
    } catch (error) {
      operation.end({ status: failureStatus(error), attributes: { errorName: error.name } })
      // An unhandled handler error must preserve the endpoint's failure path.
      queueMicrotask(() => { throw error })
    }
  })
  endpoint.on('message', listener)
  return () => endpoint.off('message', listener)
}

export function runWorkerInitialization(role, operation) {
  let initial = workerData?.operationContext
  if (!initial && process.env.PERPETUAL_SWAP_PARENT_OPERATION_CONTEXT) {
    try { initial = JSON.parse(process.env.PERPETUAL_SWAP_PARENT_OPERATION_CONTEXT) } catch { /* Invalid context cannot affect initialization. */ }
  }
  return runWithOperationContext(initial ?? getOperationContext(), () => {
    const startup = beginOperation({ category: 'ipc', name: 'worker.initialize', resource: role })
    return startup.run(async () => {
      try { const value = await operation(); startup.end(); return value }
      catch (error) { startup.end({ status: 'error', attributes: { errorName: error.name } }); throw error }
    })
  })
}
