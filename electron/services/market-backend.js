import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'

const notificationEvents = new Set(['chart', 'market', 'audit', 'history-download'])

/** Electron owns windows; this worker owns market coordination and metadata. */
export class MarketBackend extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.pending = new Map()
    this.sequence = 0
    this.closed = false
    this.failure = null
    this.restartCount = 0
    this.restartTimer = null
    this.notificationEvents = new Set()
    this.spawnWorker()
    // Worker notification ownership follows actual consumers. A worker still
    // collects and prepares all requested data when no renderer is connected.
    const interestChanged = (name, count) => {
      if (!notificationEvents.has(name) || this.disposal || this.closed) return
      const interested = count > 0
      if (this.notificationEvents.has(name) === interested) return
      if (interested) this.notificationEvents.add(name)
      else this.notificationEvents.delete(name)
      void this.call('subscriptions', [...this.notificationEvents]).catch(error => {
        if (!this.closed && !this.restartTimer) this.fail(error)
      })
    }
    this.notificationListenerAdded = name => interestChanged(name, this.listenerCount(name) + 1)
    this.notificationListenerRemoved = name => interestChanged(name, this.listenerCount(name))
    this.on('newListener', this.notificationListenerAdded)
    this.on('removeListener', this.notificationListenerRemoved)
  }

  spawnWorker() {
    this.failure = null
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    this.ready.catch(() => {})
    const worker = this.worker = new Worker(new URL('./market-backend-worker.js', import.meta.url), { workerData: this.options })
    let settled = false
    const onLoss = error => {
      if (settled || this.worker !== worker) return
      settled = true
      this.handleWorkerFailure(worker, error)
    }
    worker.on('message', message => {
      if (this.worker !== worker) return
      if (message.type === 'ready') {
        const recovered = this.restartCount > 0
        this.restartCount = 0
        this.resolveReady()
        if (this.notificationEvents.size) {
          void this.call('subscriptions', [...this.notificationEvents]).catch(() => {})
        }
        if (recovered) this.emit('recovered')
        return
      }
      if (message.type === 'event') { this.emit(message.name, message.value); return }
      if (message.type === 'fatal') { onLoss(new Error(message.error)); return }
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
      else request.resolve(message.value)
    })
    worker.on('error', error => onLoss(error))
    worker.on('exit', code => {
      if (!this.closed) onLoss(new Error(`Market backend exited (${code}).`))
    })
  }

  handleWorkerFailure(worker, error) {
    this.failure = error
    this.rejectReady(error)
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    this.emit('failure', error)
    if (this.closed || this.disposal || this.options?.testMode || this.restartCount >= 3) return
    this.restartCount += 1
    const delay = Math.min(5_000, 500 * 2 ** (this.restartCount - 1))
    void worker.terminate().catch(() => {})
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.closed || this.disposal) return
      this.spawnWorker()
    }, delay)
    this.restartTimer.unref?.()
  }

  removeAllListeners(...args) {
    super.removeAllListeners(...args)
    // These are transport bookkeeping, not domain subscriptions. Preserve them
    // when a caller detaches every consumer so a later owner can subscribe.
    for (const [name, listener] of [['newListener', this.notificationListenerAdded], ['removeListener', this.notificationListenerRemoved]]) {
      if (listener && !this.listeners(name).includes(listener)) super.on(name, listener)
    }
    return this
  }

  fail(error) {
    this.failure = error
    this.rejectReady(error)
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    this.emit('failure', error)
  }

  call(method, value) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const request = { resolve, reject }
      void this.ready.then(() => {
        if (this.failure) throw this.failure
        if (this.closed) throw new Error('Market backend is closed.')
        this.pending.set(id, request)
        try { this.worker.postMessage({ id, method, value }) }
        catch (error) { this.pending.delete(id); request.reject(error) }
      }).catch(request.reject)
    })
  }

  request(value) { return this.call('request', value) }
  probe(value) { return this.call('probe', value) }
  presentation(active, epoch) { return this.call('presentation', { active, epoch }) }

  async dispose() {
    if (this.disposal) return this.disposal
    clearTimeout(this.restartTimer); this.restartTimer = null
    this.disposal = (async () => {
      try { if (!this.failure) await this.call('dispose') }
      finally { this.closed = true; await this.worker.terminate() }
    })()
    return this.disposal
  }
}
