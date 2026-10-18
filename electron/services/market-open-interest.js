const SNAPSHOT_REUSE_MS = 30_000
const OBSERVATION_TTL = 90_000
const aborted = signal => signal?.reason ?? new DOMException('The request was aborted.', 'AbortError')

function observationsFrom(values, observedAt) {
  if (!Array.isArray(values) || !values.length) throw new Error('OKX returned no swap open-interest observations.')
  const observations = new Map()
  for (const value of values) {
    const id = value?.instId, amount = value?.oiUsd
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof id !== 'string' || !/^[A-Z0-9]+-[A-Z0-9]+-SWAP$/.test(id)
      || typeof amount !== 'number' && typeof amount !== 'string'
      || typeof amount === 'string' && !amount.trim()
      || !Number.isFinite(Number(amount)) || Number(amount) < 0) {
      throw new Error('OKX returned a malformed swap open-interest observation.')
    }
    if (observations.has(id)) throw new Error(`OKX returned duplicate open-interest observations for ${id}.`)
    observations.set(id, { value: { ...value }, observedAt, expiresAt: observedAt + OBSERVATION_TTL })
  }
  return observations
}

/** One bulk source snapshot serves every contract without per-contract HTTP. */
export class MarketOpenInterest {
  constructor(get, now = Date.now) {
    if (typeof get !== 'function' || typeof now !== 'function') throw new TypeError('Open interest requires get and now functions.')
    this.get = get
    this.now = now
    this.snapshot = null
    this.pending = null
  }

  observe(signal, priority = 'foreground', force = false) {
    if (signal?.aborted) return Promise.reject(aborted(signal))
    if (!force && this.snapshot && this.now() - this.snapshot.observedAt < SNAPSHOT_REUSE_MS) return Promise.resolve(this.snapshot.values)
    let pending = this.pending
    if (!pending) {
      pending = { controller: new AbortController(), waiters: new Set(), settled: false, promise: null }
      this.pending = pending
      pending.promise = Promise.resolve().then(() => {
        pending.controller.signal.throwIfAborted()
        return this.get('/public/open-interest', { instType: 'SWAP' }, pending.controller.signal, priority)
      }).then(values => {
        pending.controller.signal.throwIfAborted()
        const observedAt = this.now(), observations = observationsFrom(values, observedAt)
        // A transport may resolve even after cancellation. Its retired result
        // must never replace the snapshot from a newer acquisition.
        if (this.pending === pending) this.snapshot = { values: observations, observedAt }
        return observations
      }).finally(() => {
        pending.settled = true
        if (this.pending === pending) this.pending = null
      })
    }
    return new Promise((resolve, reject) => {
      const waiter = {}
      const finish = (complete, value) => {
        if (!pending.waiters.delete(waiter)) return
        signal?.removeEventListener('abort', onAbort)
        complete(value)
        // Discovery and renewal can share the request. One retiring scan
        // cannot cancel observations still needed by another live caller.
        if (!pending.settled && !pending.waiters.size && this.pending === pending) {
          this.pending = null
          pending.controller.abort(aborted(signal))
        }
      }
      const onAbort = () => finish(reject, aborted(signal))
      pending.waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.promise.then(value => finish(resolve, value), error => finish(reject, error))
      if (signal?.aborted) onAbort()
    })
  }
}
