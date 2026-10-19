import { Worker } from 'node:worker_threads'
import { stopOperationWorker } from './operation-worker.js'

/** Exact streaming qualification runs outside Electron's main event loop. */
export class StreamLiquidityEvaluator {
  constructor() {
    this.worker = null
    this.pending = new Map()
    this.nextID = 0
    this.closed = false
    this.closeTask = null
  }

  startWorker() {
    const worker = new Worker(new URL('./stream-liquidity-worker.js', import.meta.url))
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
      try {
        worker = this.worker ?? this.startWorker()
        this.pending.set(id, { resolve, reject })
        worker.ref()
        // postMessage captures this input synchronously. Later observations
        // cannot change which snapshot the returned result describes.
        worker.postMessage({ id, input })
      } catch (error) {
        this.pending.delete(id)
        if (worker && !this.pending.size) worker.unref()
        reject(error)
      }
    })
  }

  close() {
    if (this.closeTask) return this.closeTask
    this.closed = true
    const worker = this.worker
    this.worker = null
    for (const request of this.pending.values()) request.reject(new Error('Streaming liquidity evaluator is closed.'))
    this.pending.clear()
    this.closeTask = worker ? stopOperationWorker(worker, 'stream-liquidity') : Promise.resolve()
    return this.closeTask
  }
}
