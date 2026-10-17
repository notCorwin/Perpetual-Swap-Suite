import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { once } from 'node:events'

const root = fileURLToPath(new URL('../..', import.meta.url))
let userData, electron, page
const request = value => page.evaluate(value => window.radarDesktop.request(value), value)
const environment = (directory, testMode) => ({
  ...process.env,
  ELECTRON_RUN_AS_NODE: undefined,
  ELECTRON_RENDERER_URL: undefined,
  PERPETUAL_SWAP_E2E: testMode ? '1' : '0',
  PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0',
  PERPETUAL_SWAP_USER_DATA: directory,
})
const launch = directory => _electron.launch({
  args: ['.', '--headless', '--disable-gpu'], cwd: root, env: environment(directory, true),
})

before(async () => {
  userData = await mkdtemp(join(tmpdir(), 'perp-desktop-security-'))
  electron = await launch(userData)
  page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})
async function closeAndRemove(running, directory) {
  const child = running?.process()
  let timer
  let shutdownError
  try {
    if (running) await Promise.race([running.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Desktop shutdown timed out.')), 20_000)
    })])
  } catch (error) { shutdownError = error }
  finally {
    clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    if (directory) await rm(directory, { recursive: true, force: true })
  }
  if (shutdownError) throw shutdownError
}
after(() => closeAndRemove(electron, userData))

test('the real renderer exposes one bridge while Electron and Node capabilities remain isolated', async () => {
  const capabilities = await page.evaluate(() => ({
    bridge: typeof window.radarDesktop?.request,
    legacyBridge: typeof window.webkit?.messageHandlers?.radar,
    require: typeof window.require,
    process: typeof window.process,
    ipcRenderer: typeof window.ipcRenderer,
  }))
  assert.deepEqual(capabilities, { bridge: 'function', legacyBridge: 'undefined', require: 'undefined', process: 'undefined', ipcRenderer: 'undefined' })
  const preferences = await electron.evaluate(({ BrowserWindow }) => {
    const { contextIsolation, nodeIntegration, sandbox } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return { contextIsolation, nodeIntegration, sandbox }
  })
  assert.deepEqual(preferences, { contextIsolation: true, nodeIntegration: false, sandbox: true })
  assert.equal(typeof (await request({ preferences: { action: 'read' } })).rankingLookback, 'number')
})

test('mixed and malformed commands reject the entire mutation without partial side effects', async () => {
  const previous = await request({ preferences: { action: 'read' } })
  const analysis = await request({ analysisSettings: { action: 'read' } })
  const rankingLookback = previous.rankingLookback + 5
  const invalid = [
    null,
    [],
    {},
    { preferences: { action: 'update', values: { rankingLookback } }, analysisSettings: { action: 'save', model: 'invalid-operation', apiKey: 'must-not-be-saved' } },
    { preferences: { action: 'update', values: { rankingLookback, historyDays: 0 } } },
    { preferences: { action: 'update', values: { rankingLookback, chartTimeframe: '1m' } } },
    { preferences: { action: 'update', values: { rankingLookback, analysis: { apiKey: 'must-not-be-saved' } } } },
    { analysisSettings: { action: 'save', model: 42, apiKey: 'must-not-be-saved' } },
    { captureChart: { x: 0, y: 0, width: -1, height: 60, output: 'png' } },
    { copyText: null },
  ]
  for (const value of invalid) {
    await assert.rejects(() => request(value), /Invalid desktop bridge request/i)
    assert.deepEqual(await request({ preferences: { action: 'read' } }), previous, 'A rejected command must not partially change preferences.')
    assert.deepEqual(await request({ analysisSettings: { action: 'read' } }), analysis, 'A rejected command must not partially change credentials.')
  }
})

test('an untrusted renderer cannot use the real IPC channel even when supplied with the application preload', async () => {
  const previous = await request({ preferences: { action: 'read' } })
  const attempts = await electron.evaluate(async ({ BrowserWindow }, { preload, rendererURL, rankingLookback }) => {
    const attacker = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } })
    try {
      const results = []
      // An otherwise trusted URL must not authorize a different webContents.
      for (const url of ['data:text/html,<title>Untrusted renderer</title>', rendererURL]) {
        await attacker.loadURL(url)
        results.push(await attacker.webContents.executeJavaScript(`(async () => {
          const exposed = typeof window.radarDesktop?.request === 'function'
          if (!exposed) return { exposed }
          try {
            await window.radarDesktop.request({ preferences: { action: 'update', values: { rankingLookback: ${rankingLookback} } } })
            return { exposed, accepted: true }
          } catch (error) { return { exposed, accepted: false, error: error.message } }
        })()`))
      }
      return results
    } finally { attacker.destroy() }
  }, { preload: join(root, 'electron', 'preload.cjs'), rendererURL: page.url(), rankingLookback: previous.rankingLookback + 5 })
  assert.equal(attempts.length, 2)
  for (const attempt of attempts) {
    assert.equal(attempt.exposed, true, 'The attacker must reach the IPC bridge for this to exercise the host boundary.')
    assert.equal(attempt.accepted, false)
    assert.match(attempt.error, /restricted to the application main frame/i)
  }
  assert.deepEqual(await request({ preferences: { action: 'read' } }), previous)
})

