#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/preferences.js'
import { replayHarnessFingerprint } from './replay-fingerprint.mjs'

// The process is isolated: only service wall time is advanced; Node timers and
// external IO remain real. No network response may be consumed by this replay.
if (process.env.PERPETUAL_SWAP_SANDBOX !== '1' || process.env.PERPETUAL_SWAP_ALLOW_NETWORK !== '0') throw new Error('Run in the network-disabled test sandbox.')
const output = resolve(process.argv[2] ?? '.build/market-branch-replay.json')
const cycles = Number(process.argv[3] ?? 1)
assert.ok(Number.isSafeInteger(cycles) && cycles >= 1 && cycles <= 1_000, 'Replay cycles must be between 1 and 1000.')
const root = await mkdtemp(`${tmpdir()}/market-branch-replay-`)
const realNow = Date.now
let now = 1_800_000_060_000
Date.now = () => now
const hash = value => createHash('sha256').update(value).digest('hex')
const id = 'REPLAY-USDT-SWAP'
const instrument = { instId: id, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '1', ctMult: '1', ctValCcy: 'REPLAY', ruleType: 'normal' }
const preferences = structuredClone(DEFAULT_PREFERENCES)
for (const [key, rule] of Object.entries(preferences.liquidity)) rule.enabled = key === 'spread'
const store = await MarketStore.open(root)
let sourceRequests = 0
const service = new MarketService(store, () => preferences, async () => {
  sourceRequests++
  return new Response(JSON.stringify({ code: '0', data: [] }))
}, false)
const taskErrors = []
const track = service.track.bind(service)
service.track = promise => {
  Promise.resolve(promise).catch(error => taskErrors.push({ name: error?.name ?? 'Error', message: String(error?.message ?? error) }))
  return track(promise)
}
const counters = Object.fromEntries(['receivePublicObservation', 'flushStreamQualifications', 'replaceCatalog', 'processMarketDeadline', 'scheduleTickerDeadline', 'scheduleMarketDeadline', 'bufferListRemoval'].map(name => [name, 0]))
for (const name of Object.keys(counters)) {
  const original = service[name].bind(service)
  service[name] = (...args) => { counters[name]++; return original(...args) }
}
const phases = []
const quote = spread => ({ instId: id, last: '100', bidPx: '100', askPx: String(100 + spread), ts: String(now) })
const state = () => ({ catalog: service.catalog.has(id), status: service.catalogChecks.get(id)?.status ?? null,
  listed: service.listRowsFor().some(row => row.instId === id), removal: service.listRemovals.has(id),
  pending: service.streamQualifications.size, evaluations: service.streamEvaluations.size })
