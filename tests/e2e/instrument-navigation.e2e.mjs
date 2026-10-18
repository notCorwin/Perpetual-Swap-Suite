import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { exerciseInstrumentNavigation, installNavigationProbe, persistNavigationCatalog, removeNavigationProbe, selectionRequests, startupNavigationReport } from '../../scripts/instrument-navigation-acceptance.mjs'

const root = new URL('../..', import.meta.url).pathname
const userData = await mkdtemp(join(tmpdir(), 'perp-instrument-navigation-e2e-'))
let electron, page, fixture
before(async () => {
  electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
  page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await installNavigationProbe(electron, page)
  fixture = await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedInstrumentNavigationBenchmark' } }))
})
after(async () => {
  if (electron) { await removeNavigationProbe(electron); await electron.close() }
  await rm(userData, { recursive: true, force: true })
})

test('all sixteen native contracts switch by the next frame while old history remains blocked', { timeout: 120_000 }, async context => {
  const report = await exerciseInstrumentNavigation(electron, page, fixture)
  assert.equal(report.phases.length, 3)
  assert.equal(report.phases.every(phase => phase.distinctContracts === 16 && phase.prewarm.readyCount === 16), true)
  assert.equal(report.heldHistory.lateWrongInstrumentPaints, 0)
  assert.deepEqual(report.violations, [])
  const inputs = report.phases.flatMap(phase => [phase.firstVisit, phase.mouseSwitch, phase.rapid, ...phase.keyboard,
    ...(phase.timeframeSwitch ? [phase.timeframeSwitch] : [])])
  const percentile = (field, ratio) => inputs.map(input => input[field]).toSorted((left, right) => left - right)[Math.floor((inputs.length - 1) * ratio)]
  context.diagnostic(`Navigation latency: ${JSON.stringify({ initialPreparation: report.initialPreparation, inputs: inputs.length, svgP50MS: percentile('inputToSVGCommitMS', .5),
    svgP95MS: percentile('inputToSVGCommitMS', .95), nextPaintP95MS: percentile('inputToNextPaintMS', .95),
    maximumFramesToCommit: Math.max(...inputs.map(input => input.framesToCommit)), selectionIPC: inputs.reduce((sum, input) => sum + input.selectionIPC, 0) })}`)
})

test('a real process restart switches unseen cached contracts and periods at the first visible list without a readiness wait', { timeout: 120_000 }, async context => {
  assert.equal(await persistNavigationCatalog(electron, page), fixture.instIds.length)
  await removeNavigationProbe(electron)
  await electron.close()
  const launchedAt = Date.now()
  electron = await _electron.launch({ args: ['-r', './scripts/instrument-navigation-bootstrap.cjs', '.', '--headless', '--disable-gpu'], cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
  page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const startup = await startupNavigationReport(page, launchedAt, fixture)
  const requests = await electron.evaluate(() => globalThis.__navigationStartupRequests.requests)
  const selectedRequests = selectionRequests({ requests }).filter(request => request.instId === startup.instId
    && request.at >= startup.inputEpoch - 1 && request.at <= startup.commitEpoch + 1)
  context.diagnostic(`Cold process restart: ${JSON.stringify({ ...startup, selectionIPC: selectedRequests.length })}`)
  assert.ok(selectedRequests.length <= 2, 'Cold selection restores only its bounded local price projection.')
  assert.deepEqual(startup.violations, [], 'Every startup SVG must retain the exact persisted prices and canonical indicators.')
  assert.ok(startup.framesToCommit <= 10, `The first visible-list selection needed ${startup.framesToCommit} frames: ${JSON.stringify(startup)}`)
  assert.ok(startup.inputToSVGCommitMS <= 150, `The first visible-list selection blocked input: ${JSON.stringify(startup)}`)
  await installNavigationProbe(electron, page)
  const report = await exerciseInstrumentNavigation(electron, page, fixture, { awaitInitialPreparation: false, holdHistory: false })
  assert.equal(report.phases.length, 3)
  assert.deepEqual(report.violations, [])
  context.diagnostic(`Restart navigation: ${JSON.stringify(report.phases.map(phase => ({ timeframe: phase.timeframe,
    firstVisit: phase.firstVisit, timeframeSwitch: phase.timeframeSwitch, rapid: phase.rapid,
    maximumKeyboardMS: Math.max(...phase.keyboard.map(input => input.inputToSVGCommitMS)) })))}`)
})
