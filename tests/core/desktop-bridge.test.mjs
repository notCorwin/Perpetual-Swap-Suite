import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { encodeChartWire } from '../../electron/chart-wire.js'
import { attachOperationSink } from '../../electron/services/operations.js'
import { initializeOperationTelemetry } from '../../src/operation-telemetry.ts'

const preload = await readFile(new URL('../../electron/preload.cjs', import.meta.url), 'utf8')
const chart = { instId: 'BTC-USDT-SWAP', liveBar: { close: 101 }, optional: undefined }
const wire = encodeChartWire(chart)
const trap = name => () => { throw new Error(`Unexpected ${name}`) }

function harness(enabled, state = Promise.resolve({ epoch: 0, active: true, startedAt: 0 })) {
  const listeners = new Map(), windowListeners = new Map(), calls = [], delivered = [], batches = []
  let nonceCalls = 0, nextTimer = 0
  const timers = new Map()
  const window = {
    addEventListener(type, handler) { const handlers = windowListeners.get(type) ?? []; handlers.push(handler); windowListeners.set(type, handlers) },
    removeEventListener(type, handler) { windowListeners.set(type, (windowListeners.get(type) ?? []).filter(value => value !== handler)) },
    dispatchEvent(event) { delivered.push(event); return true },
    setTimeout: enabled ? callback => { const id = ++nextTimer; timers.set(id, callback); return id } : trap('recording timer'),
    clearTimeout: enabled ? id => timers.delete(id) : trap('recording timer cancellation'),
  }
  const ipcRenderer = {
    on(channel, handler) { listeners.set(channel, handler) },
    send(...args) { calls.push(['send', ...args]) },
    async invoke(...args) {
      calls.push(['invoke', ...args])
      if (args[0] === 'radar:presentation-state') return state
      if (args[0] === 'radar:operations-initialize') return { sessionId: 'bridge-test', executionId: 'bridge-renderer' }
      if (args[0] === 'radar:operations') {
        const batch = args[1]; batches.push(batch)
        return { batchId: batch.batchId, lastSequence: batch.events.at(-1).sequence }
      }
      if (args[0] === 'radar:request') {
        if (args[1].copyText === 'fail') throw new Error('Request failed')
        return args[1].chartWindow ? wire : { ok: true }
      }
      throw new Error(`Unexpected IPC: ${args[0]}`)
    },
  }
  const crypto = { getRandomValues: enabled ? bytes => { nonceCalls++; return bytes.fill(1) } : trap('recording nonce') }
  vm.runInNewContext(preload, { require: name => {
    assert.equal(name, 'electron')
    return { ipcRenderer, contextBridge: { exposeInMainWorld: (name, value) => { window[name] = value } } }
  }, process: { argv: enabled ? ['electron', '--perpetual-swap-operation-recording'] : ['electron'], platform: 'darwin' }, window, crypto, Uint8Array })
  return { window, listeners, windowListeners, calls, delivered, batches, timers, nonceCalls: () => nonceCalls,
    notify: (channel, detail, context, epoch) => listeners.get(channel)({}, detail, context, epoch) }
}

async function connect(h, suffix) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: h.window })
  await import(new URL(`../../src/desktop-bridge.ts?${suffix}`, import.meta.url).href)
  return h.window.radarDesktop
}

