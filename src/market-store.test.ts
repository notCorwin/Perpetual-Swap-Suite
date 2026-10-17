import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'

const fiveMinutes = 300_000
const record = (timestamp: number) => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp, open: 100, high: 101, low: 99, close: 100, volume: 1, quoteVolume: 100, confirmed: true })

test('missingCandleRanges reports only contiguous gaps inside the requested 5m range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-store-'))
  const store = await MarketStore.open(root)
  try {
    const base = Date.UTC(2024, 0, 1)
    await store.appendCandles(Array.from({ length: 10 }, (_, index) => index).filter(index => ![2, 4, 5].includes(index)).map(index => record(base + index * fiveMinutes)))
    assert.deepEqual(await store.missingCandleRanges({ instrument: 'BTC-USDT-SWAP', from: base, through: base + 9 * fiveMinutes }), [
      { from: base + 2 * fiveMinutes, through: base + 2 * fiveMinutes },
      { from: base + 4 * fiveMinutes, through: base + 5 * fiveMinutes },
    ])
    assert.deepEqual(await store.missingCandleRanges({ instrument: 'BTC-USDT-SWAP', from: base + 3 * fiveMinutes, through: base + 6 * fiveMinutes }), [
      { from: base + 4 * fiveMinutes, through: base + 5 * fiveMinutes },
    ])
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('candles normalize numeric statistics from heterogeneous Parquet parts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-store-'))
  const store = await MarketStore.open(root)
  try {
    const timestamp = Date.UTC(2024, 0, 1)
    // The first part omits optional statistics, just like a raw/derived write
    // before direct OI/Taker hydration. A later part supplies them.
    await store.appendCandles([record(timestamp)])
    await store.appendCandles([{ ...record(timestamp), oi: 1_000, buy: 200, sell: 100 }])
    const [candle] = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: timestamp, through: timestamp })
    assert.equal(candle.oi, 1_000)
    assert.equal(candle.buy, 200)
    assert.equal(candle.sell, 100)
    assert.equal(typeof candle.oi, 'number')
    assert.equal(typeof candle.buy, 'number')
    assert.equal(typeof candle.sell, 'number')
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('catalog snapshots atomically round-trip through their Parquet cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-store-'))
  let store = await MarketStore.open(root)
  const first = { schemaVersion: 1, liquidityPolicyVersion: 1, criteriaKey: 'hourlyVolumeStabilityEnabled=1', savedAt: 1_700_000_000_000, entries: [{ instrument: { instId: 'BTC-USDT-SWAP' }, ticker: { last: '100' }, result: { turnover: 40_000_000 }, change24h: 2.5 }] }
  const second = { ...first, savedAt: first.savedAt + 1, entries: [{ instrument: { instId: 'ETH-USDT-SWAP' }, ticker: { last: '200' }, result: { turnover: 50_000_000 }, change24h: -3.5 }] }
  try {
    await store.writeCatalogSnapshot(first)
    assert.deepEqual(await store.readCatalogSnapshot(), first)
    await store.writeCatalogSnapshot(second)
    await store.close()
    store = await MarketStore.open(root)
    assert.deepEqual(await store.readCatalogSnapshot(), second)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('close drains work already admitted to the DuckDB lane and rejects new work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-store-'))
  const store = await MarketStore.open(root)
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const internal: any = store
  try {
    const admitted = internal.enqueue(async () => { await gate; return 'done' })
    const closing = store.close()
    await assert.rejects(() => internal.enqueue(async () => 'late'), /MarketStore is closed/)
    let closed = false
    void closing.then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(closed, false)
    release?.()
    assert.equal(await admitted, 'done')
    await closing
    assert.equal(closed, true)
  } finally { release?.(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('compaction folds superseded legacy parts back to one part per date', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-store-'))
  const store = await MarketStore.open(root)
  try {
    const base = Date.UTC(2024, 0, 1)
    const fullDay = (timestamp: number) => record(base + timestamp * fiveMinutes)
    // A legacy build left one Parquet part per write. Reconstruct that shape
    // by pairing appends in isolated roots with their produced parts into the
    // audited date directory under distinct names.
    const directory = join(root, 'candles', 'timeframe=5m', 'instrument=BTC-USDT-SWAP', 'date=2024-01-01')
    const plantLegacyPart = async (candles: Array<Record<string, unknown>>, name: string) => {
      const scratch = await mkdtemp(join(tmpdir(), 'perp-radar-legacy-'))
      try {
        const scratchStore = await MarketStore.open(scratch)
        await scratchStore.appendCandles(candles as never)
        await scratchStore.close()
        // The date folder groups candles by UTC day; the single appended batch
        // lands in exactly one partition directory.
        const scratchRoot = join(scratch, 'candles', 'timeframe=5m', 'instrument=BTC-USDT-SWAP/date=2024-01-01')
        const [part] = (await readdir(scratchRoot)).filter(name => name.endsWith('.parquet'))
        await copyFile(join(scratchRoot, part), join(directory, name))
      } finally { await rm(scratch, { recursive: true, force: true }) }
    }
    await mkdir(directory, { recursive: true })
    await plantLegacyPart(Array.from({ length: 6 }, (_, index) => fullDay(index)).map(row => ({ ...row, close: 100 })), 'part-a.parquet')
    await plantLegacyPart(Array.from({ length: 6 }, (_, index) => fullDay(index)).map(row => ({ ...row, close: 101 })), 'part-b.parquet')
    await plantLegacyPart(Array.from({ length: 6 }, (_, index) => fullDay(index)).map(row => ({ ...row, close: 999, confirmed: false })), 'part-c.parquet')
    await plantLegacyPart([{ ...fullDay(2), oi: 5_000, buy: 300, sell: 200 }], 'part-d.parquet')
    const before = (await readdir(directory)).filter(name => name.endsWith('.parquet'))
    assert.equal(before.length, 4)
    await store.compactLegacyParts()
    const after = (await readdir(directory)).filter(name => name.endsWith('.parquet'))
    assert.equal(after.length, 1, 'Compaction folds the whole legacy pile into one part.')
    let rows = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base + 5 * fiveMinutes })
    assert.equal(rows.length, 6)
    // The newest written observation keeps winning per timestamp, including
    // the statistics patch recorded before compaction.
    assert.equal(rows[2].close, 100)
    assert.equal(rows[2].confirmed, true)
    assert.equal(rows[2].oi, 5_000)
    // The seven rows now come from the compacted part plus the later append.
    assert.equal(rows.filter(row => row.timestamp !== base + 2 * fiveMinutes && row.timestamp !== base + 6 * fiveMinutes).every(row => row.close === 999 && row.confirmed === false), true)
    // Min/max/count coverage is unchanged by compaction, so cached scans stay valid.
    let coverage = await store.coverage('BTC-USDT-SWAP', '5m')
    assert.deepEqual([coverage.first, coverage.last], [base, base + 5 * fiveMinutes])
    // Writes after compaction stay mergeable in one part.
    await store.appendCandles([{ ...fullDay(6) }])
    coverage = await store.coverage('BTC-USDT-SWAP', '5m')
    assert.deepEqual([coverage.first, coverage.last], [base, base + 6 * fiveMinutes])
    rows = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base + 6 * fiveMinutes })
    assert.equal(rows.length, 7)
    assert.equal(rows.at(-1)!.close, 100)
    const finalParts = (await readdir(directory)).filter(name => name.endsWith('.parquet'))
    assert.equal(finalParts.length, 1, 'Writes after compaction keep the partition merged.')
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})
