const FIVE_MINUTES = 300_000
const INTERVALS = new Map([['5m', FIVE_MINUTES], ['15m', 900_000], ['1H', 3_600_000]])
const RETENTION_MS = 3 * 3_600_000
const OI_FRESHNESS_MS = 30_000
const TRADE_REPLAY_LIMIT = 2_048
const timestamp = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const amount = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) >= 0
const instrument = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value)
const period = value => Math.floor(value / FIVE_MINUTES) * FIVE_MINUTES

/**
 * Statistics observed by the public socket, without a historical fallback.
 * A subscription beginning partway through a candle cannot establish its
 * taker totals. Each full native period needs one uninterrupted subscription;
 * confirmed totals additionally have to reconcile with its contract volume.
 */
export class LiveStatistics {
  constructor(options = {}) {
    this.now = options.now ?? Date.now
    if (typeof this.now !== 'function') throw new TypeError('now must be a function.')
    this.instruments = new Map()
    this.watermark = 0
  }

  state(instId, receivedAt, create = false) {
    if (!instrument(instId) || !timestamp(receivedAt)) return null
    this.watermark = Math.max(this.watermark, receivedAt)
    let state = this.instruments.get(instId)
    if (!state && create) {
      state = { active: null, coverage: [], trades: new Map(), interest: new Map(), replay: new Map(), retiredThrough: null, unsequencedEviction: false, prunedAt: null }
      this.instruments.set(instId, state)
    }
    if (state) this.prune(state)
    return state
  }

  prune(state) {
    const boundary = period(this.watermark)
    if (state.prunedAt === boundary) return
    state.prunedAt = boundary
    const cutoff = this.watermark - RETENTION_MS
    state.coverage = state.coverage.filter(value => value.through >= cutoff)
    for (const key of state.trades.keys()) if (key + FIVE_MINUTES <= cutoff) state.trades.delete(key)
    for (const key of state.interest.keys()) if (key + FIVE_MINUTES <= cutoff) state.interest.delete(key)
    for (const [id, value] of state.replay) if (value.timestamp < cutoff) state.replay.delete(id)
  }

  /** Call after acknowledgement of the instrument's trades subscription. */
  start(instId, receivedAt = this.now()) {
    const state = this.state(instId, receivedAt, true)
    if (state && state.active === null) state.active = receivedAt
  }

  /** Delisting/relisting must begin a new observation lifetime. */
  remove(instIds) {
    for (const instId of instIds) this.instruments.delete(instId)
  }

  /** Every interruption breaks coverage, even when reconnection is immediate. */
  disconnect(instIds, receivedAt = this.now()) {
    if (!Array.isArray(instIds) || !timestamp(receivedAt)) return
    for (const instId of instIds) {
      const state = this.state(instId, receivedAt)
      if (!state || state.active === null) continue
      state.coverage.push({ from: state.active, through: Math.max(state.active, receivedAt) })
      state.active = null
    }
    // Universe churn must not retain retired instruments indefinitely.
    for (const [instId, state] of this.instruments) {
      this.prune(state)
      if (state.active === null && !state.coverage.length && !state.trades.size && !state.interest.size) this.instruments.delete(instId)
    }
  }

  trades(instId, rows, receivedAt = this.now()) {
    const state = this.state(instId, receivedAt)
    if (!state || state.active === null || !Array.isArray(rows)) return
    for (const raw of rows) {
      const time = typeof raw?.ts === 'string' && raw.ts.trim() ? Number(raw.ts) : raw?.ts
      if (raw?.instId !== undefined && raw.instId !== instId) continue
      if (!timestamp(time) || time > receivedAt) { this.tradeBucket(state, receivedAt).valid = false; continue }
      if (time < state.active || time < this.watermark - RETENTION_MS) continue
      const bucket = this.tradeBucket(state, time)
      if (!raw || !['buy', 'sell'].includes(raw.side) || typeof raw.tradeId !== 'string' || !raw.tradeId.trim() || !amount(raw.sz)) {
        bucket.valid = false
        continue
      }
      const size = Number(raw.sz), fingerprint = `${raw.side}:${size}:${time}`
      const previous = state.replay.get(raw.tradeId)
      if (previous) {
        // Contradictory duplicates are not a trustworthy complete observation.
        if (previous.fingerprint !== fingerprint) {
          bucket.valid = false
          const original = state.trades.get(period(previous.timestamp))
          if (original) original.valid = false
        }
        continue
      }
      const sequence = /^\d{1,40}$/.test(raw.tradeId) ? BigInt(raw.tradeId) : null
      // The bounded window accepts genuine out-of-order IDs above the retired
      // watermark. An older unseen ID could be either a replay or a missing
      // trade; invalidate that period instead of guessing which it represents.
      if (sequence !== null && state.retiredThrough !== null && sequence <= state.retiredThrough
        || sequence === null && state.unsequencedEviction) { bucket.valid = false; continue }
      state.replay.set(raw.tradeId, { fingerprint, timestamp: time, sequence })
      if (state.replay.size > TRADE_REPLAY_LIMIT) {
        const oldest = state.replay.entries().next().value
        state.replay.delete(oldest[0])
        const retired = oldest[1].sequence
        if (retired === null) state.unsequencedEviction = true
        else if (state.retiredThrough === null || retired > state.retiredThrough) state.retiredThrough = retired
      }
      bucket.latestTimestamp = Math.max(bucket.latestTimestamp, time)
      // OKX sz is already the aggregate contract amount. count is execution
      // metadata, and multiplying by it would inflate taker volume.
      bucket[raw.side] += size
      if (!Number.isFinite(bucket[raw.side])) bucket.valid = false
    }
  }

