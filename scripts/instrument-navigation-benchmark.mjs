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
  const report = await exerciseInstrumentNavigation(electron, page, fixture)
  const percentile = (values, ratio) => {
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
  }
  for (const phase of report.phases) {
    phase.keyboardP50MS = Number(percentile(phase.keyboard.map(input => input.inputToSVGCommitMS), .5).toFixed(3))
    phase.keyboardP95MS = Number(percentile(phase.keyboard.map(input => input.inputToSVGCommitMS), .95).toFixed(3))
    phase.maximumFramesToCommit = Math.max(phase.firstVisit.framesToCommit, phase.mouseSwitch.framesToCommit, phase.rapid.framesToCommit, ...phase.keyboard.map(input => input.framesToCommit))
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), mode: 'electron-native-instrument-navigation-input-to-svg-commit', candidates: fixture.instIds.length, periodsPerNativeSeries: fixture.periods, ...report }, null, 2))
} finally {
  if (electron) { await removeNavigationProbe(electron); await electron.close() }
  await rm(userData, { recursive: true, force: true })
}
