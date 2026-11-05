const net = require('node:net')
const path = require('node:path')

const MAX_FRAME = 128 * 1024 * 1024
const MAX_PENDING = 4096
const MAX_EVENTS = 4096
const decoder = new TextDecoder('utf-8', { fatal: true })

class NativeClient {
  constructor(socketPath, token) {
    if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) throw new Error('RADAR_COMPARE_SOCKET must be an absolute Unix socket path.')
    if (typeof token !== 'string' || !token) throw new Error('RADAR_COMPARE_NATIVE_TOKEN is required for native transport.')
    this.socket = net.createConnection(socketPath)
    this.pending = new Map()
    this.events = []
    this.eventBytes = 0
    this.chunks = []
    this.chunkBytes = 0
    this.nextId = 1
    this.failure = null
    this.subscriber = null
    this.socket.on('data', chunk => this.read(chunk))
    this.socket.on('error', error => this.fail(`Native comparison socket error: ${error.message}`))
    this.socket.on('close', () => this.fail('Native comparison socket closed.'))
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('connect', () => {
        try { this.write({ kind: 'hello', token }); resolve() } catch (error) { this.fail(error.message); reject(error) }
      })
      this.socket.once('close', () => { if (this.failure) reject(new Error(this.failure)) })
    })
  }

  write(envelope) {
    if (this.failure) throw new Error(this.failure)
    const frame = Buffer.from(`${JSON.stringify(envelope)}\n`)
    if (frame.length > MAX_FRAME + 1) throw new Error('Native comparison frame exceeds 128 MiB.')
    if (this.socket.writableLength + frame.length > MAX_FRAME + 1) throw new Error('Native comparison socket write buffer is full.')
    this.socket.write(frame)
  }

  request(path, payload) {
    if (typeof path !== 'string' || typeof payload !== 'string') return Promise.reject(new Error('Native comparison request path and payload must be strings.'))
    if (this.failure) return Promise.reject(new Error(this.failure))
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error('Too many pending native comparison requests.'))
    if (this.nextId > Number.MAX_SAFE_INTEGER) return Promise.reject(new Error('Native comparison request IDs exhausted.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.write({ kind: 'request', id, path, payload }) } catch (error) { this.pending.delete(id); reject(error) }
    })
  }

  subscribe(callback) {
    if (this.failure) throw new Error(this.failure)
    if (this.subscriber) throw new Error('Native comparison events are already subscribed.')
    this.subscriber = callback
    const events = this.events
    this.events = []
    this.eventBytes = 0
    for (const payload of events) callback(payload)
  }

  read(chunk) {
    if (this.failure) return
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(start, end)
      this.chunkBytes += part.length
      if (this.chunkBytes > MAX_FRAME) { this.fail('Native comparison frame exceeds 128 MiB.'); return }
      this.chunks.push(part)
      if (newline < 0) return
      const line = Buffer.concat(this.chunks, this.chunkBytes)
      this.chunks = []
      this.chunkBytes = 0
      try {
        const message = JSON.parse(decoder.decode(line))
        if (message?.kind === 'event' && typeof message.payload === 'string') {
          if (this.subscriber) this.subscriber(message.payload)
          else {
            this.eventBytes += Buffer.byteLength(message.payload)
            if (this.events.length >= MAX_EVENTS || this.eventBytes > MAX_FRAME) throw new Error('Native comparison event buffer is full before subscription.')
            this.events.push(message.payload)
          }
        } else if (message?.kind === 'response' && Number.isSafeInteger(message.id) && message.id > 0
          && ((typeof message.result === 'string' && message.error === undefined) || (typeof message.error === 'string' && message.result === undefined))) {
          const pending = this.pending.get(message.id)
          if (!pending) throw new Error('Native comparison response has an unknown request ID.')
          this.pending.delete(message.id)
          if (message.error !== undefined) pending.reject(new Error(message.error))
          else pending.resolve(message.result)
        } else throw new Error('Invalid native comparison envelope.')
      } catch (error) { this.fail(`Native comparison protocol error: ${error.message}`); return }
      start = newline + 1
    }
  }

  fail(message) {
    if (this.failure) return
    this.failure = message
    this.socket.destroy()
    for (const { reject } of this.pending.values()) reject(new Error(message))
    this.pending.clear()
    this.events = []
    this.eventBytes = 0
    this.chunks = []
    this.chunkBytes = 0
    this.subscriber = null
  }

  close() { this.fail('Native comparison transport closed.') }
}

module.exports = { NativeClient }
