import { createOperationWorker, createWorkerRequest } from './worker-operations.js'
import { stopOperationWorker } from './operation-worker.js'

/** Exact streaming qualification runs outside Electron's main event loop. */
export class StreamLiquidityEvaluator {
  constructor() {
    this.worker = null
    this.pending = new Map()
    this.nextID = 0
    this.books = new Map()
    this.nextBookVersion = 0
    this.closed = false
    this.closeTask = null
  }

  startWorker() {
    const worker = createOperationWorker(new URL('./stream-liquidity-worker.js', import.meta.url), {}, 'stream-liquidity')
    this.worker = worker
    worker.unref()
    worker.on('message', ({ id, result, error }) => {
      if (this.worker !== worker) return
      const request = this.pending.get(id)
      if (!request) return
      this.pending.delete(id)
      if (!this.pending.size) worker.unref()
      if (error !== undefined) request.reject(new Error(error))
      else request.resolve(result)
    })
    worker.on('error', error => this.workerFailed(worker, error))
    worker.on('exit', code => this.workerFailed(worker, new Error(`Streaming liquidity worker exited unexpectedly (${code}).`)))
    return worker
  }

  workerFailed(worker, error) {
    if (this.worker !== worker) return
    this.worker = null
    this.books.clear()
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    // The next observation starts a fresh worker; an old exit event cannot
    // reject requests admitted to that replacement.
  }

  evaluate(input) {
    if (this.closed) return Promise.reject(new Error('Streaming liquidity evaluator is closed.'))
    return new Promise((resolve, reject) => {
      let worker
      const id = ++this.nextID
      const request = createWorkerRequest('stream-liquidity', 'evaluate', resolve, reject)
      try {
        worker = this.worker ?? this.startWorker()
        this.pending.set(id, request)
        worker.ref()
        const instId = input?.instrument?.instId
        const book = typeof instId === 'string' && input.book && typeof input.book === 'object' ? input.book : null
        const previous = book && this.books.get(instId)
        const snapshot = book ? previous?.book === book ? previous : { version: ++this.nextBookVersion, book } : null
        const evict = snapshot && !this.books.has(instId) && this.books.size >= 512 ? this.books.keys().next().value : undefined
        // Each immutable book crosses the boundary once per worker lifetime.
        // Later ticker/OI observations reference that exact captured version.
        request.dispatch(worker, { id, input: book ? { ...input, book: null } : input,
          ...(snapshot ? { bookVersion: snapshot.version, ...(snapshot !== previous ? { bookSnapshot: book } : {}) } : {}),
          ...(evict !== undefined ? { evictBook: evict } : {}) })
        if (snapshot) {
          if (evict !== undefined) this.books.delete(evict)
          this.books.delete(instId); this.books.set(instId, snapshot)
        }
      } catch (error) {
        this.pending.delete(id)
        if (worker && !this.pending.size) worker.unref()
        request.reject(error)
      }
    })
  }

  close() {
    if (this.closeTask) return this.closeTask
    this.closed = true
    const worker = this.worker
    this.worker = null
    this.books.clear()
    for (const request of this.pending.values()) request.reject(new Error('Streaming liquidity evaluator is closed.'))
    this.pending.clear()
    this.closeTask = worker ? stopOperationWorker(worker, 'stream-liquidity') : Promise.resolve()
    return this.closeTask
  }
}
