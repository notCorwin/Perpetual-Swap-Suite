import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDesktopSecurity, isAllowedExternalURL } from '../electron/desktop-security.js'
import { DesktopRequestError, parseDesktopRequest } from '../electron/desktop-contract.js'

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
  assert.deepEqual(parseDesktopRequest({ snapshot: { timeframe: '15m', sinceRevision: -1 } }), { snapshot: { timeframe: '15m', sinceRevision: -1 } })
  assert.throws(() => parseDesktopRequest({ preferences: { action: 'update', values: { rankingLookback: 30 } }, copyText: 'side effect' }), /exactly one operation/)
  assert.throws(() => parseDesktopRequest({ e2e: { action: 'settings' } }), /unavailable outside tests/)
})

test('window controls accept only fixed actions without caller-selected window targets', () => {
  for (const action of ['close', 'minimize', 'toggleMaximize']) {
    const request = { windowControl: { action } }
    const parsed = parseDesktopRequest(request)
    assert.deepEqual(parsed, request)
    assert.ok('windowControl' in parsed)
    assert.notEqual(parsed, request)
    assert.notEqual(parsed.windowControl, request.windowControl)
  }
  for (const windowControl of [
    null, [], 'close', {},
    { action: undefined }, { action: null }, { action: true },
    { action: 'maximize' }, { action: 'unmaximize' }, { action: 'titlebarDoubleClick' },
    { action: 'close', windowId: 1 }, { action: 'close', target: 'focused' },
    Object.create({ action: 'close' }),
  ]) assert.throws(() => parseDesktopRequest({ windowControl }), DesktopRequestError)
  assert.throws(() => parseDesktopRequest({ windowControl: { action: 'close' }, copyText: 'mixed' }), DesktopRequestError)

  let reads = 0
  const windowControl = Object.defineProperty({}, 'action', {
    enumerable: true, get() { reads++; return 'close' },
  })
  assert.throws(() => parseDesktopRequest({ windowControl }), DesktopRequestError)
  assert.equal(reads, 0)
})
