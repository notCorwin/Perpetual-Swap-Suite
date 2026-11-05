#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { percentile, summarizeResources } from '../experiments/runtime-comparison/analyze.mjs'
import { assertReadyFrame, awaitReady, delay, expectedClose, hash, installReadyRecorder, launchIdleApp, phaseWindow,
  presentationState, probe, removeReadyRecorder, root, seedAndPrepare, selectChart, setActive, waitLoad } from './app-idle-helpers.mjs'

const phaseOrder = [['active', 'idle'], ['idle', 'active'], ['active', 'idle']]
async function fingerprint() {
  const files = {}
  async function visit(path) {
    for (const entry of await readdir(resolve(root, path), { withFileTypes: true })) {
      const file = `${path}/${entry.name}`
      if (entry.isDirectory()) await visit(file)
      else if (/\.(?:js|cjs|ts|tsx|css|html)$/.test(file) && !/\.test\./.test(file)) files[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')
    }
  }
  for (const path of ['electron', 'src', 'dist/assets']) await visit(path)
  for (const path of ['scripts/app-idle-benchmark.mjs', 'scripts/app-idle-helpers.mjs', 'package.json']) files[path] = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')
  return { sha256: hash(Object.fromEntries(Object.entries(files).sort())), files }
}

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, ticks: { type: 'string' }, report: { type: 'string' } } })
  if (values.help) {
    console.log('Usage: node scripts/test-sandbox.mjs command --desktop -- node scripts/app-idle-benchmark.mjs [--ticks 40] [--report .build/app-idle/summary.json]')
    return
  }
  const ticksPerPhase = Number(values.ticks ?? 40), cadenceMS = 500
  if (!Number.isSafeInteger(ticksPerPhase) || ticksPerPhase < 10 || ticksPerPhase > 120) throw new Error('--ticks must be an integer from 10 to 120 per phase.')
  const reportPath = resolve(root, values.report ?? '.build/app-idle/summary.json')
  const rawPath = resolve(dirname(reportPath), `${reportPath.split('/').at(-1).replace(/\.json$/i, '')}.raw.json`)
  if (reportPath === rawPath) throw new Error('Summary and raw output paths must differ.')
  const report = { schemaVersion: 1, outcome: 'running', startedAt: new Date().toISOString(),
    scope: 'SIMULATED APP activation; hidden nonfocusable offscreen Electron. DOM/RAF only: physical screen presentation and native focus latency are not measured.',
    workload: { contracts: 287, periods: 384, timeframes: ['5m', '15m', '1H'], ticksPerPhase, cadenceMS,
      source: 'Synthetic fixed-rate native intake; external WebSocket/network is not measured.', order: phaseOrder },
    measurement: { observer: 'One constant 1 Hz process-tree/frontmost sampler; no V8 or CDP profiles or renderer mutation observer.',
      resources: 'All Electron descendants and the main process including backend worker threads. CPU percent is one core; CPU energy is CPU-only, not total app/device/GPU/display energy.',
      coverage: 'Sampling can miss short-lived processes and transient focus changes. Source and sampler timestamps share the system epoch with small cross-process clock uncertainty.',
      latency: 'Date.now in main activation handler to its ready event after DOM commit and subsequent RAF; hidden renderer scheduling is not native display latency.' },
    phases: [], reactivation: [] }
  report.revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  report.source = await fingerprint()
  const raw = { schemaVersion: 1, phases: [], reactivation: [] }
  let app, fixture, started = false, stopped = false, failure
  try {
    app = await launchIdleApp({ operationRecording: false })
    const { electron, page, sampler } = app
    report.native = app.native
    const prepared = await seedAndPrepare(electron, page, { count: 287, periods: 384 })
    fixture = prepared.fixture; report.fixture = { ...fixture, instIds: undefined, diagnostics: undefined }
    report.fixtureHash = hash(fixture); report.readiness = prepared.readiness
    raw.fixture = fixture
    const instId = fixture.instIds[0], timeframe = '15m'
    await selectChart(page, instId, timeframe)
    await installReadyRecorder(page)
    let first = true
    for (let round = 0; round < phaseOrder.length; round++) for (const mode of phaseOrder[round]) {
      const state = await presentationState(electron)
      if (state.active !== (mode === 'active')) {
        const update = await setActive(electron, mode === 'active')
        if (mode === 'active') {
          const ready = await awaitReady(page, update)
          raw.reactivation.push({ context: `round-${round + 1}`, update, ready })
        } else await page.waitForFunction(() => document.documentElement.hasAttribute('data-presentation-idle'), null, { timeout: 20_000 })
      }
      assert.equal((await presentationState(electron)).active, mode === 'active')
      // Discard transition settling and keep the poll schedule identical in every phase.
      await delay(1000)
      const start = Date.now()
      if (first) {
        // Exactly one prepared data set and workload. Extra scheduled ticks cover
        // phase boundaries and are excluded from paired measurement windows.
        await probe(electron, { action: 'scaleLoadStart', ticks: 6 * (ticksPerPhase + 6) + 120, cadenceMS, focusInstId: instId, timeframe })
        started = true; first = false
      }
      const baseline = (await probe(electron, { action: 'scaleLoadRead' })).emitted
      const load = await waitLoad(electron, value => value.emitted >= baseline + ticksPerPhase + 6 && value.pending === 0,
        (ticksPerPhase + 20) * cadenceMS + 30_000)
      const end = Date.now()
      raw.phases.push({ round: round + 1, mode, start, end, baselineEmitted: baseline, endingEmitted: load.emitted })
    }
    // Repeated restoration under the same live intake, outside all resource
    // windows. Keep these separate from quiescent-source latency samples.
    for (let index = 0; index < 12; index++) {
      await setActive(electron, false)
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-presentation-idle'))
      await delay(250)
      const update = await setActive(electron, true)
      const ready = await awaitReady(page, update)
      raw.reactivation.push({ context: 'live-repeated', update, ready })
    }
    // Stop on a drained source, then retain the complete native-series oracle.
    await waitLoad(electron, value => value.pending === 0)
    const final = await probe(electron, { action: 'scaleStop' }); stopped = true
    raw.final = final; raw.sourceTicks = final.load?.ticks ?? []
    assert.deepEqual(final.liveMismatches, [], 'All native instrument/timeframe live values must reach the latest accepted source revision.')
    assert.equal(final.nativeUpdates, final.ticks * fixture.count * fixture.timeframes.length)
    assert.equal(final.actualRows, fixture.rowsSeeded)
    assert.equal(final.minimumRowsPerSeries, fixture.periods)
    assert.ok(final.ticks > 0 && final.load.failed === 0)
    const expected = expectedClose(fixture, instId, timeframe, final.ticks)
    for (const item of raw.reactivation) {
      const sequence = Math.round((item.ready.liveBar.close - expectedClose(fixture, instId, timeframe, 1)) / .001) + 1
      assert.ok(sequence >= 1 && sequence <= final.ticks)
      assertReadyFrame(item.ready, { instId, timeframe, expected: expectedClose(fixture, instId, timeframe, sequence) })
      const before = raw.sourceTicks.filter(tick => tick.completedAt <= item.update.startedAt).at(-1)?.sequence ?? 0
      assert.ok(sequence >= before, 'Reactivation exposed a source revision older than activation.')
      report.reactivation.push({ epoch: item.update.epoch, latencyMS: item.ready.latencyMS, sourceSequence: sequence, context: 'live-source' })
    }
    // A ready marker during intake must already contain at least the last
    // completed revision at activation, and cannot claim a future revision.
    for (const { context, update, ready } of raw.reactivation) {
      const baseline = expectedClose(fixture, instId, timeframe, 1) - .001
      const sequence = Math.round((ready.liveBar?.close - baseline) * 1000)
      const completed = raw.sourceTicks.filter(tick => tick.completedAt != null && tick.completedAt <= update.startedAt - 2)
      const admitted = raw.sourceTicks.filter(tick => tick.receivedAt != null && tick.receivedAt <= ready.at + 2)
      assert.ok(Number.isSafeInteger(sequence) && sequence >= 1 && admitted.length,
        `${context}: the ready event lacks an admitted live source revision.`)
      assert.ok(sequence >= (completed.at(-1)?.sequence ?? 1) && sequence <= admitted.at(-1).sequence,
        `${context}: ready revision ${sequence} is stale or from the future.`)
      assertReadyFrame(ready, { instId, timeframe, expected: expectedClose(fixture, instId, timeframe, sequence) })
    }
    // Each ready event is independently validated against the final, quiescent
    // source. Do not measure this observer during resource sampling windows.
    for (let index = 0; index < 20; index++) {
      if ((await presentationState(electron)).active) {
        await setActive(electron, false)
        await page.waitForFunction(() => document.documentElement.hasAttribute('data-presentation-idle'), null, { timeout: 20_000 })
      }
      const update = await setActive(electron, true)
      const ready = await awaitReady(page, update)
      assertReadyFrame(ready, { instId, timeframe, expected, marketExpected: expected, marketCount: fixture.count })
      raw.reactivation.push({ context: 'quiescent-source', update, ready })
      report.reactivation.push({ epoch: update.epoch, latencyMS: ready.latencyMS, sourceSequence: final.ticks, context: 'quiescent-source' })
    }
    await removeReadyRecorder(page)
    for (const phase of raw.phases) {
      const window = phaseWindow(sampler.samples, raw.sourceTicks, { ...phase, tickCount: ticksPerPhase,
        expectedUpdates: fixture.count * fixture.timeframes.length })
      const source = window.ticks
      assert.ok(source.every((tick, index) => Number.isFinite(tick.plannedAt) && tick.scheduleLatenessMS >= 0
        && tick.scheduleLatenessMS < cadenceMS && (!index || tick.plannedAt - source[index - 1].plannedAt === cadenceMS)),
      'The native source missed its declared fixed-rate cadence; the paired resource comparison is invalid.')
      const summary = summarizeResources({ samples: window.samples, skippedSamples: null }).combined
      // Missing CPU coverage is a failed comparison; unsupported CPU energy is
      // retained as unavailable with its separate coverage rather than invented.
      assert.equal(summary.coverage.cpu.complete, true, `Incomplete CPU coverage in round ${phase.round} ${phase.mode}.`)
      assert.equal(summary.coverage.footprint.complete, true, `Incomplete footprint coverage in round ${phase.round} ${phase.mode}.`)
      const item = { round: phase.round, mode: phase.mode, source: { ticks: source.length, firstSequence: source[0].sequence,
        lastSequence: source.at(-1).sequence, cadenceMS, nativeUpdatesPerTick: fixture.count * 3,
        maxScheduleLatenessMS: Math.max(...source.map(tick => tick.scheduleLatenessMS)), rawHash: hash(source) },
        samples: { count: window.samples.length, from: window.from, through: window.through, rawHash: hash(window.samples) }, resources: summary }
      report.phases.push(item)
      Object.assign(phase, { selectedFrom: window.from, selectedThrough: window.through, sourceHash: item.source.rawHash, samplesHash: item.samples.rawHash })
    }
    const latency = items => ({ count: items.length, p50: percentile(items.map(item => item.latencyMS), .5), p95: percentile(items.map(item => item.latencyMS), .95) })
    report.reactivationLatencyMS = {
      liveSource: latency(report.reactivation.filter(item => item.context === 'live-source')),
      quiescentSource: latency(report.reactivation.filter(item => item.context === 'quiescent-source')),
      pooledDiagnostic: latency(report.reactivation),
    }
    report.pairs = phaseOrder.map((_, index) => {
      const active = report.phases.find(phase => phase.round === index + 1 && phase.mode === 'active')
      const idle = report.phases.find(phase => phase.round === index + 1 && phase.mode === 'idle')
      const metric = name => {
        const a = active.resources[name], b = idle.resources[name]
        return Number.isFinite(a) && a > 0 && Number.isFinite(b) ? (b - a) / a * 100 : null
      }
      return { round: index + 1, idleMinusActivePercent: Object.fromEntries(['cpuPercentOfOneCore', 'cpuMeanWatts', 'meanFootprintMiB'].map(name => [name, metric(name)])) }
    })
    assert.equal((await fingerprint()).sha256, report.source.sha256, 'Application or harness source changed during measurement.')
    report.outcome = 'passed'
  } catch (error) {
    failure = error; report.outcome = 'failed'; report.error = error.stack ?? String(error)
  } finally {
    if (app && started && !stopped) {
      try { raw.final = await probe(app.electron, { action: 'scaleStop' }) } catch (error) { report.cleanupError = error.stack ?? String(error); failure ??= error }
    }
    if (app) {
      try { raw.sampler = await app.close() } catch (error) { report.samplerOrCloseError = error.stack ?? String(error); report.outcome = 'failed'; failure ??= error }
    }
    report.finishedAt = new Date().toISOString()
    if (!raw.sampler && app) raw.sampler = { samples: app.sampler.samples, incomplete: true }
    const rawText = `${JSON.stringify(raw)}\n`
    report.raw = { path: rawPath, sha256: createHash('sha256').update(rawText).digest('hex'), samples: raw.sampler?.samples?.length ?? null, skippedSamples: raw.sampler?.skippedSamples ?? null }
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(rawPath, rawText)
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`SIMULATED APP activation benchmark: ${report.outcome}. Summary: ${reportPath}; raw: ${rawPath}`)
    if (report.reactivationLatencyMS) {
      for (const name of ['liveSource', 'quiescentSource']) {
        const value = report.reactivationLatencyMS[name]
        console.log(`${name} DOM/RAF reactivation p50/p95: ${value.p50}/${value.p95} ms (n=${value.count}); native screen/focus latency unmeasured.`)
      }
    }
  }
  if (failure) throw failure
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1 })
