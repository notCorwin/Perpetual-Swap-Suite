import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MarketBackend } from '../electron/services/market-backend.js'

test('the desktop backend runs outside the caller and persists facts across process workers', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-backend-'))
  let backend = new MarketBackend({ userData, testMode: true })
  try {
    const status = await backend.request({ e2e: { action: 'smokeStatus' } })
    assert.ok(status.backendThreadId > 0)
    await backend.request({ preferences: { action: 'update', values: { rankingLookback: 30 } } })
    const row = { instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp: 300000,
      open: 100, high: 102, low: 99, close: 101, volume: 10, baseVolume: 1, quoteVolume: 101, confirmed: true }
    await backend.request({ e2e: { action: 'seedCandles', candles: [row] } })
    await backend.dispose()
    backend = new MarketBackend({ userData, testMode: true })
    const preferences = await backend.request({ preferences: { action: 'read' } })
    assert.equal(preferences.rankingLookback, 30)
    const rows = await backend.request({ e2e: { action: 'readCandles', instrument: row.instrument, timeframe: row.timeframe } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].close, 101)
  } finally { await backend.dispose(); await rm(userData, { recursive: true, force: true }) }
})

test('the worker rejects fixture probes in the production runtime', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-backend-production-'))
  const backend = new MarketBackend({ userData, testMode: false })
  try {
    await assert.rejects(backend.probe({ action: 'diagnostics' }), /unavailable outside tests/)
  } finally { await backend.dispose(); await rm(userData, { recursive: true, force: true }) }
})

test('worker chart delivery follows listener ownership and reconnects with complete frames', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-backend-consumers-'))
  const backend = new MarketBackend({ userData, testMode: true })
  const events: any[] = [], delivered: any[] = []
  const receive = (frame: any) => delivered.push(frame)
  backend.worker.on('message', message => { if (message.type === 'event' && message.name === 'chart') events.push(message.value) })
  const row = { instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp: 300000,
    open: 100, high: 104, low: 99, close: 101, volume: 10, baseVolume: 1, quoteVolume: 101, confirmed: true }
  try {
    await backend.request({ e2e: { action: 'seedCandles', candles: [row] } })
    const local = await backend.request({ chartLocal: { instId: row.instrument, timeframe: row.timeframe } })
    assert.equal(local.bars.at(-1).close, 101)
    assert.equal(events.length, 0, 'Read requests must not serialize notifications without a consumer.')
    backend.on('chart', receive)
    await backend.probe({ action: 'persistCandles', candles: [{ ...row, close: 102 }] })
    assert.ok(delivered.some(frame => frame.bars?.at(-1)?.close === 102))
    backend.removeAllListeners()
    await backend.request({ e2e: { action: 'smokeStatus' } })
    const count = events.length
    await backend.probe({ action: 'persistCandles', candles: [{ ...row, close: 103 }] })
    assert.equal(events.length, count, 'Removing the last consumer must stop worker-to-parent chart transfers.')
    backend.on('chart', receive)
    delivered.length = 0
    await backend.probe({ action: 'persistCandles', candles: [{ ...row, close: 101 }] })
    assert.ok(Array.isArray(delivered[0]?.bars), 'A reconnected consumer must receive a complete basis before compact updates.')
    assert.equal(delivered[0].bars.at(-1).close, 101)
  } finally { await backend.dispose(); await rm(userData, { recursive: true, force: true }) }
})
