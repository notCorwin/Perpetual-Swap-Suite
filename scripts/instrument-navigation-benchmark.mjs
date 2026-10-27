import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { _electron } from 'playwright'
import { exerciseInstrumentNavigation, installNavigationProbe, persistNavigationCatalog, removeNavigationProbe, selectionRequests, startupNavigationReport } from './instrument-navigation-acceptance.mjs'
import { summarizeLatencySamples } from './chart-acceptance-metrics.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({
  options: { 'app-root': { type: 'string' }, output: { type: 'string' } },
  allowPositionals: false,
})

if (process.env.PERPETUAL_SWAP_SANDBOX !== '1' || process.env.PERPETUAL_SWAP_TEST_UI !== 'background'
  || process.env.PERPETUAL_SWAP_ALLOW_NETWORK !== '0') {
  throw new Error('Run this measurement through scripts/test-sandbox.mjs command --desktop with network disabled.')
}

async function appEntryFor(appRoot) {
  const selected = resolve(appRoot)
  const info = await stat(selected).catch(() => null)
  if (!info) throw new Error(`App root does not exist: ${selected}`)
  if (info.isFile() && extname(selected) === '.asar') return { selected, entry: selected, cwd: dirname(selected) }
  if (!info.isDirectory()) throw new Error(`App root must be a project directory, .asar file, or .app bundle: ${selected}`)
  if (selected.endsWith('.app')) {
    const resources = join(selected, 'Contents', 'Resources')
    const archive = join(resources, 'app.asar')
    const unpacked = join(resources, 'app')
    if (await stat(archive).then(value => value.isFile()).catch(() => false)) return { selected, entry: archive, cwd: resources }
    if (await stat(unpacked).then(value => value.isDirectory()).catch(() => false)) return { selected, entry: unpacked, cwd: resources }
    throw new Error(`The app bundle has no Electron app.asar or Resources/app directory: ${selected}`)
  }
  if (!await stat(join(selected, 'package.json')).then(value => value.isFile()).catch(() => false)) {
    throw new Error(`App root must contain package.json: ${selected}`)
  }
  return { selected, entry: selected, cwd: selected }
}

async function targetRevision(app, checkout) {
  if (!app.selected.endsWith('.app') && !app.selected.endsWith('.asar')) {
    return { path: app.selected, provenance: 'working-tree checkout', revision: checkout.revision, dirty: checkout.dirty }
  }
  const revisionPath = app.selected.endsWith('.app')
    ? join(app.selected, 'Contents', 'Resources', 'build-revision.json')
    : app.selected.endsWith('.asar') ? join(dirname(app.selected), 'build-revision.json') : join(app.selected, '.build', 'build-revision.json')
  try { return { path: revisionPath, ...JSON.parse(await readFile(revisionPath, 'utf8')) } }
  catch { return { path: revisionPath, revision: null, dirty: null } }
}

function checkoutMetadata() {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
  return { revision, dirty }
}

async function protectedRuntime(electron) {
  const guardPath = process.env.PERPETUAL_SWAP_TEST_GUARD
  if (!guardPath) throw new Error('The protected Electron runtime guard is missing.')
  const guard = JSON.parse(await readFile(guardPath, 'utf8'))
  const runtime = await electron.evaluate(({ app }) => ({ executable: process.execPath, electronVersion: process.versions.electron,
    packaged: app.isPackaged, appPath: app.getAppPath() }))
  if (runtime.executable !== guard.executable) throw new Error(`Electron did not launch from the protected test runtime: ${runtime.executable}`)
  return { presentation: guard.presentation, sourceFingerprint: guard.sourceFingerprint, executable: runtime.executable,
    electronVersion: runtime.electronVersion, packaged: runtime.packaged, appPath: runtime.appPath }
}

async function assertHiddenOffscreen(electron) {
  const state = await electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(), offscreen: window.webContents.isOffscreen() }
  })
  if (state.visible || state.focused || state.minimized || !state.offscreen) {
    throw new Error(`Instrument navigation must stay in a hidden, unfocused offscreen window: ${JSON.stringify(state)}`)
  }
  return state
}

