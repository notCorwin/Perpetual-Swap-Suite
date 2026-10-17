// Chart scroll benchmark against a snapshot of the real user data.
// Compares cold compute wins before and after background compaction, and
// models the renderer's band pre-read (one 499-candle block ahead).
// Usage: node scripts/e2e-scroll-perf.mjs
import { cp, rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { performance } from 'node:perf_hooks'

const worktree = new URL('..', import.meta.url).pathname
const realData = join(process.env.HOME, 'Library/Application Support/perp-radar/MarketData')
const userData = '/private/var/folders/6w/xd0vzpj97rgbskfk5kd7vxrh0000gn/T/opencode/perf-userdata'
const HOUR = 3_600_000

const fragmentSurvey = async () => {
  const candles = join(userData, 'MarketData/candles')
  let fragmented = 0, extra = 0
  for (const frame of await readdir(candles)) {
    for (const inst of await readdir(join(candles, frame))) {
      for (const date of await readdir(join(candles, frame, inst))) {
        const files = (await readdir(join(candles, frame, inst, date))).filter(f => f.endsWith('.parquet'))
        if (files.length > 1) { fragmented++; extra += files.length - 1 }
      }
    }
  }
  return { fragmented, extra }
}

const percentiles = samples => {
  const sorted = [...samples].sort((a, b) => a - b)
  const pick = p => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
  return { min: sorted[0], p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) }
}

await rm(userData, { recursive: true, force: true })
await cp(realData, join(userData, 'MarketData'), { recursive: true })
const electron = await _electron.launch({
  args: ['.', '--headless', '--disable-gpu'],
  cwd: worktree,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_USER_DATA: userData, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0' },
})
const page = await electron.firstWindow()
await page.waitForLoadState('domcontentloaded')
const request = value => page.evaluate(v => window.radarDesktop.request(v), value)

const latest = await request({ chartInstId: 'BTC-USDT-SWAP', timeframe: '1H' })
const latestEnd = latest.bars.at(-1)?.hour
console.log(`latest window: bars=${latest.bars.length}`)

const scrollRun = async label => {
  const timings = []
  const step = 12 * HOUR
  for (let i = 1; i <= 24; i++) {
    const t = performance.now()
    const chart = await request({ chartInstId: 'BTC-USDT-SWAP', timeframe: '1H', chartEndHour: latestEnd - i * step })
    timings.push(performance.now() - t)
    if (chart.bars.length === 0) timings[timings.length - 1] = NaN
  }
  const good = timings.filter(Number.isFinite)
  const p = percentiles(good)
  console.log(`${label.padEnd(34)} p50=${p.p50.toFixed(0).padStart(4)}ms  p95=${p.p95.toFixed(0).padStart(4)}ms  max=${p.max.toFixed(0).padStart(4)}ms  (${good.length}/${timings.length} steps served)`)
}

const initial = await fragmentSurvey()
console.log(`fragments before compaction: ${initial.fragmented} dates / ${initial.extra} stale parts`)
await scrollRun('cold scroll (fragmented data)')
console.log('waiting 25s for background compaction…')
await new Promise(r => setTimeout(r, 25_000))
const after = await fragmentSurvey()
console.log(`fragments after compaction: ${after.fragmented} dates / ${after.extra} stale parts`)
// Fresh ends deeper than any previously visited viewport.
const deepRun = async label => {
  const timings = []
  const step = 12 * HOUR
  for (let i = 25; i <= 48; i++) {
    const t = performance.now()
    const chart = await request({ chartInstId: 'BTC-USDT-SWAP', timeframe: '1H', chartEndHour: latestEnd - i * step })
    timings.push(performance.now() - t)
    if (chart.bars.length === 0) timings[timings.length - 1] = NaN
  }
  const good = timings.filter(Number.isFinite)
  const p = percentiles(good)
  console.log(`${label.padEnd(34)} p50=${p.p50.toFixed(0).padStart(4)}ms  p95=${p.p95.toFixed(0).padStart(4)}ms  max=${p.max.toFixed(0).padStart(4)}ms  (${good.length}/${timings.length} steps served)`)
}
await deepRun('cold scroll after compaction')
// Band pre-read latency (what the renderer issues one block ahead).
for (let i = 1; i <= 3; i++) {
  const t = performance.now()
  const band = await request({ chartInstId: 'BTC-USDT-SWAP', timeframe: '1H', preview: true, sinceRevision: -1, chartEndHour: latestEnd - (499 + i * 499) * HOUR })
  console.log(`band pre-read ${i}: ${(performance.now() - t).toFixed(0)}ms bars=${band.bars.length} candleState=${band.candleState}`)
}
// A cached end to show the floor for repeat visits.
const t = performance.now()
await request({ chartInstId: 'BTC-USDT-SWAP', timeframe: '1H', chartEndHour: latestEnd - 12 * HOUR })
console.log(`repeat end (cached): ${(performance.now() - t).toFixed(0)}ms`)
await electron.close()
await rm(userData, { recursive: true, force: true })
