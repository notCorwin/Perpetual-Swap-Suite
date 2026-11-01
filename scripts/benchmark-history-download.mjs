#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { DEFAULT_PREFERENCES } from '../electron/services/preferences.js'

// Run each variant and scenario in a separate test-sandbox invocation. The
// baseline materializes the checked-in changed sources in a temporary module
// directory; unchanged dependencies and fixture are shared.
const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: {
  variant: { type: 'string' }, scenario: { type: 'string' }, output: { type: 'string' },
  'baseline-ref': { type: 'string', default: 'HEAD' }, 'delay-ms': { type: 'string' }, contracts: { type: 'string' },
} })
const variant = values.variant, scenario = values.scenario
if (!['baseline', 'candidate'].includes(variant)
  || !['production', 'cold', 'gap', 'existing', 'failure', 'priority', 'fragmented'].includes(scenario)) {
  throw new Error('Usage: benchmark-history-download.mjs --variant baseline|candidate --scenario production|cold|gap|existing|failure|priority|fragmented [--contracts N] [--delay-ms N] [--baseline-ref REF] [--output PATH]')
}
const steps = { '5m': 300_000, '15m': 900_000, '1H': 3_600_000 }
const contractCount = Number(values.contracts ?? (scenario === 'fragmented' ? 8 : 2))
if (!Number.isSafeInteger(contractCount) || contractCount < 2 || contractCount > 32 || scenario !== 'fragmented' && values.contracts !== undefined) throw new Error('--contracts is only valid for fragmented and must be an integer from 2 to 32.')
const ids = Array.from({ length: contractCount }, (_, index) => `BENCH${index}-USDT-SWAP`), foregroundID = 'FOREGROUND-USDT-SWAP'
// A fixed historical boundary makes separate process runs comparable, even if
// they cross a real market-hour rollover. All fixture facts are synthetic.
const now = Date.UTC(2026, 9, 1, 12, 35)
const listing = Math.floor(now / steps['1H']) * steps['1H'] - (scenario === 'production' ? 2401 : scenario === 'fragmented' ? 600 : 5) * steps['1H']
const omitted = listing + 2 * steps['1H'] + steps['5m']
const interval = Number(values['delay-ms'] ?? (scenario === 'priority' ? 10 : 0))
if (!Number.isSafeInteger(interval) || interval < 0 || interval > 2000) throw new Error('--delay-ms must be an integer between 0 and 2000.')
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const baselineRevision = execFileSync('git', ['rev-parse', `${values['baseline-ref']}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
const worktreeDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
const sharedServices = ['market-store-migration.js', 'market-records.js', 'data-audit.js',
  'statistics-state.js', 'statistics-coverage.js', 'candle-aggregation.js', 'worker-operations.js', 'recorded-database.js', 'operations.js']
const changedServices = ['market-service.js', 'history-download.js', 'history-sync.js', 'market-history.js', 'market-store.js', 'market-store-worker.js']
const serviceChanges = execFileSync('git', ['diff', '--name-only', baselineRevision, '--', 'electron/services'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter(file => !changedServices.includes(file.slice('electron/services/'.length)) && !file.endsWith('.d.ts'))
if (serviceChanges.length) throw new Error(`Shared service code differs from baseline: ${serviceChanges.join(', ')}.`)
const untrackedServices = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'electron/services'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(file => file.endsWith('.js'))
if (untrackedServices.length) throw new Error(`Untracked service code needs baseline isolation: ${untrackedServices.join(', ')}.`)
const trackedServices = execFileSync('git', ['ls-files', '--', 'electron/services/*.js'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
const inputFiles = ['scripts/benchmark-history-download.mjs', ...trackedServices]
const fingerprint = async () => {
  const hash = createHash('sha256')
  for (const file of inputFiles) { hash.update(file); hash.update(await readFile(join(root, file))) }
  return hash.digest('hex')
}
const inputHash = await fingerprint()
for (const file of sharedServices) {
  const path = `electron/services/${file}`
  const baseline = execFileSync('git', ['show', `${baselineRevision}:${path}`], { cwd: root })
  if (!baseline.equals(await readFile(join(root, path)))) throw new Error(`Shared baseline source changed: ${path}. Extend the baseline isolation before comparing.`)
}
const preferences = structuredClone(DEFAULT_PREFERENCES)
for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
const sha = value => createHash('sha256').update(value).digest('hex')
const baselineSources = {}, sourceSHA256 = {}
for (const file of changedServices) {
  const baseline = execFileSync('git', ['show', `${baselineRevision}:electron/services/${file}`], { cwd: root, encoding: 'utf8' })
  const candidate = await readFile(join(root, 'electron/services', file), 'utf8')
  baselineSources[file] = baseline
  sourceSHA256[file] = { baseline: sha(baseline), candidate: sha(candidate) }
}
const rootDir = await mkdtemp(join(tmpdir(), 'perp-history-benchmark-'))
let MarketStore, MarketService, store
try {
  if (variant === 'baseline') {
    // Only source modules needed for the baseline worker are materialized in a
    // temporary directory; all unchanged dependencies resolve to this checkout.
    // No runtime or user-data production switch is introduced.
    const code = join(rootDir, 'baseline-code')
    await mkdir(code)
    const relocate = (source, names) => names.reduce((text, name) => text.replaceAll(`'./${name}'`, JSON.stringify(pathToFileURL(join(root, 'electron/services', name)).href)), source)
    const storeSource = baselineSources['market-store.js']
    if (!storeSource.includes("new URL('./market-store-worker.js', import.meta.url)")) throw new Error('The baseline worker URL no longer resolves through the temporary MarketStore source.')
    await writeFile(join(code, 'package.json'), '{"type":"module"}\n')
    await writeFile(join(code, 'market-store.js'), relocate(storeSource, ['worker-operations.js', 'market-records.js', 'operations.js', 'market-store-migration.js']))
    await writeFile(join(code, 'market-store-worker.js'), relocate(baselineSources['market-store-worker.js'],
      ['worker-operations.js', 'recorded-database.js', 'market-records.js', 'statistics-state.js', 'statistics-coverage.js', 'candle-aggregation.js']))
    await writeFile(join(code, 'history-sync.js'), relocate(baselineSources['history-sync.js'], ['operations.js']))
    await writeFile(join(code, 'history-download.js'), baselineSources['history-download.js'])
    await writeFile(join(code, 'market-history.js'), relocate(baselineSources['market-history.js'], ['data-audit.js', 'market-records.js', 'statistics-state.js']))
    const serviceSource = baselineSources['market-service.js'].replace(/from '\.\/(.+?\.js)'/g, (match, name) =>
      changedServices.includes(name) ? match : `from ${JSON.stringify(pathToFileURL(join(root, 'electron/services', name)).href)}`)
    await writeFile(join(code, 'market-service.js'), serviceSource)
    MarketStore = (await import(pathToFileURL(join(code, 'market-store.js')).href)).MarketStore
    MarketService = (await import(pathToFileURL(join(code, 'market-service.js')).href)).MarketService
  } else {
    MarketStore = (await import('../electron/services/market-store.js')).MarketStore
    MarketService = (await import('../electron/services/market-service.js')).MarketService
  }
  store = await MarketStore.open(rootDir)
} catch (error) { await rm(rootDir, { recursive: true, force: true }); throw error }
const requests = {}, calls = [], database = {}, tasks = {}, elapsed = () => performance.now() - started
let started = performance.now(), active = 0, maximumActive = 0, firstParentMS = null, firstParentCoveredMS = null, foregroundRequestedAt = null
const firstParentByTimeframe = { '15m': null, '1H': null }, firstParentCoveredByTimeframe = { '15m': null, '1H': null }
let releaseFirst, announceFirst, announceExisting, heldInstrument = null, existingParentReadyMS = null, existingParentBeforeRelease = null, existingProgressBeforeRelease = null
const firstActive = new Promise(resolve => { announceFirst = resolve })
const existingParentReady = new Promise(resolve => { announceExisting = resolve })
const gate = new Promise(resolve => { releaseFirst = resolve })
let held = false, blockedFine = 0
const deadline = async (promise, label, milliseconds) => {
  let timer
  const expiry = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms.`)), milliseconds); timer.unref() })
  try { return await Promise.race([promise, expiry]) } finally { clearTimeout(timer) }
}
const candle = (id, timeframe, stamp) => {
  const factor = steps[timeframe] / steps['5m'], base = id === ids[0] ? 100 : id === ids[1] ? 200 : 300
  const at = index => base + (index % 10)
  const first = Math.floor((stamp - listing) / steps['5m']), values = Array.from({ length: factor }, (_, index) => at(first + index))
  return [stamp, values[0], Math.max(...values) + 1, Math.min(...values) - 1, values.at(-1) + 0.5,
    factor, factor * 2, factor * 3, 1].map(String)
}
const fetcher = async (input, init) => {
  const url = new URL(String(input)), timeframe = url.searchParams.get('bar') ?? url.searchParams.get('period'), step = steps[timeframe]
  const instrument = url.searchParams.get('instId'), source = url.pathname.endsWith('/history-candles') ? 'candles'
    : url.pathname.endsWith('/open-interest-history') ? 'oi' : url.pathname.endsWith('/taker-volume-contract') ? 'taker' : ''
  if (!source || !step || !instrument) throw new Error(`Unexpected fixture source ${url.pathname}.`)
  const key = `${source}:${timeframe}`, item = requests[key] ??= { calls: 0, rows: 0, bytes: 0, failures: 0 }
  const call = { source, timeframe, instrument, startedMS: elapsed() }
  item.calls++; calls.push(call); active++; maximumActive = Math.max(maximumActive, active)
  try {
    if ((scenario === 'fragmented' || (scenario === 'priority' || scenario === 'existing') && !held)
      && source === 'candles' && timeframe === '5m' && instrument !== foregroundID) {
      blockedFine++
      if (!held) { held = true; heldInstrument = instrument; announceFirst() }
      await gate
    }
    if (interval) await delay(interval, undefined, { signal: init?.signal })
    if (scenario === 'failure' && source === 'candles' && timeframe === '5m' && instrument === ids[0]) {
      item.failures++; call.status = 503
      return new Response('', { status: 503 })
    }
    const from = source === 'candles' ? Number(url.searchParams.get('after')) - Number(url.searchParams.get('limit')) * step : Number(url.searchParams.get('begin')) + step
    const through = source === 'candles' ? Number(url.searchParams.get('after')) - step : Number(url.searchParams.get('end')) - step
    const data = []
    for (let stamp = through; stamp >= from; stamp -= step) {
      if (stamp < listing || stamp + step > now || scenario === 'gap' && instrument === ids[0] && timeframe === '5m' && source === 'candles' && stamp === omitted) continue
      data.push(source === 'candles' ? candle(instrument, timeframe, stamp)
        : source === 'oi' ? [String(stamp), '50'] : [String(stamp), '1', '2'])
    }
    const payload = JSON.stringify({ code: '0', data }), bytes = Buffer.byteLength(payload)
    item.rows += data.length; item.bytes += bytes; Object.assign(call, { status: 200, rows: data.length, bytes })
    return new Response(payload, { headers: { 'content-type': 'application/json' } })
  } finally { call.endedMS = elapsed(); active-- }
}
const service = new MarketService(store, () => preferences, fetcher, false)
const callCounted = (object, name, after) => {
  const original = object[name].bind(object)
  object[name] = (...args) => {
    database[name] = (database[name] ?? 0) + 1
    if (name === 'statistics') {
      const source = ['oi', 'taker'].includes(args[0]?.source) ? args[0].source : 'unspecified'
      const key = `statistics:${source}`
      database[key] = (database[key] ?? 0) + 1
    }
    const result = original(...args)
    if (after) return Promise.resolve(result).then(value => { after(args, value); return value })
    return result
  }
}
for (const name of ['candles', 'statistics', 'appendCandles', 'appendStatistics', 'aggregateCandles', 'missingCandleRanges']) {
  callCounted(store, name, name === 'appendCandles' ? (args, changed) => {
    if (changed) for (const row of args[0]) if (row.timeframe !== '5m') {
      firstParentMS ??= elapsed(); firstParentByTimeframe[row.timeframe] ??= elapsed()
    }
  } : name === 'aggregateCandles' ? (args, result) => {
    if (result.changed && args[0].timeframe !== '5m') {
      firstParentMS ??= elapsed(); firstParentByTimeframe[args[0].timeframe] ??= elapsed()
    }
  } : undefined)
}