const userData = await mkdtemp(join(tmpdir(), 'perp-instrument-navigation-benchmark-'))
const app = await appEntryFor(values['app-root'] ?? root)
const reportPath = resolve(values.output ?? join(root, '.build/traffic-optimization/instrument-navigation.json'))
const checkout = checkoutMetadata()
const target = await targetRevision(app, checkout)
let electron, report
try {
  electron = await _electron.launch({ args: [app.entry], cwd: app.cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0', PERPETUAL_SWAP_USER_DATA: userData } })
  let page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const presentation = await assertHiddenOffscreen(electron)
  const runtime = await protectedRuntime(electron)
  const unpreparedInstId = 'BTC-USDT-SWAP'
  await installNavigationProbe(electron, { omitUniverseInstId: unpreparedInstId })
  const fixture = await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedInstrumentNavigationBenchmark' } }))
  const backgroundLoad = process.env.PERPETUAL_SWAP_BENCHMARK_BACKGROUND === '1'
  if (backgroundLoad) await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'backgroundStart' }))
  report = await exerciseInstrumentNavigation(electron, page, fixture, { unpreparedInstId })
  if (backgroundLoad) report.background = await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'backgroundStatus' }))
  await persistNavigationCatalog(electron, page)
  await removeNavigationProbe(electron)
  await electron.close()
  const launchedAt = Date.now()
  const bootstrap = fileURLToPath(new URL('./instrument-navigation-bootstrap.cjs', import.meta.url))
  electron = await _electron.launch({ args: ['-r', bootstrap, app.entry], cwd: app.cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0', PERPETUAL_SWAP_USER_DATA: userData } })
  page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await assertHiddenOffscreen(electron)
  const restartRuntime = await protectedRuntime(electron)
  if (restartRuntime.executable !== runtime.executable || restartRuntime.sourceFingerprint !== runtime.sourceFingerprint) {
    throw new Error('The restarted navigation process did not use the same protected Electron runtime.')
  }
  const startup = await startupNavigationReport(page, launchedAt, fixture)
  const requests = await electron.evaluate(() => globalThis.__navigationStartupRequests.requests)
  startup.selectionIPC = selectionRequests({ requests }).filter(request => request.instId === startup.instId
    && request.at >= startup.inputEpoch - 1 && request.at <= startup.commitEpoch + 1).length
  if (startup.framesToCommit > 1 || !presentation.offscreen && startup.inputToSVGCommitMS > 50 || startup.selectionIPC > 2 || startup.violations.length
    || !startup.rendererFramesBeforeInput.includes(`${startup.timeframe}:${startup.instId}`)) throw new Error(`Warm startup selection exceeded the local-read budget: ${JSON.stringify(startup)}`)
  await installNavigationProbe(electron)
  report.restart = { startup, ...await exerciseInstrumentNavigation(electron, page, fixture, { holdHistory: false }) }
  for (const phase of [...report.phases, ...(report.restart?.phases ?? [])]) {
    const keyboard = summarizeLatencySamples(phase.keyboard.map(input => input.inputToSVGCommitMS))
    const nextRafSample = summarizeLatencySamples(phase.keyboard.map(input => input.inputToNextRafSampleMS))
    phase.keyboardSampleCount = keyboard.sampleCount
    phase.keyboardP50MS = keyboard.p50MS === null ? null : Number(keyboard.p50MS.toFixed(3))
    phase.keyboardP95MS = keyboard.p95MS === null ? null : Number(keyboard.p95MS.toFixed(3))
    phase.keyboardP95SampleMinimum = keyboard.p95SampleMinimum
    phase.keyboardMaxMS = keyboard.maxMS === null ? null : Number(keyboard.maxMS.toFixed(3))
    phase.keyboardNextRafSampleP95MS = nextRafSample.p95MS === null ? null : Number(nextRafSample.p95MS.toFixed(3))
    phase.keyboardNextRafSampleP95SampleMinimum = nextRafSample.p95SampleMinimum
    const foregroundGateMS = keyboard.p95MS ?? keyboard.maxMS
    if (!presentation.offscreen && foregroundGateMS !== null && foregroundGateMS > 50) {
      const statistic = keyboard.p95MS === null ? 'maximum' : 'p95'
      throw new Error(`Foreground keyboard ${statistic} exceeds the 50ms budget: ${foregroundGateMS}`)
    }
    phase.maximumFramesToCommit = Math.max(phase.firstVisit.framesToCommit, phase.mouseSwitch.framesToCommit, phase.rapid.framesToCommit,
      phase.timeframeSwitch?.framesToCommit ?? 0, ...phase.keyboard.map(input => input.framesToCommit))
  }
  report = { generatedAt: new Date().toISOString(), mode: 'electron-instrument-navigation-input-to-svg-and-next-renderer-raf-sample',
    appRoot: app.selected, appEntry: app.entry, fixture: { candidates: fixture.instIds.length, timeframes: fixture.timeframes,
      periodsPerNativeSeries: fixture.periods }, metadata: { checkout, targetBuild: target,
      runtime: { ...runtime, native: presentation, network: 'sandbox network disabled; seeded offline fixture' } }, ...report }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ report: reportPath, ...report }, null, 2))
} finally {
  if (electron) { await removeNavigationProbe(electron); await electron.close() }
  await rm(userData, { recursive: true, force: true })
}