  tradeBucket(state, time) {
    const key = period(time)
    let bucket = state.trades.get(key)
    if (!bucket) {
      bucket = { buy: 0, sell: 0, latestTimestamp: time, valid: true }
      state.trades.set(key, bucket)
    }
    return bucket
  }

  openInterest(instId, raw, receivedAt = this.now()) {
    const state = this.state(instId, receivedAt, true)
    const time = typeof raw?.ts === 'string' && raw.ts.trim() ? Number(raw.ts) : raw?.ts
    if (!state || !raw || raw.instId !== undefined && raw.instId !== instId || !timestamp(time)
      || time > receivedAt || time < this.watermark - RETENTION_MS || !amount(raw.oi)) return
    const key = period(time), sample = { timestamp: time, value: Number(raw.oi) }
    const previous = state.interest.get(key)
    // All chart closes are on the five-minute grid. Keep the final sample
    // before each close plus an exact boundary sample, when one exists.
    if (!previous) state.interest.set(key, { latest: sample, boundary: time === key ? sample : null })
    else {
      if (time >= previous.latest.timestamp) previous.latest = sample
      if (time === key) previous.boundary = sample
    }
  }

  canFinalize(candle, receivedAt = this.now()) {
    const interval = INTERVALS.get(candle.timeframe), start = candle.timestamp
    if (!interval || !timestamp(start) || start % interval || receivedAt < start + interval) return false
    const state = this.state(candle.instrument, receivedAt), close = start + interval
    return Boolean(state && (state.active !== null && state.active <= start
      || state.coverage.some(value => value.from <= start && value.through >= close)))
  }

  enrich(candle, receivedAt = this.now()) {
    const result = { ...candle }
    const interval = INTERVALS.get(candle.timeframe)
    if (!interval || !timestamp(candle.timestamp) || candle.timestamp % interval !== 0 || !timestamp(receivedAt)) return result
    const state = this.state(candle.instrument, receivedAt)
    if (!state) return result
    const close = candle.timestamp + interval
    const through = candle.confirmed ? close : Math.min(close, receivedAt)
    if (through < candle.timestamp || candle.timestamp < this.watermark - RETENTION_MS) return result

    // Contract OI is an instantaneous observation, never oiCcy or oiUsd. Only
    // a source sample at/before the chart observation may represent the bar.
    let latest = null
    for (const bucket of state.interest.values()) for (const sample of [bucket.latest, bucket.boundary]) {
      if (sample && sample.timestamp <= through && (!latest || sample.timestamp > latest.timestamp)) latest = sample
    }
    if (latest && through - latest.timestamp <= OI_FRESHNESS_MS) result.oi = latest.value

    const uninterrupted = state.active !== null && state.active <= candle.timestamp && receivedAt >= through
      || state.coverage.some(value => value.from <= candle.timestamp && value.through >= through)
    if (!uninterrupted || candle.confirmed && receivedAt < close) return result
    let buy = 0, sell = 0
    for (let time = candle.timestamp; time < close; time += FIVE_MINUTES) {
      const bucket = state.trades.get(time)
      if (bucket && (!bucket.valid || bucket.latestTimestamp > through)) return result
      buy += bucket?.buy ?? 0
      sell += bucket?.sell ?? 0
    }
    // Confirmation can race the final trade frame or follow data loss without
    // a transport close. Reconciliation prevents persisting partial totals.
    const total = buy + sell, volume = Number(candle.volume), tolerance = Math.max(1e-8, volume * 1e-10)
    if (!Number.isFinite(total) || !amount(candle.volume) || total + tolerance < volume
      || candle.confirmed && Math.abs(total - volume) > tolerance) return result
    result.buy = buy
    result.sell = sell
    return result
  }
}
