import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { _electron } from 'playwright'
import { backgroundTestEnvironment, prepareBackgroundApp } from './electron-test-runtime.mjs'

const { values } = parseArgs({ options: { app: { type: 'string' }, report: { type: 'string' }, cached: { type: 'boolean' }, 'max-ms': { type: 'string' } } })
if (!values.app) throw new Error('Usage: node scripts/benchmark-startup.mjs --app PATH [--cached] [--max-ms 1000] [--report PATH]')
const maximum = values['max-ms'] === undefined ? undefined : Number(values['max-ms'])
if (maximum !== undefined && (!Number.isFinite(maximum) || maximum <= 0)) throw new Error('--max-ms must be positive.')
const app = resolve(values.app)
const revision = JSON.parse(await readFile(join(app, 'Contents/Resources/build-revision.json'), 'utf8')).revision
const prepared = await prepareBackgroundApp({ sourceApp: app, executableName: 'Perpetual Swap Suite' })
const samples = []
const cachedProfile = values.cached ? await mkdtemp(join(tmpdir(), 'perp-startup-cached-')) : undefined
const launch = userData => _electron.launch({ executablePath: prepared.executable, args: ['--disable-gpu'],
  env: backgroundTestEnvironment(prepared, { ...process.env, PERPETUAL_SWAP_OPERATION_TRACE: '0', PERPETUAL_SWAP_OPERATION_DIR: '', ELECTRON_RUN_AS_NODE: undefined, ELECTRON_RENDERER_URL: undefined,
    PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0', PERPETUAL_SWAP_USER_DATA: userData }) })
async function close(electron) {
  if (!electron) return
  const child = electron.process()
  let timer
  try { await Promise.race([electron.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Startup benchmark shutdown timed out.')), 20_000) })]) }
  finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
  }
  assert.equal(child.exitCode, 0)
}
let fixture
try {
  if (cachedProfile) {
    let seed
    try {
      seed = await launch(cachedProfile)
      const page = await seed.firstWindow()
      fixture = await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedCachedListProjection' } }))
    } finally { await close(seed) }
  }
  for (let index = 0; index < 3; index++) {
    const userData = cachedProfile ?? await mkdtemp(join(tmpdir(), 'perp-startup-benchmark-'))
    let electron
    try {
      const started = performance.now(), startedAt = performance.timeOrigin + started
      electron = await launch(userData)
      // Resolve independently of renderer discovery/interaction; this is still an
      // automation-observed upper bound, not a worker-internal timestamp.
      const backendReady = electron.evaluate(async () => { await globalThis.__marketBackend.ready }).then(() => performance.now() - started)
      const page = await electron.firstWindow()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.waitForFunction(() => Boolean(document.querySelector('[data-market-list] input[aria-label="Search contracts"]') && document.querySelector('[data-chart-panel]') && document.querySelector('a[aria-label="Settings"]')), undefined, { timeout: 10_000 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const firstScreenMS = performance.now() - started
      const search = page.getByRole('textbox', { name: 'Search contracts' })
      await search.fill('startup-probe')
      await page.waitForFunction(() => document.querySelector('[data-market-status-row]')?.textContent?.includes(' / '))
      const readyMS = performance.now() - started
      await search.fill('')
      let cachedChartMS
      if (fixture) {
        await page.waitForFunction(instId => {
          const charts = [...document.querySelectorAll('[data-chart-inst]')]
          return charts.length === 3 && charts.every(chart => chart.getAttribute('data-chart-inst') === instId && chart.getAttribute('data-chart-candle-state') === 'ready' && Number(chart.getAttribute('data-chart-rendered-bars')) >= 96 && chart.querySelector('[data-chart-candle-direction]'))
        }, fixture.instId, { timeout: 10_000 })
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        cachedChartMS = performance.now() - started
      }
      const backendReadyUpperBoundMS = await backendReady
      const main = await electron.evaluate(() => ({ timeOrigin: performance.timeOrigin, uptimeMS: process.uptime() * 1000 }))
      const renderer = await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, navigation: performance.getEntriesByType('navigation')[0]?.toJSON(), paints: performance.getEntriesByType('paint').map(entry => entry.toJSON()) }))
      const metrics = await electron.evaluate(({ app }) => app.getAppMetrics().map(({ type, memory }) => ({ type, workingSetKB: memory.workingSetSize })))
      assert.deepEqual(errors, [], 'Startup must not encounter renderer exceptions.')
      const round = value => value === undefined ? undefined : Number(value.toFixed(2))
      samples.push({ firstScreenMS: round(firstScreenMS), readyMS: round(readyMS), cachedChartMS: round(cachedChartMS), backendReadyUpperBoundMS: round(backendReadyUpperBoundMS),
        launchToMainMS: round(main.timeOrigin - startedAt), launchToNavigationMS: round(renderer.timeOrigin - startedAt), main, renderer,
        workingSetMB: round(metrics.reduce((sum, item) => sum + item.workingSetKB, 0) / 1024), processes: metrics })
    } finally {
      try { await close(electron) } finally { if (!cachedProfile) await rm(userData, { recursive: true, force: true }) }
    }
  }
} finally { if (cachedProfile) await rm(cachedProfile, { recursive: true, force: true }) }
const median = field => [...samples].sort((a, b) => a[field] - b[field])[1][field]
const report = { app, revision, observedAt: new Date().toISOString(), mode: `guarded offscreen packaged replica; fresh processes; ${fixture ? 'persisted, unexpired market observations and SQLite candles, seed process excluded' : 'empty profiles'}; OS filesystem cache uncontrolled; recording disabled; readiness includes a verified React search interaction; no AI requests`,
  targetMS: maximum, meetsTarget: maximum === undefined ? undefined : samples.every(sample => sample.readyMS <= maximum && (!fixture || sample.cachedChartMS <= maximum)),
  medianReadyMS: median('readyMS'), maxReadyMS: Math.max(...samples.map(sample => sample.readyMS)), medianCachedChartMS: fixture ? median('cachedChartMS') : undefined, medianWorkingSetMB: median('workingSetMB'), samples }
if (values.report) await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ ...report, samples: samples.map(({ renderer, processes, ...sample }) => ({ ...sample, navigationMS: renderer.navigation.duration, paints: renderer.paints })) }, null, 2))
if (maximum !== undefined) assert.equal(report.meetsTarget, true, 'Every launch (including the first) must meet --max-ms; see the saved report.')
