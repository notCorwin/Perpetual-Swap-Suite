import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { exerciseInstrumentNavigation, installNavigationProbe, removeNavigationProbe } from './instrument-navigation-acceptance.mjs'

const root = new URL('..', import.meta.url).pathname
const userData = await mkdtemp(join(tmpdir(), 'perp-instrument-navigation-benchmark-'))
let electron
try {
  const executablePath = process.env.PERPETUAL_SWAP_EXECUTABLE_PATH
  electron = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), '--headless', '--disable-gpu'], cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
  const page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await installNavigationProbe(electron, page)
  const fixture = await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedInstrumentNavigationBenchmark' } }))
  const backgroundLoad = process.env.PERPETUAL_SWAP_BENCHMARK_BACKGROUND === '1'
  if (backgroundLoad) {
    await electron.evaluate(() => {
      const { MarketService } = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)('./electron/services/market-service.js')
      const original = MarketService.prototype.snapshot
      MarketService.prototype.snapshot = function (...args) {
        MarketService.prototype.snapshot = original
        globalThis.__backgroundBenchmark = this
        return original.apply(this, args)
      }
    })
    await page.evaluate(() => window.radarDesktop.request({ snapshot: { timeframe: '15m' } }))
    await electron.evaluate(async () => {
      const service = globalThis.__backgroundBenchmark
      const original = service.get.bind(service)
      service.get = async (path, parameters, ...rest) => {
        if (parameters?.instId !== 'LOAD-USDT-SWAP') return original(path, parameters, ...rest)
        if (path !== '/market/history-candles') return []
        const step = { '5m': 300_000, '15m': 900_000, '1H': 3_600_000 }[parameters.bar]
        const end = Math.floor((Number(parameters.after) - 1) / step) * step
        return Array.from({ length: Number(parameters.limit) }, (_, index) => [String(end - index * step), '100', '102', '99', '101', '100', '100', '10100', '1'])
      }
      service.instruments.set('LOAD-USDT-SWAP', { instId: 'LOAD-USDT-SWAP' })
      await service.history.target('LOAD-USDT-SWAP', { historyDays: 30 })
      await service.dataAuditRequest({ action: 'start' })
    })
  }
  const report = await exerciseInstrumentNavigation(electron, page, fixture)
  if (backgroundLoad) {
    report.background = await electron.evaluate(async () => {
      const service = globalThis.__backgroundBenchmark
      const audit = await service.dataAuditRequest({ action: 'status' })
      const tasks = service.history.sync.listTasks()
      const result = { source: 'offline synthetic source; real HistorySync, DataAudit, SQLite, DuckDB and Parquet',
        audit: { phase: audit.phase, progress: audit.progress }, tasks: tasks.length,
        writtenRecords: tasks.reduce((sum, task) => sum + (task.writtenRecords ?? 0), 0), writeMetrics: service.store.getWriteMetrics() }
      await service.dataAuditRequest({ action: 'cancel' })
      return result
    })
  }
  const percentile = (values, ratio) => {
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
  }
  for (const phase of report.phases) {
    phase.keyboardP50MS = Number(percentile(phase.keyboard.map(input => input.inputToSVGCommitMS), .5).toFixed(3))
    phase.keyboardP95MS = Number(percentile(phase.keyboard.map(input => input.inputToSVGCommitMS), .95).toFixed(3))
    if (backgroundLoad && phase.keyboardP95MS > 50) throw new Error(`Background keyboard p95 exceeds the 50ms budget: ${phase.keyboardP95MS}`)
    phase.maximumFramesToCommit = Math.max(phase.firstVisit.framesToCommit, phase.mouseSwitch.framesToCommit, phase.rapid.framesToCommit, ...phase.keyboard.map(input => input.framesToCommit))
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), mode: 'electron-native-instrument-navigation-input-to-svg-commit', candidates: fixture.instIds.length, periodsPerNativeSeries: fixture.periods, ...report }, null, 2))
} finally {
  if (electron) { await removeNavigationProbe(electron); await electron.close() }
  await rm(userData, { recursive: true, force: true })
}
