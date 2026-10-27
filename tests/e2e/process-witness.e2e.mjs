import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { startProcessWitness } from '../support/process-witness.mjs'

test('process witness aligns an actual main-thread wait with CPU and recorder evidence', { timeout: 30_000 }, async context => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-process-witness-'))
  let electron, stop
  try {
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ monitoringPaused: true, backgroundMonitoringEnabled: false }))
    electron = await _electron.launch({ args: ['.'], cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
    await (await electron.firstWindow()).waitForLoadState('domcontentloaded')
    stop = await startProcessWitness(electron, 'protected-main-wait')
    await electron.evaluate(() => new Promise(resolve => setTimeout(resolve, 60)))
    const wait = await electron.evaluate(() => {
      const startedAt = performance.timeOrigin + performance.now()
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80)
      return { startedAt, endedAt: performance.timeOrigin + performance.now() }
    })
    await electron.evaluate(() => new Promise(resolve => setTimeout(resolve, 40)))
    const report = await stop(), loop = report.mainLoop
    const intervals = loop.samples.slice(1).map((sample, index) => {
      const previous = loop.samples[index]
      return { startedAt: loop.timeOriginMS + previous.callbackAtMS, endedAt: loop.timeOriginMS + sample.callbackAtMS,
        cpuMS: (sample.threadCPUUS.user + sample.threadCPUUS.system - previous.threadCPUUS.user - previous.threadCPUUS.system) / 1_000 }
    })
    const observed = intervals.find(sample => sample.startedAt <= wait.startedAt && sample.endedAt >= wait.endedAt)
    assert.ok(observed, 'A timer interval must bracket the actual native wait using the same epoch clock.')
    assert.ok(observed.cpuMS < (wait.endedAt - wait.startedAt) / 2, 'Waiting must remain distinguishable from busy main-thread computation.')
    assert.equal(loop.omittedSamples, 0)
    assert.ok(report.writers.some(writer => writer.role === 'electron-main'))
    assert.ok(report.writers.every(writer => writer.selfTiming && typeof writer.selfTiming === 'object'))
    assert.equal(await electron.evaluate(() => globalThis.__mainLoopWitness), undefined)
    assert.equal(await stop(), report, 'Repeated collection must return the retained report without restarting or sampling again.')
    context.diagnostic(JSON.stringify({ wait, observed, samples: loop.samples.length,
      captureCostMS: loop.captureCostMS, maxCaptureCostMS: loop.maxCaptureCostMS }))
  } finally {
    try { await stop?.() }
    finally { await electron?.close(); await rm(userData, { recursive: true, force: true }) }
  }
})