test('public settings and market responses never contain the saved analysis credential', async () => {
  const apiKey = 'desktop-security-fixture-key'
  const model = 'desktop-security-fixture-model'
  const previous = await request({ preferences: { action: 'read' } })
  try {
    assert.deepEqual(await request({ analysisSettings: { action: 'save', model, apiKey } }), { model, hasAPIKey: true })
    const responses = [
      await request({ analysisSettings: { action: 'read' } }),
      await request({ preferences: { action: 'read' } }),
      await request({ preferences: { action: 'update', values: { chartTimeframe: previous.chartTimeframe } } }),
      await request({ snapshot: { timeframe: '15m', sinceRevision: -1 } }),
      await request({ dataAudit: { action: 'status' } }),
    ]
    for (const response of responses) {
      const serialized = JSON.stringify(response)
      assert.equal(serialized.includes(apiKey), false, 'The saved API key must stay in the main process.')
      assert.doesNotMatch(serialized, /"(?:apiKey|analysis)"\s*:/)
    }
    assert.deepEqual(responses[0], { model, hasAPIKey: true })
  } finally { await request({ analysisSettings: { action: 'removeKey' } }) }
})

test('navigating away cancels and drains the owning renderer Gateway stream', async () => {
  await request({ analysisSettings: { action: 'save', model: 'offline-fixture', apiKey: 'offline-fixture-key' } })
  await electron.evaluate(() => {
    const probe = globalThis.__gatewayLifecycle = { originalFetch: globalThis.fetch, requests: 0, aborted: 0 }
    globalThis.fetch = async (input, options) => {
      assertURL(input)
      probe.requests++
      const body = new ReadableStream({ start(controller) {
        options.signal.addEventListener('abort', () => {
          probe.aborted++
          controller.error(new Error('The fixture stream was cancelled.'))
        }, { once: true })
      } })
      return new Response(body, { status: 200 })
    }
    function assertURL(input) {
      if (String(input) !== 'https://ai-gateway.vercel.sh/v1/chat/completions') throw new Error('Unexpected fixture network request.')
    }
  })
  try {
    assert.equal((await request({ gatewayFetch: { id: 'lifecycle-fixture', body: '{}' } })).status, 200)
    await page.reload({ waitUntil: 'domcontentloaded' })
    assert.equal(await electron.evaluate(async () => {
      await new Promise(resolve => setImmediate(resolve))
      return globalThis.__gatewayLifecycle.aborted
    }), 1)
    // Reusing the ID proves the aborted stream released its main-process slot.
    assert.equal((await request({ gatewayFetch: { id: 'lifecycle-fixture', body: '{}' } })).status, 200)
    await request({ cancelGatewayFetch: 'lifecycle-fixture' })
    assert.deepEqual(await electron.evaluate(async () => {
      await new Promise(resolve => setImmediate(resolve))
      const { requests, aborted } = globalThis.__gatewayLifecycle
      return { requests, aborted }
    }), { requests: 2, aborted: 2 })
  } finally {
    await request({ cancelGatewayFetch: 'lifecycle-fixture' })
    await request({ analysisSettings: { action: 'removeKey' } })
    await electron.evaluate(() => {
      globalThis.fetch = globalThis.__gatewayLifecycle.originalFetch
      delete globalThis.__gatewayLifecycle
    })
  }
})

test('fixture operations are rejected by a separately launched production-mode app', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-production-security-'))
  let production
  t.after(() => closeAndRemove(production, directory))
  production = await _electron.launch({
    args: ['.', '--headless', '--disable-gpu'], cwd: root, env: environment(directory, false),
  })
  const productionPage = await production.firstWindow()
  await productionPage.waitForLoadState('domcontentloaded')
  const productionRequest = value => productionPage.evaluate(value => window.radarDesktop.request(value), value)
  const previous = await productionRequest({ preferences: { action: 'read' } })
  for (const action of ['settings', 'smokeStatus', 'seedCachedListProjection']) {
    await assert.rejects(() => productionRequest({ e2e: { action } }), /unavailable outside tests/i)
  }
  assert.deepEqual(await productionRequest({ preferences: { action: 'read' } }), previous)
})
