import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { exerciseInstrumentNavigation, installNavigationProbe, removeNavigationProbe } from '../../scripts/instrument-navigation-acceptance.mjs'

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

test('all sixteen native contracts switch by the next frame while old history remains blocked', { timeout: 120_000 }, async () => {
  const report = await exerciseInstrumentNavigation(electron, page, fixture)
  assert.equal(report.phases.length, 3)
  assert.equal(report.phases.every(phase => phase.distinctContracts === 16 && phase.prewarm.readyCount === 16), true)
  assert.equal(report.heldHistory.lateWrongInstrumentPaints, 0)
  assert.deepEqual(report.violations, [])
})
