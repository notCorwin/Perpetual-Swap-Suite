export type GatewayEvent = { id: string; type: 'data' | 'end' | 'error'; base64?: string; message?: string }
export type GatewayBridge = {
  postMessage(request: { gatewayFetch: { id: string; body: string } }): Promise<{ status: number; headers: Record<string, string> }>
  postMessage(request: { cancelGatewayFetch: string }): Promise<{ ok: boolean }>
}

let sequence = 0
export function createGatewayFetch(bridge: GatewayBridge, events: EventTarget): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    if (request.url !== 'https://ai-gateway.vercel.sh/v1/chat/completions' || request.method !== 'POST') {
      throw new Error('Unsupported Gateway endpoint.')
    }
    const body = await request.text()
    request.signal.throwIfAborted()
    const id = `gateway-${Date.now()}-${++sequence}`
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let disposed = false
    const queued: Uint8Array[] = []
    let awaitingRead = false
    let terminal: 'end' | Error | undefined
    const pump = () => {
      if (!awaitingRead) return
      const chunk = queued.shift()
      if (chunk) { awaitingRead = false; controller?.enqueue(chunk) }
      else if (terminal) {
        awaitingRead = false
        if (terminal === 'end') controller?.close()
        else controller?.error(terminal)
      }
    }
    let rejectAbort: (reason: unknown) => void = () => {}
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    const cleanup = () => {
      disposed = true
      events.removeEventListener('radar-gateway-stream', receive)
      request.signal.removeEventListener('abort', abort)
    }
    const cancel = () => { void bridge.postMessage({ cancelGatewayFetch: id }).catch(() => {}) }
    const abort = () => {
      if (disposed) return
      const reason = request.signal.reason ?? new DOMException('Request stopped.', 'AbortError')
      controller?.error(reason); cleanup(); cancel(); rejectAbort(reason)
    }
    const receive = (event: Event) => {
      const value = (event as CustomEvent<GatewayEvent>).detail
      if (disposed || value.id !== id) return
      if (value.type === 'data') {
        try {
          const binary = atob(value.base64 ?? '')
          queued.push(Uint8Array.from(binary, character => character.charCodeAt(0))); pump()
        } catch { terminal = new Error('Invalid Gateway stream data.'); cleanup(); cancel(); pump() }
      } else if (value.type === 'end') { terminal = 'end'; cleanup(); pump() }
      else { terminal = new Error(value.message ?? 'Gateway stream interrupted.'); cleanup(); pump() }
    }
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value },
      pull() { awaitingRead = true; pump() },
      cancel() { if (!disposed) { cleanup(); cancel() } },
    }, { highWaterMark: 0 })
    events.addEventListener('radar-gateway-stream', receive)
    request.signal.addEventListener('abort', abort, { once: true })
    try {
      const response = await Promise.race([bridge.postMessage({ gatewayFetch: { id, body } }), aborted])
      request.signal.throwIfAborted()
      return new Response(stream, { status: response.status, headers: response.headers })
    } catch (error) {
      if (!disposed) { cleanup(); cancel(); controller?.error(error) }
      throw error
    }
  }
}
