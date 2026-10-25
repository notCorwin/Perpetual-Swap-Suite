import { aggregatePriceCandles } from './candle-aggregation.js'

const BASE = 300_000, HOUR = 3_600_000
const periods = [['15m', 900_000], ['1H', HOUR]]

/** Bounded live prefixes. A missing prefix is read once, outside live delivery. */
export class CandleDerivations {
  constructor({ store, onLive }) {
    this.store = store; this.onLive = onLive
    this.series = new Map(); this.closed = false
  }

  observe(row, context = {}) {
    if (this.closed || row.timeframe !== '5m') return Promise.resolve()
    let state = this.series.get(row.instrument)
    if (!state) {
      state = { instrument: row.instrument, rows: new Map(), latest: row.timestamp, receivedAt: context.receivedAt, loadedHour: null, loading: null, published: new Set(), retryAt: 0, revision: 0 }
      this.series.set(row.instrument, state)
    }
    const previous = state.rows.get(row.timestamp)
    if (previous?.confirmed && !row.confirmed || previous && !row.confirmed && row.volume < previous.volume) return Promise.resolve()
    if (row.confirmed) state.revision += 1
    state.rows.set(row.timestamp, row)
    if (row.timestamp >= state.latest) { state.latest = row.timestamp; state.receivedAt = context.receivedAt }
    for (const stamp of state.rows.keys()) if (stamp < state.latest - HOUR) state.rows.delete(stamp)
    this.publish(state)
    const hour = Math.floor(state.latest / HOUR) * HOUR
    if (state.latest === hour) state.loadedHour = hour
    if (state.loadedHour === hour || state.loading || state.retryAt > Date.now()) return state.loading ?? Promise.resolve()
    state.loadedHour = hour
    const revision = state.revision
    state.loading = this.store.candles({ instrument: row.instrument, timeframe: '5m', from: hour, through: state.latest - BASE }, 'background')
      .then(rows => {
        if (this.closed || this.series.get(row.instrument) !== state) return
        if (state.revision !== revision) { state.loadedHour = null; return }
        for (const value of rows) if (!state.rows.has(value.timestamp) && value.timestamp >= state.latest - HOUR) state.rows.set(value.timestamp, value)
        state.retryAt = 0
        this.publish(state)
      }).catch(() => { if (this.series.get(row.instrument) === state) { state.loadedHour = null; state.retryAt = Date.now() + 1000 } })
      .finally(() => { state.loading = null })
    return state.loading
  }

  publish(state) {
    if (this.closed || this.series.get(state.instrument) !== state) return
    for (const [timeframe, interval] of periods) {
      const start = Math.floor(state.latest / interval) * interval, rows = []
      for (let stamp = start; stamp <= state.latest; stamp += BASE) {
        const row = state.rows.get(stamp)
        if (!row) break
        rows.push(row)
      }
      const row = rows.length === (state.latest - start) / BASE + 1 ? aggregatePriceCandles(rows, timeframe, { forming: true }) : null
      // Completed buckets are published only after their writer transaction.
      if (row && !row.confirmed) {
        state.published.add(timeframe)
        void this.onLive(state.instrument, timeframe, row, { receivedAt: state.receivedAt })
      } else if (!row && state.published.delete(timeframe)) void this.onLive(state.instrument, timeframe, null, { receivedAt: state.receivedAt })
    }
  }

  correct(instId, rows, replacement) {
    const state = this.series.get(instId)
    if (!state || this.closed) return
    const from = state.latest - HOUR, through = state.latest
    if (!rows.some(row => row.timeframe === '5m' && row.timestamp >= from && row.timestamp <= through)
      && !(replacement && replacement.from <= through && replacement.through >= from)) return
    state.revision += 1
    if (replacement) for (const stamp of state.rows.keys()) if (stamp >= replacement.from && stamp <= replacement.through) state.rows.delete(stamp)
    for (const row of rows) if (row.timeframe === '5m' && row.timestamp >= state.latest - HOUR && row.timestamp <= state.latest) state.rows.set(row.timestamp, row)
    this.publish(state)
  }

  remove(instIds) { for (const instId of instIds) this.series.delete(instId) }
  close() { this.closed = true; this.series.clear() }
}
