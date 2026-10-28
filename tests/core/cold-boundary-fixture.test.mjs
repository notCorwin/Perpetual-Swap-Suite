import assert from 'node:assert/strict'
import test from 'node:test'
import { createChartColdBoundaryFixture } from '../../electron/e2e-fixtures.js'
import { measureMissingWindow } from '../../scripts/chart-acceptance.mjs'

for (const cleanupFails of [false, true]) test(`missing-window setup drains a partial source installation${cleanupFails ? ' without replacing its error with a cleanup error' : ''}`, async () => {
  const setupError = new Error('Source installation failed after admission.')
  const cleanupError = new Error('Source cleanup failed after draining.')
  const actions = []
  let active = false
  const electron = { async evaluate(_operation, input) {
    if (!input) return { visible: false, focused: false, offscreen: true }
    actions.push(input.action)
    if (input.action === 'coldBoundaryInstall') { active = true; throw setupError }
    if (input.action === 'coldBoundaryRemove') { active = false; if (cleanupFails) throw cleanupError; return }
    assert.fail(`Unexpected backend action: ${input.action}`)
  } }
  await assert.rejects(measureMissingWindow(electron, {}), error => {
    if (cleanupFails) {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [setupError, cleanupError])
      assert.equal(error.cause, setupError)
      assert.match(error.message, /Source installation failed/)
      assert.match(error.message, /Source cleanup failed/)
    } else assert.equal(error, setupError)
    return true
  })
  assert.equal(active, false, 'A failed setup must not leave source work owned by the next test.')
  assert.deepEqual(actions, ['coldBoundaryInstall', 'coldBoundaryRemove'])
})