test('recording off skips telemetry while requests and buffered or live notifications work', async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const priorPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  const priorObserver = Object.getOwnPropertyDescriptor(globalThis, 'PerformanceObserver')
  const h = harness(false), generated = []
  // The enclosing Node sandbox also records the dynamic TS module loader.
  // Renderer bridge work has no filesystem access; ignore only those reads.
  const detach = attachOperationSink(event => {
    if (event.category === 'io' && ['fs.realpathSync', 'fs.readFileSync'].includes(event.name)) return
    generated.push(event)
  })
  try {
    h.notify('radar:chart-prepared', wire, { traceId: 'ignored' })
    Object.defineProperty(globalThis, 'performance', { configurable: true, get: trap('wall clock') })
    Object.defineProperty(globalThis, 'PerformanceObserver', { configurable: true, get: trap('performance observer') })
    const desktop = await connect(h, 'off')
    assert.equal(desktop.operationRecording, false)
    assert.ok(Object.isFrozen(desktop))
    const stop = await initializeOperationTelemetry()
    assert.deepEqual(h.delivered.map(event => [event.type, event.detail]), [['radar-chart-prepared', chart]])
    h.notify('radar:market-changed', { revision: 2 })
    h.notify('radar:chart-prepared', wire)
    assert.deepEqual(h.delivered.slice(1).map(event => [event.type, event.detail]), [
      ['radar-market-changed', { revision: 2 }], ['radar-chart-prepared', chart],
    ])
    assert.throws(() => h.notify('radar:chart-prepared', 'bad wire'), /Invalid chart wire|Unexpected token/)
    assert.deepEqual(await desktop.request({ chartWindow: { instId: chart.instId, timeframe: '15m' } }), chart)
    assert.deepEqual(await desktop.request({ copyText: 'ok' }), { ok: true })
    await assert.rejects(desktop.request({ copyText: 'fail' }), /Request failed/)
    assert.throws(() => desktop.initializeOperations({}), /disabled/)
    assert.throws(() => desktop.recordOperations({}), /disabled/)
    assert.throws(() => desktop.operationSourceFailure({}), /disabled/)
    await stop()
    assert.equal(h.nonceCalls(), 0)
    assert.equal(h.listeners.has('radar:operations-drain'), false)
    assert.equal(h.windowListeners.has('pagehide'), false)
    assert.deepEqual(h.calls.map(call => [call[0], call[1], call.length]), [
      ['invoke', 'radar:presentation-state', 2],
      ['invoke', 'radar:request', 3], ['invoke', 'radar:request', 3], ['invoke', 'radar:request', 3],
    ])
    assert.deepEqual(generated, [])
  } finally {
    detach()
    if (priorPerformance) Object.defineProperty(globalThis, 'performance', priorPerformance); else Reflect.deleteProperty(globalThis, 'performance')
    if (priorObserver) Object.defineProperty(globalThis, 'PerformanceObserver', priorObserver); else Reflect.deleteProperty(globalThis, 'PerformanceObserver')
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('presentation fences old notifications and decodes the resume barrier before delivery', async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let resolveState
  const initial = new Promise(resolve => { resolveState = resolve })
  const h = harness(false, initial), updates = []
  try {
    const desktop = await connect(h, 'presentation')
    const stop = desktop.subscribePresentation(value => updates.push(value))
    assert.equal(updates.at(-1).active, true)
    h.notify('radar:presentation', { epoch: 1, active: false, startedAt: 100 })
    h.notify('radar:market-changed', { revision: 1 }, undefined, 0)
    h.notify('radar:market-changed', { revision: 2 }, undefined, 1)
    resolveState({ epoch: 0, active: true, startedAt: 0 })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(updates.at(-1).active, false)
    const snapshot = { market: { rows: [] }, frames: [chart], preferences: {}, audit: {}, download: {}, gateway: [] }
    h.notify('radar:presentation', { epoch: 2, active: false, startedAt: 200 })
    h.notify('radar:presentation', { epoch: 2, active: true, startedAt: 200, snapshot: encodeChartWire(snapshot) })
    assert.deepEqual(updates.at(-1).snapshot, snapshot)
    h.notify('radar:market-changed', { revision: 3 }, undefined, 1)
    h.notify('radar:chart-prepared', wire, undefined, 2)
    assert.deepEqual(h.delivered.map(event => [event.type, event.detail]), [['radar-chart-prepared', chart]])
    h.notify('radar:presentation', { epoch: 1, active: false, startedAt: 100 })
    assert.equal(updates.at(-1).epoch, 2)
    stop()
    let retained
    desktop.subscribePresentation(value => { retained = value })()
    assert.equal(retained.snapshot, undefined, 'Late subscribers must not retain or replay the bulk resume payload.')
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('recording on retains request and notification spans and drains acknowledged batches', async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const h = harness(true)
  let stop
  try {
    const desktop = await connect(h, 'on')
    assert.equal(desktop.operationRecording, true)
    stop = await initializeOperationTelemetry()
    assert.equal(h.nonceCalls(), 1)
    assert.deepEqual(await desktop.request({ chartWindow: { instId: chart.instId, timeframe: '15m' } }), chart)
    await assert.rejects(desktop.request({ copyText: 'fail' }), /Request failed/)
    h.notify('radar:chart-prepared', wire, { traceId: 'market-trace', parentId: 'market-send' })
    assert.deepEqual(h.delivered.at(-1).detail, chart)
    assert.throws(() => h.notify('radar:chart-prepared', 'bad wire'), /Invalid chart wire|Unexpected token/)
    await h.listeners.get('radar:operations-drain')({}, { id: 'drain-1' })
    const [method, channel, acknowledgment] = h.calls.at(-1)
    assert.equal(method, 'send'); assert.equal(channel, 'radar:operations-drained')
    assert.equal(acknowledgment.id, 'drain-1'); assert.equal(acknowledgment.ok, true)
    const events = h.batches.flatMap(batch => batch.events).filter(event => event.phase === 'end')
    assert.deepEqual(events.filter(event => event.name === 'desktop.request').map(event => event.status), ['ok', 'error'])
    const notifications = events.filter(event => event.name === 'desktop.notification.receive')
    assert.deepEqual(notifications.map(event => event.status), ['ok', 'error'])
    assert.equal(notifications[0].traceId, 'market-trace')
    assert.equal(notifications[0].parentId, 'market-send')
    assert.equal(h.timers.size, 0)
  } finally {
    if (stop) await stop()
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window')
  }
})