try {
  await service.ready
  service.historyDownload.now = () => now
  service.history.now = () => now
  service.history.sync.now = () => now
  service.historyDownload.chunkSlots = scenario === 'production' || scenario === 'fragmented' ? 2400 : 13
  service.history.sync.maxAttempts = 1
  for (const lane of service.requestLanes.values()) lane.interval = 0
  for (const instId of [...ids, foregroundID]) service.instruments.set(instId, { instId, listTime: String(listing) })
  if (scenario === 'existing' || scenario === 'fragmented') {
    const rows = ids.flatMap(instrument => ['15m', '1H'].flatMap(timeframe => {
      const step = steps[timeframe], result = []
      for (let timestamp = Math.ceil(listing / step) * step; timestamp <= Math.floor(now / step) * step - step; timestamp += step) {
        if (scenario === 'fragmented' && (timestamp - listing) / step % 2 !== 0) continue
        const [_, open, high, low, close, volume, baseVolume, quoteVolume] = candle(instrument, timeframe, timestamp).map(Number)
        result.push({ instrument, timeframe, timestamp, open, high, low, close, volume, baseVolume, quoteVolume, confirmed: true })
      }
      return result
    }))
    for (let index = 0; index < rows.length; index += 2048) await store.appendCandles(rows.slice(index, index + 2048))
  }
  for (const name of Object.keys(database)) delete database[name]
  firstParentMS = null
  firstParentByTimeframe['15m'] = null; firstParentByTimeframe['1H'] = null
  const enqueue = service.history.sync.enqueue.bind(service.history.sync)
  service.history.sync.enqueue = async (input, ...options) => {
    const key = `${input.source}:${input.timeframe}`
    tasks[key] = (tasks[key] ?? 0) + 1
    return enqueue(input, ...options)
  }
  const onProgress = service.history.sync.onProgress
  service.history.sync.onProgress = task => {
    onProgress?.(task)
    if (task.source !== 'candles' || task.timeframe === '5m' || !(task.coveredRecords > 0)) return
    firstParentCoveredMS ??= elapsed()
    firstParentCoveredByTimeframe[task.timeframe] ??= elapsed()
    if (scenario === 'existing' && task.instrument === heldInstrument && task.localRecords > 0 && existingParentReadyMS === null) {
      existingParentReadyMS = elapsed(); announceExisting()
    }
  }
  if (scenario === 'priority') service.history.sync.maxConcurrentPerSource.set('candles', 1)
  if (scenario === 'fragmented') global.gc?.()
  const memoryBefore = scenario === 'fragmented' ? process.memoryUsage() : null
  started = performance.now()
  const cpuStart = process.cpuUsage(), threadStart = process.threadCpuUsage()
  const reportStart = service.historyDownload.start(ids.map(instId => ({ instId, listTime: listing })))
  assert.equal(reportStart.phase, 'running')
  const downloadTask = service.historyDownload.job.promise
  let foreground, fragmentation = null
  if (scenario === 'priority' || scenario === 'existing' || scenario === 'fragmented') {
    await deadline(firstActive, 'Initial background request', 15_000)
    if (scenario === 'fragmented') {
      // Allow the bounded archive scheduler to settle while every 5m response
      // stays blocked. The sample includes legitimate background statistics
      // work and is a pressure diagnostic, not an isolated allocation count.
      const waitStarted = performance.now()
      while (blockedFine < Math.min(ids.length, service.history.sync.maxConcurrentPerSource.get('candles') ?? 4)
        && performance.now() - waitStarted < 2000) await delay(10)
      await delay(250)
      global.gc?.()
      const memoryHeld = process.memoryUsage(), coverage = [...(service.history.sync.heldCoverage?.values() ?? [])]
      const uniqueRemaining = [...new Set(coverage.map(entry => entry.remaining))]
      const ranges = coverage.map(entry => entry.remaining.length)
      fragmentation = { blockedFineRequests: blockedFine, sampleMS: elapsed(), gcExposed: typeof global.gc === 'function',
        tasksByStatus: Object.fromEntries(Object.entries(Object.groupBy(service.history.sync.listTasks(), task => task.status)).map(([status, items]) => [status, items.length])),
        heldTasks: coverage.length, heldRangeReferences: ranges.reduce((sum, value) => sum + value, 0),
        uniqueRangeArrays: uniqueRemaining.length, uniqueRanges: uniqueRemaining.reduce((sum, value) => sum + value.length, 0),
        maxRangesPerTask: Math.max(0, ...ranges), memoryBefore, memoryHeld,
        heapDelta: memoryHeld.heapUsed - memoryBefore.heapUsed, rssDelta: memoryHeld.rss - memoryBefore.rss }
    } else if (scenario === 'priority') {
      foregroundRequestedAt = elapsed()
      const at = listing + 3 * steps['1H']
      foreground = await service.history.sync.enqueue({ instrument: foregroundID, timeframe: '5m', source: 'candles', from: at, through: at, priority: 'interactive' })
    } else {
      // Existing parent data must be usable before an unrelated 5m response
      // is released. Report a timeout as a diagnostic rather than deadlock.
      await deadline(existingParentReady, 'Existing parent coverage', 1000).catch(() => {})
      existingParentBeforeRelease = existingParentReadyMS !== null
      const snapshot = service.historyDownload.snapshot()
      existingProgressBeforeRelease = { checked: snapshot.progress.checked, available: snapshot.progress.available,
        completedStreams: snapshot.streams.completed,
        parentStreams: service.historyDownload.job.streams.filter(stream => stream.instrument === heldInstrument && stream.source === 'candles' && stream.timeframe !== '5m')
          .map(stream => ({ timeframe: stream.timeframe, completed: stream.done, available: stream.available })),
        parentTasks: service.history.sync.listTasks().filter(task => task.instrument === heldInstrument && task.source === 'candles' && task.timeframe !== '5m')
          .map(task => ({ timeframe: task.timeframe, status: task.status, coveredRecords: task.coveredRecords, localRecords: task.localRecords })) }
    }
    releaseFirst()
  }
  let foregroundResult
  if (foreground) foregroundResult = await deadline(service.history.sync.waitFor(foreground.id), 'Foreground request', 60_000)
  const foregroundCompletedAt = foreground ? elapsed() : null
  await deadline(downloadTask, 'History download', 300_000)
  const wallMS = elapsed(), cpu = process.cpuUsage(cpuStart), thread = process.threadCpuUsage(threadStart)
  const report = service.historyDownload.snapshot(), observedDB = { ...database }
  assert.equal(report.phase, scenario === 'failure' || scenario === 'gap' ? 'failed' : 'completed', JSON.stringify(report.failures))
  if (scenario === 'failure' || scenario === 'gap') assert.ok(report.failures.some(value => value.instrument === ids[0] && value.timeframe === '5m' && value.source === 'candles'))
  if (foreground) assert.equal(foregroundResult.status, 'completed')
  const expectedRows = {}, hashes = {}, statisticsHashes = {}
  for (const instrument of ids) for (const [timeframe, step] of Object.entries(steps)) {
    const from = Math.ceil(listing / step) * step, through = Math.floor(now / step) * step - step
    const rows = await store.candles({ instrument, timeframe, from, through })
    const map = new Map(rows.map(row => [row.timestamp, row])), expected = []
    for (let stamp = from; stamp <= through; stamp += step) {
      const interruptedFine = (scenario === 'failure' || scenario === 'gap') && instrument === ids[0] && timeframe === '5m'
      // A failed chunk leaves older, never-attempted 5m chunks pending. Check
      // every fact that did commit without inventing completion or absence.
      if (interruptedFine && !map.has(stamp)) continue
      assert.ok(!(scenario === 'gap' && instrument === ids[0] && timeframe === '5m' && stamp === omitted), 'A missing fine slot cannot be fabricated.')
      expected.push(stamp)
      const actual = map.get(stamp), raw = candle(instrument, timeframe, stamp).map(Number)
      assert.ok(actual, `${instrument} ${timeframe} missing ${stamp}`)
      assert.deepEqual([actual.open, actual.high, actual.low, actual.close, actual.volume, actual.baseVolume, actual.quoteVolume], raw.slice(1, 8), `${instrument} ${timeframe} ${stamp}`)
      assert.deepEqual([actual.oi, actual.sell, actual.buy], [50, 1, 2], `${instrument} ${timeframe} statistics ${stamp}`)
    }
    if (scenario === 'failure' && instrument === ids[0] && timeframe === '5m') assert.equal(rows.length, 0)
    assert.equal(rows.length, expected.length, `${instrument} ${timeframe} count`)
    const key = `${instrument}:${timeframe}`, digest = createHash('sha256')
    for (const row of rows) digest.update(JSON.stringify([row.timestamp, row.open, row.high, row.low, row.close, row.volume, row.baseVolume, row.quoteVolume, row.oi, row.sell, row.buy]))
    hashes[key] = digest.digest('hex'); expectedRows[key] = rows.length
    // Statistics have independent lifetimes and may exist even where the
    // candle source is missing or failed; validate every slot separately.
    const stats = await store.statistics({ instrument, timeframe, from, through }), statsHash = createHash('sha256')
    assert.equal(stats.length, (through - from) / step + 1, `${key} statistics count`)
    for (let index = 0; index < stats.length; index++) {
      const row = stats[index]
      assert.equal(row.timestamp, from + index * step)
      assert.deepEqual([row.oi, row.sell, row.buy, row.statisticsVersion], [50, 1, 2, 11])
      statsHash.update(JSON.stringify([row.timestamp, row.oi, row.sell, row.buy, row.statisticsVersion]))
    }
    statisticsHashes[key] = statsHash.digest('hex')
  }
  const fgCall = foreground && calls.find(value => value.instrument === foregroundID && value.source === 'candles')
  if (foreground) assert.ok(fgCall && fgCall.startedMS >= foregroundRequestedAt)
  if (await fingerprint() !== inputHash) throw new Error('Benchmark inputs changed during the run; discard this measurement.')
  const result = { variant, scenario, revision, baselineRevision, worktreeDirty, inputHash, sourceSHA256, delayMS: interval, chunkSlots: service.historyDownload.chunkSlots,
    instruments: ids.length, listing, asOf: now, durationHours: (now - listing) / steps['1H'],
    sandboxDirectory: process.env.PERPETUAL_SWAP_OPERATION_DIR ? dirname(process.env.PERPETUAL_SWAP_OPERATION_DIR) : null,
    measurement: 'Baseline uses MarketService, history/download/sync/store/SQLite worker sources from baselineRevision; unchanged dependencies are shared. Synthetic Response bodies exclude HTTP/TLS overhead; rate-lane intervals are disabled. Process CPU includes worker threads and recording, not energy.',
    wallMS, processCPUms: (cpu.user + cpu.system) / 1000, mainThreadCPUms: (thread.user + thread.system) / 1000,
    maximumConcurrentRequests: maximumActive, firstParentMS, firstParentCoveredMS, firstParentByTimeframe, firstParentCoveredByTimeframe,
    existingParentBeforeFineRelease: scenario === 'existing' ? { instrument: heldInstrument, ready: existingParentBeforeRelease, readyMS: existingParentReadyMS, progress: existingProgressBeforeRelease } : null,
    fragmentation, requests, databaseAPIcalls: observedDB, historyTasks: tasks,
    foreground: foreground ? { requestedMS: foregroundRequestedAt, startedMS: fgCall.startedMS, completedMS: foregroundCompletedAt,
      queuedMS: fgCall.startedMS - foregroundRequestedAt, completionMS: foregroundCompletedAt - foregroundRequestedAt } : null,
    report: { phase: report.phase, progress: report.progress, failures: report.failures.map(({ instrument, timeframe, source }) => ({ instrument, timeframe, source })) },
    expectedRows, hashes, statisticsHashes }
  if (values.output) await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result))
} finally {
  releaseFirst?.()
  await service.dispose(); await store.close(); await rm(rootDir, { recursive: true, force: true })
}