function fakeService(get = async () => []) {
  const listeners = new Set(), retired = [], focusChanges = []
  const service = {
    get, persistCandles: async () => {}, instruments: new Map(), catalog: new Map(), listRemovals: new Map(),
    listedUniverse: new Set(), catalogRevision: 0, rankingTasks: new Map(), rankingRepairs: new Map(),
    preparedCharts: { focus: null, universe: new Set(), observeStatistics: async () => {},
      setFocus(target) { this.focus = target; focusChanges.push(target) } },
    history: { sync: { active: new Map() }, async removeTargets(ids) { retired.push(...ids) } },
    subscribePreparedCharts(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    replaceCatalog(entries) {
      const next = new Map(entries.map(entry => [entry.instrument.instId, { ...entry }]))
      for (const id of next.keys()) this.listRemovals.delete(id)
      for (const [id, entry] of this.catalog) if (!next.has(id) && !this.listRemovals.has(id)) {
        this.listRemovals.set(id, { entry, removeAt: Date.now() + 30_000 })
      }
      this.catalog = next
      this.updateListedUniverse()
    },
    updateListedUniverse() {
      this.listedUniverse = new Set([...this.catalog.keys(), ...this.listRemovals.keys()])
      this.preparedCharts.universe = new Set(this.listedUniverse)
    },
    touchList() {}, updateSubscriptions() {}, scheduleMarketDeadline() {},
  }
  return { service, listeners, retired, focusChanges }
}

for (const failNearestCandles of [false, true]) test(`cold source ${failNearestCandles ? 'failure' : 'success'} waits through an early timer and wall-clock adjustment`, async context => {
  const { service } = fakeService()
  const control = await createChartColdBoundaryFixture({ appendStatistics: async () => {} }, service,
    { scenario: 'full-missing-window', sourceDelayMS: 1800, failNearestCandles })
  const timers = []
  let now = 1000, settled = false
  const wall = Date.now()
  context.mock.method(performance, 'now', () => now)
  context.mock.method(globalThis, 'setTimeout', (callback, delay) => { timers.push({ callback, delay }); return timers.length })
  const { fixture } = control
  const result = service.get('/market/history-candles', { instId: fixture.instId, bar: fixture.timeframe,
    after: String(fixture.targetEnd + fixture.intervalMS), limit: 96 }, new AbortController().signal, 'foreground')
    .then(value => { settled = true; return { value } }, error => { settled = true; return { error } })
  try {
    assert.equal(timers.length, 1)
    context.mock.method(Date, 'now', () => wall - 30_000)
    now = 2799.5
    timers.shift().callback()
    for (let index = 0; index < 4; index++) await Promise.resolve()
    assert.equal(settled, false, 'An early timer must not resolve or fail the source before the complete delay.')
    assert.equal(control.read().requests[0].completedAt, null)
    assert.equal(control.read().requests[0].failedAt, null)
    assert.equal(timers[0].delay, 1)
    now = 2800
    timers.shift().callback()
    const outcome = await result, request = control.read().requests[0]
    assert.equal((request.failedAt ?? request.completedAt) - request.startedAt, 1800,
      'Elapsed source time follows the monotonic clock independently of wall time.')
    if (failNearestCandles) assert.match(outcome.error.message, /Configured cold-window source failure/)
    else assert.equal(outcome.value.length, 96)
  } finally { await control.remove() }
})

test('the passive prepared witness requires the exact completed source and a complete target in a history publication', async () => {
  const { service, listeners } = fakeService()
  const control = await createChartColdBoundaryFixture({ appendStatistics: async () => {} }, service, { sourceDelayMS: 0 })
  const { fixture } = control, allBars = fixture.series[fixture.timeframe].bars
  const first = allBars.findIndex(bar => bar.hour === fixture.targetWindowStart)
  const bars = allBars.slice(first, first + 97).map(bar => ({ ...bar, indicatorsObserved: true }))
  const publish = frame => { for (const listener of listeners) listener(frame) }
  const frame = { instId: fixture.instId, timeframe: fixture.timeframe, endHour: fixture.end, generation: 4, revision: 7, bars }
  const source = through => service.get('/market/history-candles', { instId: fixture.instId, bar: fixture.timeframe,
    after: String(through + fixture.intervalMS), limit: 248 }, new AbortController().signal, 'foreground')
  try {
    publish(frame)
    await source(fixture.firstMissingEnd + fixture.intervalMS)
    publish(frame)
    assert.equal(control.read().preparedTarget, null, 'An unrelated completed page must not start the witness.')
    await source(fixture.firstMissingEnd)
    publish({ ...frame, instId: 'OTHER' })
    publish({ ...frame, bars: bars.slice(0, 96) })
    publish({ ...frame, bars: bars.map((bar, index) => index ? bar : { ...bar, indicatorsObserved: false }) })
    publish({ ...frame, bars: bars.map((bar, index) => index ? bar : { ...bar, ema: null }) })
    publish({ ...frame, bars: bars.map((bar, index) => index ? bar : { ...bar, close: null }) })
    publish({ ...frame, bars: bars.map((bar, index) => index ? bar : { ...bar, priceComplete: false }) })
    assert.equal(control.read().preparedTarget, null, 'Other instruments, viewport-only frames, and incomplete target values are not witnesses.')
    publish(frame)
    const witness = control.read().preparedTarget
    const nearest = control.read().requests.find(request => request.through === fixture.firstMissingEnd)
    assert.equal(witness.sourceCompletedAt, nearest.completedAt)
    assert.ok(witness.at >= nearest.completedAt)
    assert.equal(witness.targetStart, fixture.targetWindowStart)
    assert.equal(witness.targetEnd, fixture.targetEnd)
    assert.equal(witness.historyBars, 97)
    publish({ ...frame, revision: 8 })
    assert.deepEqual(control.read().preparedTarget, witness, 'Later publications must not replace the first witness.')
  } finally { await control.remove() }
  assert.equal(listeners.size, 0)
})

for (const scenario of ['single-missing-boundary', 'full-missing-window']) test(`${scenario} holds optional and reserve pages while serving the nearest price page`, async () => {
  const { service } = fakeService()
  let initialRows
  service.persistCandles = async (_instrument, rows) => { initialRows = rows }
  const control = await createChartColdBoundaryFixture({ appendStatistics: async () => {} }, service, { scenario, sourceDelayMS: 0 })
  const { fixture } = control
  const nearest = scenario === 'full-missing-window' ? fixture.targetEnd : fixture.firstMissingEnd
  const source = through => service.get('/market/history-candles', { instId: fixture.instId, bar: fixture.timeframe,
    after: String(through + fixture.intervalMS), limit: 2 })
  try {
    assert.equal(initialRows.length, scenario === 'full-missing-window' ? 512 : 1000)
    const page = await source(nearest)
    const expected = fixture.series[fixture.timeframe].bars.find(bar => bar.hour === nearest)
    assert.equal(Number(page[0][0]), nearest)
    assert.equal(Number(page[0][4]), expected.close)
    const reserve = source(nearest - fixture.intervalMS)
    const optional = service.get('/rubik/stat/taker-volume-contract', { instId: fixture.instId, period: fixture.timeframe,
      begin: nearest - 2 * fixture.intervalMS, end: nearest + fixture.intervalMS })
    assert.equal(control.read().active, 2)
    assert.deepEqual(control.read().requests.map(item => item.held), [false, true, true])
    control.release()
    assert.equal(Number((await reserve)[0][0]), nearest - fixture.intervalMS)
    assert.equal(Number((await optional)[0][0]), nearest)
  } finally { await control.remove() }
})

test('a failed initial seed does not install a fixture provider', async () => {
  const { service } = fakeService()
  const original = service.get
  service.persistCandles = async () => { throw new Error('Seed failed.') }
  await assert.rejects(createChartColdBoundaryFixture({ appendStatistics: async () => {} }, service), /Seed failed/)
  assert.equal(service.get, original)
})

test('disposal aborts held, delayed and delegated fixture requests without changing their error ownership', async () => {
  const calls = []
  const original = (_path, parameters, signal, _priority, options) => {
    calls.push({ instId: parameters.instId, signal, options })
    if (parameters.instId === 'OTHER') return Promise.resolve(['other'])
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }
  const { service } = fakeService(original)
  const control = await createChartColdBoundaryFixture({ appendStatistics: async () => {} }, service,
    { scenario: 'full-missing-window', sourceDelayMS: 1800, failNearestCandles: true })
  const { fixture } = control, fixtureGet = service.get
  const candles = { instId: fixture.instId, bar: fixture.timeframe, after: String(fixture.targetEnd + fixture.intervalMS), limit: 96 }
  const ownedAbort = new AbortController(), ownerReason = new Error('The original consumer cancelled.')
  const cancelled = fixtureGet('/market/history-candles', candles, ownedAbort.signal).catch(error => error)
  ownedAbort.abort(ownerReason)
  assert.equal(await cancelled, ownerReason)
  const delayed = fixtureGet('/market/history-candles', candles).catch(error => error)
  const held = fixtureGet('/rubik/stat/contracts/open-interest-history', {
    instId: fixture.instId, period: fixture.timeframe, begin: fixture.targetWindowStart - fixture.intervalMS, end: fixture.targetEnd + fixture.intervalMS,
  }).catch(error => error)
  const options = { getPriority: () => 'interactive' }
  const delegated = fixtureGet('/market/candles', { instId: fixture.instId }, undefined, 'foreground', options).catch(error => error)
  assert.deepEqual(await fixtureGet('/market/candles', { instId: 'OTHER' }), ['other'])
  assert.equal(control.read().active, 2)

  const first = control.remove(), second = control.remove()
  assert.equal(first, second, 'Concurrent disposal callers share the same completion.')
  await first
  for (const error of await Promise.all([delayed, held, delegated])) {
    assert.equal(error.name, 'AbortError')
    assert.match(error.message, /fixture disposed/i)
  }
  assert.equal(calls[0].options, options)
  assert.equal(service.get, original)
  assert.equal(control.read().active, 0)
  assert.equal(control.read().pending, 0)
  assert.equal(control.read().requests[0].error, ownerReason.message)
  assert.ok(control.read().requests.every(request => request.completedAt === null))
  await assert.rejects(fixtureGet('/market/candles', { instId: fixture.instId }), /fixture disposed/i)
  assert.equal(calls.length, 2, 'A retained old provider must never fall through after disposal.')
})

test('disposal retires only its own focus, list entry and history after admitted work drains', async () => {
  const { service, retired, focusChanges } = fakeService()
  const other = { instrument: { instId: 'OTHER-USDT-SWAP' } }, buffered = { instrument: { instId: 'BUFFERED-USDT-SWAP' } }
  service.replaceCatalog([buffered])
  service.replaceCatalog([other])
  const otherRemoval = service.listRemovals.get(buffered.instrument.instId)
  const control = await createChartColdBoundaryFixture({ appendStatistics: async () => {} }, service, { sourceDelayMS: 0 })
  const { instId, timeframe } = control.fixture
  service.replaceCatalog([other])
  assert.ok(service.listRemovals.has(instId), 'The normal 30-second list grace is present before disposal.')
  service.preparedCharts.focus = { instId, timeframe }
  let finishRanking, finishWrite
  const ranking = new Promise(resolve => { finishRanking = resolve })
  const write = new Promise(resolve => { finishWrite = resolve })
  service.rankingTasks.set(`${instId}:15:1`, ranking)
  service.history.sync.active.set('fixture', { group: { instrument: instId }, promise: write })
  service.history.sync.active.set('other', { group: { instrument: other.instrument.instId }, promise: new Promise(() => {}) })
  let finished = false
  const stopped = control.remove().then(() => { finished = true })
  await Promise.resolve()
  assert.equal(service.preparedCharts.focus, null)
  assert.deepEqual(focusChanges, [null])
  assert.equal(service.catalog.has(other.instrument.instId), true)
  assert.equal(service.listRemovals.get(buffered.instrument.instId), otherRemoval)
  assert.equal(service.listRemovals.has(instId), false)
  assert.equal(service.preparedCharts.universe.has(instId), false)
  assert.deepEqual(retired, [], 'An in-flight ranking read must not enqueue after target retirement.')
  finishRanking()
  for (let index = 0; index < 5; index++) await Promise.resolve()
  assert.deepEqual(retired, [instId])
  assert.equal(finished, false, 'An admitted fixture write must complete before disposal resolves.')
  finishWrite()
  await stopped
  assert.equal(finished, true)
})

test('disposal preserves another instrument focus', async () => {
  const { service, retired, focusChanges } = fakeService()
  const control = await createChartColdBoundaryFixture({ appendStatistics: async () => {} }, service, { sourceDelayMS: 0 })
  const focus = { instId: 'OTHER-USDT-SWAP', timeframe: '5m' }
  service.preparedCharts.focus = focus
  await control.remove()
  assert.equal(service.preparedCharts.focus, focus)
  assert.deepEqual(focusChanges, [])
  assert.deepEqual(retired, [control.fixture.instId])
})

test('disposal preserves a replacement instrument owner, focus and provider', async () => {
  const { service, retired, focusChanges } = fakeService()
  const control = await createChartColdBoundaryFixture({ appendStatistics: async () => {} }, service, { sourceDelayMS: 0 })
  const { instId } = control.fixture
  const replacementInstrument = { instId, owner: 'replacement' }
  const replacementEntry = { instrument: replacementInstrument }
  service.catalog.set(instId, replacementEntry)
  service.instruments.set(instId, replacementInstrument)
  const focus = { instId, timeframe: '5m' }
  service.preparedCharts.focus = focus
  const fixtureGet = service.get
  const replacementProvider = (...args) => fixtureGet(...args)
  service.get = replacementProvider
  await control.remove()
  assert.equal(service.catalog.get(instId), replacementEntry)
  assert.equal(service.instruments.get(instId), replacementInstrument)
  assert.equal(service.get, replacementProvider)
  assert.equal(service.preparedCharts.focus, focus)
  assert.deepEqual(focusChanges, [])
  assert.deepEqual(retired, [])
})
