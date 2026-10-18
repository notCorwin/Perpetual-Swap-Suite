import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MarketStore } from '../../electron/services/market-store.js'
import { MarketService } from '../../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../../electron/services/metadata-store.js'
import { seedMarketResources, startBackgroundArchive } from '../../electron/market-resource-fixtures.js'

const loadInstrument = 'LOAD-USDT-SWAP'
const delay = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds))
const waitFor = async (condition, description) => {
  const deadline = performance.now() + 5_000
  while (!condition()) {
    assert.ok(performance.now() < deadline, description)
    await delay(5)
  }
}
const gate = () => {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, release }
}
const loadWritten = service => service.history.sync.listTasks()
  .filter(task => task.instrument === loadInstrument && task.source === 'candles')
  .reduce((sum, task) => sum + task.writtenRecords, 0)

async function openFixture(fetcher = async () => new Response(JSON.stringify({ code: '0', data: [] }))) {
  const root = await mkdtemp(join(tmpdir(), 'perp-resource-start-'))
  const store = await MarketStore.open(root), preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
  const service = new MarketService(store, () => preferences, fetcher, false)
  await service.ready
  return { store, service, async close() {
    await service.dispose()
    await store.close()
    await rm(root, { recursive: true, force: true })
  } }
}

test('resource background readiness waits for committed LOAD candles after a clock-boundary backlog', async context => {
  const realNow = Date.now.bind(Date)
  // Keep timers real while advancing the service clock across a known 5m edge.
  // This also keeps the regression independent of when CI happens to start it.
  let offset = Math.floor(realNow() / 3_600_000) * 3_600_000 + 30_000 - realNow()
  context.mock.method(Date, 'now', () => realNow() + offset)
  const scaleSource = gate(), loadWrite = gate()
  let heldScaleCandles = 0, attemptedLoadWrites = 0, settled = false
  const f = await openFixture(async input => {
    const url = new URL(input)
    if (url.pathname.endsWith('/market/history-candles') && url.searchParams.get('instId')?.startsWith('SCALE')) {
      heldScaleCandles++
      await scaleSource.promise
    }
    return new Response(JSON.stringify({ code: '0', data: [] }))
  })
  let fixture, ready
  try {
    fixture = await seedMarketResources(f.store, f.service, { count: 2, periods: 300 })
    const append = f.store.appendCandles.bind(f.store)
    f.store.appendCandles = async (rows, ...args) => {
      if (rows.some(row => row.instrument === loadInstrument)) { attemptedLoadWrites++; await loadWrite.promise }
      return append(rows, ...args)
    }
    offset += 300_000
    f.service.processMarketDeadline()
    await waitFor(() => heldScaleCandles === 3, 'The boundary must occupy the three background candle slots before LOAD starts.')
    assert.ok(f.service.history.sync.listTasks().some(task => task.instrument.startsWith('SCALE') && task.purpose === 'history'))
    ready = startBackgroundArchive(f.store, f.service, { timeoutMS: 5_000, pollMS: 5 })
    ready.then(() => { settled = true }, () => { settled = true })
    await waitFor(() => f.service.history.sync.listTasks().some(task => task.instrument === loadInstrument), 'LOAD targets must be enqueued.')
    await delay(25)
    assert.equal(settled, false, 'Enqueuing behind the boundary backlog must not signal readiness.')
    assert.equal(attemptedLoadWrites, 0)
    assert.equal(loadWritten(f.service), 0)

    scaleSource.release()
    await waitFor(() => attemptedLoadWrites > 0, 'The LOAD source must eventually be admitted after older SCALE work.')
    await delay(25)
    assert.equal(settled, false, 'Source admission and an uncommitted append must not signal readiness.')
    assert.equal(loadWritten(f.service), 0)
    assert.equal((await f.store.coverage(loadInstrument, '5m')).count, 0)

    loadWrite.release()
    const result = await ready
    assert.ok(result.writtenRecords > 0)
    assert.ok(loadWritten(f.service) > 0)
    const counts = await Promise.all(['5m', '15m', '1H'].map(timeframe => f.store.coverage(loadInstrument, timeframe)))
    assert.ok(counts.some(coverage => coverage.count > 0), 'Readiness requires actual SQLite LOAD rows.')
    const final = await fixture.stop(); fixture = null
    assert.equal(final.actualRows, 2 * 3 * 300, 'Archive startup must preserve the synthetic display dataset.')
  } finally {
    scaleSource.release(); loadWrite.release()
    await ready?.catch(() => undefined)
    await fixture?.stop()
    await f.close()
  }
})

test('resource background readiness times out rather than treating seeded rows as LOAD progress', async () => {
  const f = await openFixture(), loadWrite = gate()
  let fixture, ready
  try {
    fixture = await seedMarketResources(f.store, f.service, { count: 1, periods: 300 })
    const append = f.store.appendCandles.bind(f.store)
    f.store.appendCandles = async (rows, ...args) => {
      if (rows.some(row => row.instrument === loadInstrument)) await loadWrite.promise
      return append(rows, ...args)
    }
    assert.ok(f.store.getWriteMetrics().rowsSubmitted > 0)
    ready = startBackgroundArchive(f.store, f.service, { timeoutMS: 150, pollMS: 5 })
    await assert.rejects(ready, /timed out|timeout/i)
    assert.equal(loadWritten(f.service), 0)
    assert.equal((await f.store.coverage(loadInstrument, '5m')).count, 0)
  } finally {
    loadWrite.release()
    await ready?.catch(() => undefined)
    await fixture?.stop()
    await f.close()
  }
})
