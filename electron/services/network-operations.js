import { beginOperation } from './operations.js'

let nextConnection = 0

/** Keep credentials, query parameters and fragments out of operation records. */
export function networkResource(input) {
  try {
    const url = new URL(input)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch { return 'unknown' }
}

const byteLength = value => {
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
    const resource = networkResource(url)
    const attributes = { transport: 'websocket', stream, connection: ++nextConnection }
    const connect = beginOperation({ category: 'network', name: 'websocket.connect', resource, attributes })
    let socket, connected = false, connectFinished = false
    const finishConnect = status => {
      if (connectFinished) return
      connectFinished = true
      connect.end({ status })
    }
    try { socket = factory(url) }
    catch (error) { finishConnect('error'); throw error }

    const record = (name, detail = {}, status = 'ok') => beginOperation({ category: 'network', name, resource, attributes: { ...attributes, ...detail } }).end({ status })
    const listeners = {
      open: () => { connected = true; finishConnect('ok') },
      message: event => record('websocket.receive', { bytes: byteLength(event.data) }),
      error: () => { finishConnect('error'); record('websocket.error', {}, 'error') },
      close: event => {
        finishConnect(connected ? 'ok' : 'error')
        const clean = event.wasClean === true || event.code === 1000 || event.code === 1001
        record('websocket.closed', { code: Number.isInteger(event.code) ? event.code : null, clean }, clean ? 'ok' : 'error')
        for (const [type, listener] of Object.entries(listeners)) socket.removeEventListener(type, listener)
      },
    }
    for (const [type, listener] of Object.entries(listeners)) socket.addEventListener(type, listener)
    if (socket.readyState === 1) listeners.open()
    else if (socket.readyState === 3) finishConnect('error')

    return {
      get readyState() { return socket.readyState },
      addEventListener(type, listener) { socket.addEventListener(type, listener) },
      removeEventListener(type, listener) { socket.removeEventListener(type, listener) },
      send(data) {
        const operation = beginOperation({ category: 'network', name: 'websocket.send', resource, attributes: { ...attributes, bytes: byteLength(data) } })
        try { const result = socket.send(data); operation.end(); return result }
        catch (error) { operation.end({ status: 'error' }); throw error }
      },
      close(code, reason) {
        // Abandoning a connecting socket is terminal even if an injected or
        // failed transport never delivers its close handshake event.
        if (!connected) finishConnect('cancelled')
        const operation = beginOperation({ category: 'network', name: 'websocket.close', resource, attributes })
        try { const result = socket.close(code, reason); operation.end(); return result }
        catch (error) { operation.end({ status: 'error' }); throw error }
      },
    }
  }
}
