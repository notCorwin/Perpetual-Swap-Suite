import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregatePriceCandles } from '../electron/services/candle-aggregation.js'
import { CandleDerivations } from '../electron/services/candle-derivations.js'
import type { CandleRecord } from '../electron/services/market-store.js'

const step = 300_000, base = Date.UTC(2024, 0, 1), instId = 'BTC-USDT-SWAP'
const child = (index: number, patch: Partial<CandleRecord> = {}): CandleRecord => ({
  instrument: instId, timeframe: '5m', timestamp: base + index * step,
  open: 100 + index, high: 110 + index, low: 90 + index, close: 101 + index,
  volume: index + 1, baseVolume: (index + 1) / 10, quoteVolume: (index + 1) * 100,
  confirmed: true, ...patch,
})

test('forming parent uses a contiguous bounded prefix and revised extrema, never invented child periods', () => {
  const rows = [child(0), child(1), child(2, { confirmed: false, high: 200 })]
  let value = aggregatePriceCandles(rows, '15m', { forming: true })!
  assert.equal(value.confirmed, false)
  assert.equal(value.high, 200)
  assert.equal(value.volume, 6)
  assert.equal(aggregatePriceCandles(rows, '15m'), null)
  assert.equal(aggregatePriceCandles([rows[0], rows[2]], '15m', { forming: true }), null)
  rows[2] = child(2, { confirmed: false, high: 105 })
  value = aggregatePriceCandles(rows, '15m', { forming: true })!
  assert.equal(value.high, 111, 'A corrected child high must remove the old parent maximum.')
  rows[2] = child(2)
  assert.equal(aggregatePriceCandles(rows, '15m')!.confirmed, true)
})

test('live hydration is deduplicated and publishes the newest revision rather than its admitted snapshot', async () => {
  let reads = 0, release!: (rows: CandleRecord[]) => void
  const held = new Promise<CandleRecord[]>(resolve => { release = resolve })
  const emitted: { row: CandleRecord; receivedAt?: number }[] = []
  const derived = new CandleDerivations({ store: { candles: async () => { reads++; return held } },
    onLive: (_instId, _timeframe, row, context) => { if (row) emitted.push({ row, receivedAt: context.receivedAt }) } })
  const first = derived.observe(child(2, { confirmed: false }), { receivedAt: 100 })
  const second = derived.observe(child(2, { confirmed: false, volume: 10, close: 104 }), { receivedAt: 200 })
  assert.equal(reads, 1)
  assert.equal(emitted.length, 0)
  release([child(0), child(1)])
  await Promise.all([first, second])
  assert.equal(emitted.length, 2)
  for (const value of emitted) {
    assert.equal(value.row.close, 104)
    assert.equal(value.row.volume, 13)
    assert.equal(value.receivedAt, 200)
    assert.equal(value.row.confirmed, false)
  }
  derived.close()
})

test('a retired instrument cannot publish a pending prefix from its former observation lifetime', async () => {
  let release!: (rows: CandleRecord[]) => void
  const emitted: CandleRecord[] = []
  const derived = new CandleDerivations({ store: { candles: () => new Promise(resolve => { release = resolve }) }, onLive: (_id, _tf, row) => { if (row) emitted.push(row) } })
  const pending = derived.observe(child(2, { confirmed: false }))
  derived.remove([instId])
  release([child(0), child(1)])
  await pending
  assert.deepEqual(emitted, [])
  derived.close()
})

test('a prefix read cannot resurrect a child removed by an intervening canonical replacement', async () => {
  let release!: (rows: CandleRecord[]) => void
  const emitted: CandleRecord[] = []
  const derived = new CandleDerivations({ store: { candles: () => new Promise(resolve => { release = resolve }) }, onLive: (_id, _tf, row) => { if (row) emitted.push(row) } })
  const pending = derived.observe(child(2, { confirmed: false }))
  derived.correct(instId, [child(0, { high: 105 })], { from: base, through: base + step })
  release([child(0), child(1)])
  await pending
  assert.deepEqual(emitted, [])
  derived.close()
})

test('archive corrections neither restart live hydration nor republish unchanged forming parents', async () => {
  let release!: (rows: CandleRecord[]) => void
  const emitted: CandleRecord[] = []
  const derived = new CandleDerivations({ store: { candles: () => new Promise(resolve => { release = resolve }) },
    onLive: (_id, _tf, row) => { if (row) emitted.push(row) } })
  const pending = derived.observe(child(2, { confirmed: false }))
  const archived = child(-100), range = { from: archived.timestamp, through: archived.timestamp }
  derived.correct(instId, [archived], range)
  release([child(0), child(1)])
  await pending
  assert.equal(emitted.length, 2, 'An unrelated archive write cannot discard the admitted live prefix.')
  derived.correct(instId, [archived], range)
  derived.correct(instId, [], range)
  assert.equal(emitted.length, 2, 'Archive work cannot enqueue identical current-parent calculations.')
  derived.close()
})
