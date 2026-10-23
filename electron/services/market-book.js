const OBSERVATION_TTL = 90_000
const aborted = signal => signal?.reason ?? new DOMException('The request was aborted.', 'AbortError')
const retired = message => new DOMException(message, 'AbortError')
const numeric = value => (typeof value === 'number' || typeof value === 'string'
  && /^[+-]?\d+(?:\.\d*)?(?:e[+-]?\d+)?$/i.test(value.trim())) && Number.isFinite(Number(value))

function bookFrom(value) {
  const malformed = () => new Error('OKX returned a malformed order-book observation.')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed()
  if (value.ts !== undefined && (!numeric(value.ts) || !Number.isSafeInteger(Number(value.ts)) || Number(value.ts) < 0)) throw malformed()
  const sideFrom = levels => {
    if (!Array.isArray(levels) || !levels.length) throw malformed()
    const copy = []
    for (const level of levels) {
      if (!Array.isArray(level) || !numeric(level[0]) || Number(level[0]) <= 0
        || !numeric(level[1]) || Number(level[1]) < 0) throw malformed()
      copy.push(Object.freeze([...level]))
    }
    return Object.freeze(copy)
  }
  return Object.freeze({ ...value, bids: sideFrom(value.bids), asks: sideFrom(value.asks) })
}

/** Candidate checks and recovery share one waiter-owned REST request per instrument. */
export class MarketBook {
  constructor(get, now = Date.now) {
    if (typeof get !== 'function' || typeof now !== 'function') throw new TypeError('Market book requires get and now functions.')
    this.get = get
    this.now = now
    this.snapshots = new Map()
    this.pending = new Map()
    this.disposed = false
  }

  observe(instId, signal, priority = 'foreground', currentObservation) {
    if (signal?.aborted) return Promise.reject(aborted(signal))
    if (this.disposed) return Promise.reject(retired('The order-book source is disposed.'))
    if (typeof instId !== 'string' || !instId) return Promise.reject(new TypeError('Market book requires an instrument ID.'))
    const now = this.now()
    const snapshot = this.snapshots.get(instId)
    // Caller-owned WS/raw memory can satisfy the read with its original
    // lease. Once validated, retain its immutable book across reevaluations.
    if (currentObservation && Number.isSafeInteger(currentObservation.observedAt) && currentObservation.observedAt <= now
      && Number.isSafeInteger(currentObservation.expiresAt) && currentObservation.expiresAt > now) {
      try {
        if (currentObservation === snapshot) return Promise.resolve(snapshot)
        const value = currentObservation.value === snapshot?.value ? snapshot.value : bookFrom(currentObservation.value)
        const observation = Object.freeze({ ...currentObservation, value })
        this.snapshots.set(instId, observation)
        return Promise.resolve(observation)
      } catch { /* Malformed memory cannot replace a validated source. */ }
    }
    if (snapshot && snapshot.observedAt <= now && snapshot.expiresAt > now) return Promise.resolve(snapshot)
    this.snapshots.delete(instId)
    let pending = this.pending.get(instId)
    if (!pending) {
      pending = { controller: new AbortController(), waiters: new Set(), settled: false, promise: null }
      this.pending.set(instId, pending)
      pending.promise = Promise.resolve().then(() => {
        pending.controller.signal.throwIfAborted()
        return this.get('/market/books', { instId, sz: '400' }, pending.controller.signal, priority)
      }).then(values => {
        pending.controller.signal.throwIfAborted()
        if (!Array.isArray(values) || !values.length) throw new Error('OKX returned no order-book observation.')
        const value = bookFrom(values[0]), observedAt = this.now()
        const observation = Object.freeze({ value, observedAt, expiresAt: observedAt + OBSERVATION_TTL })
        // An abort-ignoring transport cannot resurrect a retired acquisition.
        if (this.pending.get(instId) === pending) this.snapshots.set(instId, observation)
        return observation
      }).finally(() => {
        pending.settled = true
        if (this.pending.get(instId) === pending) this.pending.delete(instId)
      })
    }
    return new Promise((resolve, reject) => {
      const waiter = {}
      const finish = (complete, value) => {
        if (!pending.waiters.delete(waiter)) return
        signal?.removeEventListener('abort', onAbort)
        complete(value)
        if (!pending.settled && !pending.waiters.size && this.pending.get(instId) === pending) {
          this.pending.delete(instId)
          pending.controller.abort(aborted(signal))
        }
      }
      const onAbort = () => finish(reject, aborted(signal))
      waiter.cancel = reason => finish(reject, reason)
      pending.waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.promise.then(value => finish(resolve, value), error => finish(reject, error))
      if (signal?.aborted) onAbort()
    })
  }

  retire(instId, reason) {
    const pending = this.pending.get(instId)
    if (!pending) return
    this.pending.delete(instId)
    // Reject directly: a transport is allowed to ignore AbortSignal.
    for (const waiter of pending.waiters) waiter.cancel(reason)
    pending.controller.abort(reason)
  }

  invalidate(instId) {
    this.snapshots.delete(instId)
    this.retire(instId, retired('The order-book observation was invalidated.'))
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.snapshots.clear()
    for (const instId of this.pending.keys()) this.retire(instId, retired('The order-book source is disposed.'))
  }
}