const phase = (name, action, expected) => {
  const before = { ...counters }, started = performance.now()
  action()
  const actual = state()
  assert.deepEqual(actual, expected, `${name} outcome`)
  phases.push({ name, elapsedMS: performance.now() - started, counters: Object.fromEntries(Object.keys(counters).map(key => [key, counters[key] - before[key]])), actual })
}
const controlled = process.env.PERPETUAL_SWAP_REPLAY_CONTROLLER === '1'
const awaitCommand = expected => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for replay controller: ${expected}.`)), 30_000)
  process.once('message', message => { clearTimeout(timer); message === expected ? resolve() : reject(new Error(`Unexpected replay command: ${message}`)) })
})
const stable = { catalog: true, status: 'verified', listed: true, removal: false, pending: 0, evaluations: 0 }
try {
  await service.ready
  service.setPresentationActive(false)
  const step = 300_000, boundary = Math.floor(now / step) * step
  const candles = Array.from({ length: 720 }, (_, index) => ({ instrument: id, timeframe: '5m',
    timestamp: boundary - (300 - index) * step, open: 100, high: 101, low: 99, close: 100,
    volume: 10, baseVolume: 1, quoteVolume: 1000, confirmed: true }))
  await store.appendCandles(candles)
  service.installInstruments(new Map([[id, instrument]]))
  service.verifyCatalog()
  service.receivePublicObservation(id, 'ticker', quote(.01))
  service.flushStreamQualifications()
  assert.deepEqual(state(), stable, 'The initial source input must qualify.')
  if (controlled) { process.send('ready'); await awaitCommand('run') }
  for (let cycle = 0; cycle < cycles; cycle++) {
  assert.deepEqual(state(), stable, `Cycle ${cycle + 1} must begin from the verified state.`)
  const firstPhase = phases.length
  phase('membership-fail', () => { now += 1; service.receivePublicObservation(id, 'ticker', quote(1)); service.flushStreamQualifications() },
    { catalog: false, status: 'failed', listed: true, removal: true, pending: 0, evaluations: 0 })
  phase('membership-recover', () => { now += 1; service.receivePublicObservation(id, 'ticker', quote(.01)); service.flushStreamQualifications() }, stable)
  phase('expiry', () => { now += 90_001; service.processMarketDeadline() },
    { catalog: false, status: 'unknown', listed: true, removal: true, pending: 0, evaluations: 0 })
  phase('list-retirement', () => { now += 30_000; service.processMarketDeadline() },
    { catalog: false, status: 'unknown', listed: false, removal: false, pending: 0, evaluations: 0 })
  phase('observation-renewal', () => { now += 1; service.installInstruments(new Map([[id, instrument]])); service.receivePublicObservation(id, 'ticker', quote(.01)); service.flushStreamQualifications() }, stable)
  const drainDeadline = performance.now() + 5_000
  while (service.backgroundTasks.size || service.streamEvaluations.size) {
    assert.ok(performance.now() < drainDeadline, 'Background work failed to drain within 5 seconds.')
    await Promise.race([Promise.allSettled([...service.backgroundTasks, ...service.streamEvaluations.values()]),
      new Promise(resolve => setTimeout(resolve, 10))])
  }
  assert.deepEqual(state(), stable, 'The final state must remain stable after background work drains.')
  const row = service.listRowsFor().find(value => value.instId === id)
  const entry = service.catalog.get(id)
  assert.equal(row?.lastPrice, 100, 'Renewed list price must match the source ticker.')
  assert.equal(row?.rankingChange, 0, 'Constant seeded closing prices must yield zero ranking change.')
  assert.equal(entry?.expiresAt - now, 90_000, 'The renewed qualification must retain its full observation lease.')
  assert.deepEqual(entry.result.checks.map(check => [check.key, check.status]), [['instrument', 'verified'], ['spread', 'verified'],
    ['depth', 'disabled'], ['slippage', 'disabled'], ['volume24h', 'disabled'], ['openInterest', 'disabled'], ['volumeStability', 'disabled']])
  assert.ok(Math.abs(entry.result.checks.find(check => check.key === 'spread').value - 0.01) < 1e-10, 'Spread must match the input quote.')
  assert.deepEqual(taskErrors, [], 'Tracked background tasks must not fail.')
  assert.deepEqual([...service.sourceErrors.keys()], [], 'The service must not report a source error.')
  assert.equal(service.error, '', 'The service must not report an error.')
  for (const entry of phases.slice(firstPhase)) entry.cycle = cycle + 1
  }
  assert.equal(sourceRequests, 0, 'Fixed history must satisfy the replay without external source requests.')
  for (const name of ['membership-fail', 'membership-recover', 'expiry', 'list-retirement', 'observation-renewal']) assert.ok(phases.find(value => value.name === name).counters[name === 'expiry' || name === 'list-retirement' ? 'processMarketDeadline' : 'receivePublicObservation'] > 0)
  assert.ok(phases.find(value => value.name === 'membership-fail').counters.replaceCatalog > 0)
  assert.ok(phases.find(value => value.name === 'membership-recover').counters.replaceCatalog > 0)
  assert.ok(phases.find(value => value.name === 'expiry').counters.bufferListRemoval > 0)
  if (controlled) { process.send('done'); await awaitCommand('close') }
  const inputs = { instrument, preferences, cycles, clockStart: 1_800_000_060_000, events: [
    { advanceMS: 1, source: 'ticker', last: 100, bid: 100, ask: 101 },
    { advanceMS: 1, source: 'ticker', last: 100, bid: 100, ask: 100.01 },
    { advanceMS: 90_001, action: 'deadline' }, { advanceMS: 30_000, action: 'deadline' },
    { advanceMS: 1, source: 'instrument-and-ticker', last: 100, bid: 100, ask: 100.01 },
  ] }
  const outputState = { ...state(), rows: service.listRowsFor().map(row => ({ instId: row.instId, lastPrice: row.lastPrice,
    rankingChange: row.rankingChange ?? null, rankingAsOf: row.rankingAsOf ?? null })),
    catalog: [...service.catalog].map(([instId, entry]) => ({ instId, status: entry.status, expiresInMS: entry.expiresAt - now,
      ticker: entry.ticker, checks: entry.result.checks })),
    deadlineInMS: service.marketDeadlineAt === null ? null : service.marketDeadlineAt - now }
  const sourceFiles = (await readdir('electron/services')).filter(name => /\.(?:js|cjs|mjs)$/.test(name)).sort().map(name => `electron/services/${name}`)
  const sourceFingerprint = { serviceFiles: Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, hash(await readFile(path))]))),
    harness: await replayHarnessFingerprint() }
  const report = { schemaVersion: 1, mode: 'isolated-market-service-branch-replay', revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runtime: { node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch },
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), sourceFingerprint,
    inputHash: hash(JSON.stringify(inputs)), configHash: hash(JSON.stringify({ preferences, cycles })), databaseFixtureHash: hash(JSON.stringify(candles)),
    input: inputs, initialDatabase: 'new MarketStore with 300 past and 420 future fixed 5m candles; range queries exclude future bars until virtual time advances', clock: 'Fixed Date.now in isolated Node process; timers and IO remain real.',
    drain: 'Each phase flushes qualification and requires zero pending qualifications and evaluations; final background tasks drain within 5 seconds.',
    externalBoundary: { kind: 'in-memory empty OKX response', sourceRequests, scope: 'Observation renewal only; transport faults and HTTP retries are not exercised.' },
    phases, finalDigest: hash(JSON.stringify(outputState)), finalState: outputState, counters, taskErrors }
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ output, cycles, phases: phases.length, finalState: report.finalState }))
} finally {
  await service.dispose(); await store.close(); Date.now = realNow; await rm(root, { recursive: true, force: true })
}
