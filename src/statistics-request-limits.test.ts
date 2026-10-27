import { test, type TestContext } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'

const response = () => new Response(JSON.stringify({ code: '0', data: [] }))
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const fixture = async (context: TestContext, fetcher: typeof fetch) => {
  const root = await mkdtemp(join(tmpdir(), 'perp-statistics-limits-'))
  const store = await MarketStore.open(root)
  const service = new MarketService(store, undefined, fetcher, false)
  await service.ready
  context.after(async () => {
    context.mock.timers.reset()
    await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true })
  })
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  return { service, async tick(ms: number) { context.mock.timers.tick(ms); await flush() } }
}

for (const [path, spacing] of [['/rubik/stat/contracts/open-interest-history', 200], ['/rubik/stat/taker-volume-contract', 400]] as const) {
  test(`${path} shares one instrument's period budget while other instruments proceed`, async context => {
    const starts: { instId: string | null; period: string | null; at: number }[] = []
    const { service, tick } = await fixture(context, async input => {
      const url = new URL(String(input))
      starts.push({ instId: url.searchParams.get('instId'), period: url.searchParams.get('period'), at: Date.now() })
      return response()
    })
    const requests = [
      service.get(path, { instId: 'BTC-USDT-SWAP', period: '5m' }),
      service.get(path, { instId: 'BTC-USDT-SWAP', period: '15m' }),
      service.get(path, { instId: 'ETH-USDT-SWAP', period: '5m' }),
    ]
    await tick(0)
    assert.deepEqual(starts.map(value => [value.instId, value.period]), [['BTC-USDT-SWAP', '5m'], ['ETH-USDT-SWAP', '5m']])
    assert.equal(starts[0].at, starts[1].at, 'Independent instruments must not wait for another instrument rate window.')
    await tick(spacing - 1); assert.equal(starts.length, 2)
    await tick(1); assert.equal(starts.length, 3)
    assert.equal(starts[2].period, '15m')
    assert.equal(starts[2].at - starts[0].at, spacing)
    await Promise.all(requests)
  })

  test(`${path} applies Retry-After to the limited instrument only`, async context => {
    const starts: string[] = []
    const { service, tick } = await fixture(context, async input => {
      const id = new URL(String(input)).searchParams.get('instId')!
      starts.push(id)
      return starts.length === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '60' } }) : response()
    })
    const failed = assert.rejects(service.get(path, { instId: 'BTC-USDT-SWAP', period: '5m' }), /rate limited/)
    await tick(0); await failed
    const retry = service.get(path, { instId: 'BTC-USDT-SWAP', period: '15m' })
    const independent = service.get(path, { instId: 'ETH-USDT-SWAP', period: '5m' })
    await tick(0); await independent
    assert.deepEqual(starts, ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'])
    await tick(59_999); assert.equal(starts.length, 2)
    await tick(1); await retry
    assert.deepEqual(starts, ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'BTC-USDT-SWAP'])
  })
}

test('a shared queued request can acquire interactive priority without another HTTP request', async context => {
  const starts: string[] = [], releases: (() => void)[] = []
  const { service, tick } = await fixture(context, async input => {
    starts.push(new URL(String(input)).searchParams.get('id')!)
    return new Promise(resolve => releases.push(() => resolve(response())))
  })
  service.requestLanes.get('candles').interval = 0
  const requests: Promise<unknown>[] = []
  for (let index = 0; index < 3; index++) requests.push(service.get('/market/history-candles', { id: `archive-${index}` }, undefined, 'background'))
  let priority = 'background'
  requests.push(service.get('/market/history-candles', { id: 'shared' }, undefined, 'background', { getPriority: () => priority }))
  await tick(0); assert.equal(starts.length, 3)
  priority = 'interactive'; service.wakeRequestQueues()
  await tick(0)
  assert.deepEqual(starts, ['archive-0', 'archive-1', 'archive-2', 'shared'])
  for (const release of releases) release()
  await Promise.all(requests)
})

test('a malformed successful envelope cannot certify an empty statistics observation', async context => {
  const { service, tick } = await fixture(context, async () => new Response(JSON.stringify({ code: '0' })))
  const failed = assert.rejects(service.get('/rubik/stat/contracts/open-interest-history', { instId: 'BTC-USDT-SWAP', period: '5m' }), /data array/)
  await tick(0)
  await failed
})

test('price observation times cannot renew absent statistics without persisted source proof', async context => {
  const { service } = await fixture(context, async () => response())
  const timestamp = Math.floor(Date.now() / 300_000) * 300_000 - 300_000
  const normalized = service.preparedCharts.normalize({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp,
    open: 100, high: 101, low: 99, close: 100, volume: 1, baseVolume: 1, quoteVolume: 100,
    confirmed: true, oi: null, buy: null, sell: null, statisticsVersion: 11, writtenAt: Date.now() })
  assert.equal(normalized.statisticsOIExpiresAt, 0)
  assert.equal(normalized.statisticsTakerExpiresAt, 0)
})

test('parallel instrument buckets retain a bounded global HTTP workload', async context => {
  let active = 0, maximum = 0
  const controller = new AbortController()
  const { service, tick } = await fixture(context, async (_input, options) => {
    active += 1; maximum = Math.max(maximum, active)
    return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => { active -= 1; reject(options.signal!.reason) }, { once: true }))
  })
  for (const lane of service.requestLanes.values()) lane.interval = 0
  const paths = ['/rubik/stat/contracts/open-interest-history', '/rubik/stat/taker-volume-contract', '/market/books']
  const requests = paths.flatMap(path => Array.from({ length: 16 }, (_, index) => {
    const result = service.get(path, { instId: `ASSET${index}-USDT-SWAP` }, controller.signal, 'interactive')
    void result.catch(() => undefined)
    return result
  }))
  await tick(0)
  assert.equal(maximum, 24)
  assert.equal(service.activeRequests.size, 24)
  controller.abort()
  await Promise.allSettled(requests)
  assert.equal(service.activeRequests.size, 0)
})
