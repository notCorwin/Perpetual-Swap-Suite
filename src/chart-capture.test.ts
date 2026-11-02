import assert from 'node:assert/strict'
import test from 'node:test'
import { captureStableChart } from './chart-capture.ts'
import { analysisSessionKey, ChartAnalysisStore } from './chart-analysis.ts'

test('a chart change while pixels are in flight rejects the capture', async () => {
  let release!: (image: string) => void
  let revision = 1
  const captured = revision
  const promise = captureStableChart(() => new Promise<string>(resolve => { release = resolve }), () => revision === captured)
  revision++
  release('pixels from a different chart')
  await assert.rejects(promise, /changed during capture/)
})

test('analysis sessions retain their original timeframe across navigation', async () => {
  const store = new ChartAnalysisStore(async (_, text) => text('15 minute answer'), async () => ({ model: 'model', hasAPIKey: true }))
  const fifteen = analysisSessionKey('BTC-USDT-SWAP', '15m')
  const hourly = analysisSessionKey('BTC-USDT-SWAP', '1H')
  await store.analyze(fifteen, async () => ({ imageDataURL: 'data:image/png;base64,AA==', width: 1, height: 1, capturedAt: 1, rangeLabel: '15m' }))
  assert.equal(store.get(hourly), null)
  assert.equal(store.get(fifteen)?.turns[0].text, '15 minute answer')
})
