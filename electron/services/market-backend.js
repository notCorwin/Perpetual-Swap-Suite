import { createOperationWorker, createWorkerRequest } from './worker-operations.js'
import { EventEmitter } from 'node:events'

/** Electron owns windows; this worker owns market coordination and metadata. */
export class MarketBackend extends EventEmitter {
  constructor(options) {
    super()
    this.pending = new Map()
    this.sequence = 0
    this.closed = false
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    this.ready.catch(() => {})
    this.worker = createOperationWorker(new URL('./market-backend-worker.js', import.meta.url), { workerData: options }, 'market-backend')
    this.worker.on('message', message => {
      if (message.type === 'ready') { this.resolveReady(); return }
      if (message.type === 'event') { this.emit(message.name, message.value); return }
      if (message.type === 'fatal') { this.fail(new Error(message.error)); return }
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
      else request.resolve(message.value)
    })
    this.worker.on('error', error => this.fail(error))
    this.worker.on('exit', code => {
      if (!this.closed) this.fail(new Error(`Market backend exited (${code}).`))
    })
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
      const request = createWorkerRequest('market-backend', method, resolve, reject)
      void this.ready.then(() => {
        if (this.failure) throw this.failure
        if (this.closed) throw new Error('Market backend is closed.')
        this.pending.set(id, request)
        try { request.dispatch(this.worker, { id, method, value }) }
        catch (error) { this.pending.delete(id); request.reject(error) }
      }).catch(request.reject)
    })
  }

  request(value) { return this.call('request', value) }
  credentials() { return this.call('credentials') }
  probe(value) { return this.call('probe', value) }

  async dispose() {
    if (this.disposal) return this.disposal
    this.disposal = (async () => {
      try { if (!this.failure) await this.call('dispose') }
      finally { this.closed = true; await this.worker.terminate() }
    })()
    return this.disposal
  }
}
