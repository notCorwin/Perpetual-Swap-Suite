import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'
import { createDesktopSecurity, isAllowedExternalURL } from '../electron/desktop-security.js'
import { parseDesktopRequest } from '../electron/desktop-contract.js'

test('installed renderer trust follows its entry point without permitting another page or remote origin', () => {
  const rendererFile = fileURLToPath(new URL('../dist/index.html', import.meta.url))
  const rendererURL = pathToFileURL(rendererFile).href
  const security = createDesktopSecurity({ rendererFile })
  assert.equal(security.isAllowedNavigation(`${rendererURL}#chart`), true)
  for (const url of [new URL('./other.html', rendererURL).href, `${rendererURL}?remote=true`, 'https://example.com/', 'data:text/html,untrusted']) {
    assert.equal(security.isAllowedNavigation(url), false, url)
  }
})

test('development navigation stays on the configured loopback origin', () => {
  const security = createDesktopSecurity({ rendererURL: 'http://127.0.0.1:5173/' })
  assert.equal(security.isAllowedNavigation('http://127.0.0.1:5173/chart#latest'), true)
  for (const url of ['http://127.0.0.1:5174/', 'http://localhost:5173/', 'https://127.0.0.1:5173/', 'http://127.0.0.1:5173@elsewhere.example/']) {
    assert.equal(security.isAllowedNavigation(url), false, url)
  }
})

test('external links allow ordinary web and email destinations without exposing local or executable schemes', () => {
  for (const url of ['https://www.okx.com/trade-swap/btc-usdt-swap', 'http://localhost:8080/', 'mailto:help@example.com']) {
    assert.equal(isAllowedExternalURL(url), true, url)
  }
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,unsafe', 'custom-app:run', 'https://user:password@example.com/', 'mailto:help@example.com%0d%0aBcc:other@example.com']) {
    assert.equal(isAllowedExternalURL(url), false, url)
  }
})

test('desktop commands reject mixed operations and keep fixture access explicitly test-only', () => {
  assert.deepEqual(parseDesktopRequest({ snapshot: {} }), { snapshot: {} })
  assert.deepEqual(parseDesktopRequest({ snapshot: { sinceRevision: -1, serviceSession: 'collector-1' } }), { snapshot: { sinceRevision: -1, serviceSession: 'collector-1' } })
  assert.throws(() => parseDesktopRequest({ preferences: { action: 'update', values: { rankingLookback: 30 } }, copyText: 'side effect' }), /exactly one operation/)
  assert.throws(() => parseDesktopRequest({ e2e: { action: 'settings' } }), /unavailable outside tests/)
})

test('backend adapters keep resident reads separate from viewport demand and forward canonical arguments', async () => {
  const calls: unknown[][] = []
  const frame = { instId: 'BTC-USDT-SWAP', bars: [] }
  const universe = { frames: [frame] }
  const snapshot = { rows: [], revision: 3, serviceSession: 'collector-1' }
  const fixture = {
    handle: null as null | ((request: unknown) => Promise<{ value: unknown; error?: unknown }>),
    service: {
      ready: Promise.resolve(), barTasks: new Set(),
      snapshot: (...args: unknown[]) => { calls.push(['snapshot', ...args]); return snapshot },
      subscribePreparedCharts() {}, subscribeMarket() {}, subscribeAudit() {}, subscribeHistoryDownload() {},
      preparedCharts: {
        residentFrames: (...args: unknown[]) => { calls.push(['residentFrames', ...args]); return universe },
        local: (...args: unknown[]) => { calls.push(['local', ...args]); return frame },
        localHistory: (...args: unknown[]) => { calls.push(['localHistory', ...args]); return frame },
        setFocus: (...args: unknown[]) => { calls.push(['setFocus', ...args]) },
        prepare: (...args: unknown[]) => { calls.push(['prepare', ...args]); return frame },
      },
    },
  }
  const fixtureKey = '__desktopContractBackendFixture'
  const fixtureSource = `const fixture = Reflect.get(globalThis, '${fixtureKey}');`
  const stubs = new Map([
    ['node:worker_threads', 'export const parentPort = { postMessage() {} }, workerData = { userData: "unused", testMode: true }, threadId = 1;'],
    ['./worker-operations.js', `${fixtureSource}
      export const runWorkerInitialization = (_role, initialize) => Promise.resolve().then(initialize);
      export const onOperationMessage = (_port, _role, handle) => { fixture.handle = handle; };`],
    ['./metadata-store.js', 'export class MetadataStore { static async open() { return { getSettings: () => ({ preferences: {} }) }; } }'],
    ['./market-store.js', 'export class MarketStore { static async open() { return {}; } }'],
    ['./market-service.js', `${fixtureSource} export class MarketService { constructor() { return fixture.service; } }`],
  ])
  const workerURL = new URL('../electron/services/market-backend-worker.js', import.meta.url).href
  Reflect.set(globalThis, fixtureKey, fixture)
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const source = context.parentURL === `${workerURL}?desktop-contract-test` ? stubs.get(specifier) : undefined
      return source === undefined ? nextResolve(specifier, context)
        : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    },
  })
  try {
    await import(`${workerURL}?desktop-contract-test`)
    const request = async (input: unknown) => {
      assert.ok(fixture.handle)
      const result = await fixture.handle({ id: 1, method: 'request', value: parseDesktopRequest(input) })
      assert.equal(result.error, undefined)
      return result.value
    }
    const instId = 'BTC-USDT-SWAP', timeframe = '15m', endHour = 1_729_080_000_000
    assert.deepEqual(await request({ snapshot: {} }), snapshot)
    assert.deepEqual(await request({ snapshot: { sinceRevision: 3, serviceSession: 'collector-1' } }), snapshot)
    assert.deepEqual(await request({ chartUniverse: {} }), universe)
    assert.deepEqual(await request({ chartLocal: { instId, timeframe } }), frame)
    assert.deepEqual(await request({ chartHistory: { instId, timeframe, endHour } }), frame)
    assert.deepEqual(calls, [
      ['snapshot', {}], ['snapshot', { sinceRevision: 3, serviceSession: 'collector-1' }],
      ['residentFrames'], ['local', instId, timeframe], ['localHistory', instId, timeframe, endHour],
    ])
    calls.length = 0
    const target = { instId, timeframe, endHour }
    assert.deepEqual(await request({ chartFocus: { id: 'focus-1', target } }), { ok: true })
    assert.deepEqual(await request({ chartWindow: { ...target, historyBars: 512, focusId: 'focus-1' } }), frame)
    assert.deepEqual(await request({ chartFocus: { id: 'focus-2', target: null } }), { ok: true })
    assert.deepEqual(calls, [
      ['setFocus', target, 'focus-1'], ['prepare', instId, timeframe, endHour, 512, { focusId: 'focus-1' }],
      ['setFocus', null, 'focus-2'],
    ])
    assert.equal(fixture.service.barTasks.size, 0)
  } finally {
    hooks.deregister()
    Reflect.deleteProperty(globalThis, fixtureKey)
  }
})
