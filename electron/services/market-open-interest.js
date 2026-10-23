const OBSERVATION_TTL = 90_000
const aborted = signal => signal?.reason ?? new DOMException('The request was aborted.', 'AbortError')

function serverRetryAt(error, now) {
  // The HTTP scheduler exposes Retry-After as a millisecond delay. Also
  // accept the original header when a different transport retains it.
  let deadline = typeof error?.retryAfter === 'number' && Number.isFinite(error.retryAfter) && error.retryAfter >= 0
    ? now + error.retryAfter : now
  const headers = error?.headers ?? error?.response?.headers
  const header = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'] ?? headers?.['Retry-After']
  if (typeof header === 'string' && header.trim()) {
    const seconds = Number(header), timestamp = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1_000 : Date.parse(header)
    if (Number.isFinite(timestamp)) deadline = Math.max(deadline, timestamp)
  }
  return deadline
}

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
    this.failures = 0
    this.retryAt = 0
    this.failure = null
  }

  observe(signal, priority = 'foreground', force = false) {
    if (signal?.aborted) return Promise.reject(aborted(signal))
    const now = this.now()
    if (!force && this.snapshot && this.snapshot.observedAt <= now && this.snapshot.expiresAt > now) return Promise.resolve(this.snapshot.values)
    // Every caller, including an explicit refresh, shares the failed source's
    // deadline. Rejections never renew this deadline or count as new attempts.
    if (this.retryAt > now) return Promise.reject(this.failure)
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
        if (this.pending === pending) {
          this.snapshot = { values: observations, observedAt, expiresAt: observedAt + OBSERVATION_TTL }
          this.failures = 0; this.retryAt = 0; this.failure = null
        }
        return observations
      }).catch(error => {
        // Retired scans may abort with any reason, including an ordinary
        // Error, and a noncooperative transport may reject much later.
        if (this.pending === pending && !pending.controller.signal.aborted) {
          this.failures = Math.min(6, this.failures + 1)
          const now = this.now(), delay = Math.min(30_000, 1_000 * 2 ** (this.failures - 1))
          this.retryAt = Math.max(now + delay, serverRetryAt(error, now))
          this.failure = error
        }
        throw error
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
