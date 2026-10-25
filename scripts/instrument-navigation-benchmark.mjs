import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { exerciseInstrumentNavigation, installNavigationProbe, persistNavigationCatalog, removeNavigationProbe, selectionRequests, startupNavigationReport } from './instrument-navigation-acceptance.mjs'

const root = new URL('..', import.meta.url).pathname
const userData = await mkdtemp(join(tmpdir(), 'perp-instrument-navigation-benchmark-'))
let electron
try {
  const executablePath = process.env.PERPETUAL_SWAP_EXECUTABLE_PATH
  electron = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), '--headless', '--disable-gpu'], cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
  let page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await installNavigationProbe(electron)
  const fixture = await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedInstrumentNavigationBenchmark' } }))
  const backgroundLoad = process.env.PERPETUAL_SWAP_BENCHMARK_BACKGROUND === '1'
  if (backgroundLoad) await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'backgroundStart' }))
  const report = await exerciseInstrumentNavigation(electron, page, fixture)
  if (backgroundLoad) report.background = await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'backgroundStatus' }))
  if (!executablePath) {
    await persistNavigationCatalog(electron, page)
    await removeNavigationProbe(electron)
    await electron.close()
    const launchedAt = Date.now()
    electron = await _electron.launch({ args: ['-r', './scripts/instrument-navigation-bootstrap.cjs', '.', '--headless', '--disable-gpu'], cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
    page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const startup = await startupNavigationReport(page, launchedAt, fixture)
    const requests = await electron.evaluate(() => globalThis.__navigationStartupRequests.requests)
    startup.selectionIPC = selectionRequests({ requests }).filter(request => request.instId === startup.instId
      && request.at >= startup.inputEpoch - 1 && request.at <= startup.commitEpoch + 1).length
    if (startup.framesToCommit > 1 || startup.inputToSVGCommitMS > 50 || startup.selectionIPC > 2 || startup.violations.length
      || !startup.rendererFramesBeforeInput.includes(`${startup.timeframe}:${startup.instId}`)) throw new Error(`Warm startup selection exceeded the local-read budget: ${JSON.stringify(startup)}`)
    await installNavigationProbe(electron)
    report.restart = { startup, ...await exerciseInstrumentNavigation(electron, page, fixture, { holdHistory: false }) }
  }
  const percentile = (values, ratio) => {
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
  }
  for (const phase of [...report.phases, ...(report.restart?.phases ?? [])]) {
    phase.keyboardP50MS = Number(percentile(phase.keyboard.map(input => input.inputToSVGCommitMS), .5).toFixed(3))
    phase.keyboardP95MS = Number(percentile(phase.keyboard.map(input => input.inputToSVGCommitMS), .95).toFixed(3))
    phase.keyboardNextPaintP95MS = Number(percentile(phase.keyboard.map(input => input.inputToNextPaintMS), .95).toFixed(3))
    if (backgroundLoad && phase.keyboardP95MS > 50) throw new Error(`Background keyboard p95 exceeds the 50ms budget: ${phase.keyboardP95MS}`)
    phase.maximumFramesToCommit = Math.max(phase.firstVisit.framesToCommit, phase.mouseSwitch.framesToCommit, phase.rapid.framesToCommit,
      phase.timeframeSwitch?.framesToCommit ?? 0, ...phase.keyboard.map(input => input.framesToCommit))
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), mode: 'electron-native-instrument-navigation-input-to-svg-and-next-paint', candidates: fixture.instIds.length, periodsPerNativeSeries: fixture.periods, ...report }, null, 2))
} finally {
  if (electron) { await removeNavigationProbe(electron); await electron.close() }
  await rm(userData, { recursive: true, force: true })
}
