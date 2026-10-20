import { beginOperation, captureOperationContext, recordOperation } from './operations.js'
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'

const timeOrigin = performance.timeOrigin
let nextConnection = 0
const recordedSockets = new WeakMap()
const recordedConstructionErrors = new WeakSet()

/** Keep credentials, query parameters and fragments out of operation records. */
export function networkResource(input) {
  try {
    const url = new URL(input)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch { return 'unknown' }
}

export const networkByteLength = value => {
  if (typeof value === 'string') return Buffer.byteLength(value)
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength
  if (typeof value?.size === 'number' && Number.isFinite(value.size) && value.size >= 0) return value.size
  return null
}

/**
 * Instrument the real transport once, independently of subscriptions/decoding.
 * Explicit forwarding preserves native WebSocket and injected socket receivers.
 */
export function recordedWebSocketFactory(factory, stream) {
  return url => {
    let socket
    try { socket = factory(url) }
    catch (error) {
      // A native constructor hook already recorded its failure. Injected
      // factories still need a terminal event when they fail before returning.
      if (!error || typeof error !== 'object' || !recordedConstructionErrors.has(error)) {
        beginOperation({ category: 'network', name: 'websocket.connect', resource: networkResource(url),
          attributes: { transport: 'websocket', stream, source: 'injected' } }).end({ status: 'error' })
      }
      throw error
    }
    return recordedSockets.get(socket) ?? recordWebSocket(socket, url, { stream, source: 'injected' })
  }
}

/** Native constructors and injected transports share one receiver-safe recorder. */
export function constructRecordedWebSocket(construct, url, attributes = {}) {
  const connect = beginOperation({ category: 'network', name: 'websocket.connect', resource: networkResource(url),
    attributes: { transport: 'websocket', ...attributes } })
  try { return recordWebSocket(construct(), url, attributes, connect) }
  catch (error) {
    connect.end({ status: 'error' })
    if (error && typeof error === 'object') recordedConstructionErrors.add(error)
    throw error
  }
}

function recordWebSocket(socket, url, suppliedAttributes, pendingConnect) {
    const resource = networkResource(url)
    const attributes = { transport: 'websocket', ...suppliedAttributes, connection: ++nextConnection }
    const connect = pendingConnect ?? beginOperation({ category: 'network', name: 'websocket.connect', resource, attributes })
    let connected = false, connectFinished = false
    const finishConnect = status => {
      if (connectFinished) return
      connectFinished = true
      connect.end({ status })
    }
    // These callbacks observe an event already delivered by the transport. They
    // have an observation time, rather than an application operation to time.
    const record = (name, detail = {}, status = 'ok') => recordOperation({ category: 'network', name, resource,
      startedAt: timeOrigin + performance.now(), durationMS: 0, status, attributes: { ...attributes, ...detail } })
    // Native observers retain connection IDs without restoring application hook
    // scopes. Suppression belongs to the execution delivering each event.
    const resumeObserver = captureOperationContext()
    const observe = listener => event => resumeObserver(() => listener(event))
    const listeners = {
      open: observe(() => { connected = true; finishConnect('ok') }),
      message: observe(event => record('websocket.receive', { bytes: networkByteLength(event.data) })),
      error: observe(() => { finishConnect('error'); record('websocket.error', {}, 'error') }),
      close: observe(event => {
        finishConnect(connected ? 'ok' : 'error')
        const clean = event.wasClean === true || event.code === 1000 || event.code === 1001
        record('websocket.closed', { code: Number.isInteger(event.code) ? event.code : null, clean }, clean ? 'ok' : 'error')
        for (const [type, listener] of Object.entries(listeners)) socket.removeEventListener(type, listener)
      }),
    }
    for (const [type, listener] of Object.entries(listeners)) socket.addEventListener(type, listener)
    if (socket.readyState === 1) listeners.open()
    else if (socket.readyState === 3) finishConnect('error')

    const nativeSend = socket.send, nativeClose = socket.close
    let recorded = socket
    const methods = {
      send(...args) {
        const operation = beginOperation({ category: 'network', name: 'websocket.send', resource, attributes: { ...attributes, bytes: networkByteLength(args[0]) } })
        try { const result = Reflect.apply(nativeSend, this === recorded ? socket : this, args); operation.end(); return result }
        catch (error) { operation.end({ status: 'error' }); throw error }
      },
      close(...args) {
        // Abandoning a connecting socket is terminal even if an injected or
        // failed transport never delivers its close handshake event.
        if (!connected) finishConnect('cancelled')
        const operation = beginOperation({ category: 'network', name: 'websocket.close', resource, attributes })
        try { const result = Reflect.apply(nativeClose, this === recorded ? socket : this, args); operation.end(); return result }
        catch (error) { operation.end({ status: 'error' }); throw error }
      },
    }
    try {
      Object.defineProperties(socket, Object.fromEntries(Object.entries(methods).map(([key, value]) => [key, { value, configurable: true, writable: true }])))
    } catch {
      // Injected immutable transports expose only the supported contract.
      recorded = { get readyState() { return socket.readyState }, ...methods,
        addEventListener(type, listener) { socket.addEventListener(type, listener) },
        removeEventListener(type, listener) { socket.removeEventListener(type, listener) } }
    }
    recordedSockets.set(socket, recorded)
    recordedSockets.set(recorded, recorded)
    return recorded
}
