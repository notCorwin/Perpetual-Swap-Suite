import assert from 'node:assert/strict'
import { app, net, session } from 'electron'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { stat } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { installOperationHooks, installElectronOperationHooks, getOperationHookCapabilities, getInstalledOperationHooks, isOperationHookSuppressed, withOperationHookSuppressed } from '../../electron/services/operation-hooks.js'
import { attachOperationSink, configureOperationContext, configureOperationPropagation, getOperationContext, runWithOperationContext, withOperationSuppressed } from '../../electron/services/operations.js'
import { initializeOperationRecording, closeOperationRecording } from '../../electron/services/operation-runtime.js'
import { createNativeExchange } from './native-exchange.mjs'
import { ownFixtureServer } from './fixture-server.mjs'

if (process.platform === 'darwin') app.setActivationPolicy('accessory')
const userData = process.env.PERPETUAL_SWAP_NATIVE_NETWORK_USER_DATA
assert.ok(userData, 'The parent must own the fixture profile through child shutdown.')
app.setPath('userData', userData)
process.env.PERPETUAL_SWAP_SANDBOX = '1'; process.env.PERPETUAL_SWAP_ALLOW_NETWORK = '0'
const scopes = new AsyncLocalStorage(), events = []
const recording=initializeOperationRecording({label:'electron-network-fixture'})
if(!recording){
  configureOperationPropagation({ get: () => scopes.getStore(), run: (context, fn) => scopes.run(context, fn) })
  configureOperationContext({ sessionId: 'electron-native-fixture', executionId: 'electron-native-fixture' })
}
attachOperationSink(value => events.push(value))
installOperationHooks()
const preReady = installElectronOperationHooks({ app, net, session })
let server, ownedServer, exchange, result, failed = false
const phases = []
function phase(name) { phases.push(name); console.error(`[native-network-fixture] ${name}`) }
async function proof() {
try {
  phase('app-ready')
  assert.equal(preReady.find(value=>value.api==='electron.net.fetch').enabled,false)
  await app.whenReady()
  const originalSocket = net.WebSocket
  const capabilities = installElectronOperationHooks({ app, net, session })
  assert.deepEqual(installElectronOperationHooks({ app, net, session }), capabilities)
  for (const api of ['electron.net.fetch','electron.net.request','electron.net.resolveHost','electron.session.fetch','electron.session.resolveHost'])assert.equal(capabilities.find(value=>value.api===api)?.enabled,true,api)
  assert.equal(preReady.find(value=>value.api==='electron.net.fetch').enabled,false)
  assert.equal(getInstalledOperationHooks().includes('electron.net'),true)
  assert.equal(getOperationHookCapabilities().find(value=>value.api==='electron.net.fetch').enabled,true)
  let release
  server = withOperationSuppressed(() => createServer((request, response) => {
    if (request.url === '/held') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"answer":'); release = () => response.end('42}'); return }
    if (request.url === '/redirect') { response.writeHead(302, { Location: 'https://private-no-outbound.invalid/secret' }).end(); return }
    let text = ''; request.on('data', chunk => text += chunk)
    request.on('end', () => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ size: Buffer.byteLength(text) })))
  }))
  ownedServer = ownFixtureServer(server)
  await withOperationSuppressed(() => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  // Keep one accepted socket with no request. Chromium's connection pool can
  // produce this state; teardown must own it rather than wait for its timeout.
  await withOperationSuppressed(async () => {
    const accepted = once(server, 'connection'), socket = createConnection(server.address().port, '127.0.0.1')
    socket.on('error', () => {})
    await Promise.all([once(socket, 'connect'), accepted])
  })
  events.length = 0
  phase('http-fetch-body')
  const response = await net.fetch(origin + '/held')
  assert.equal(response.bodyUsed, false)
  assert.equal(events.some(value => value.name === 'electron.net.fetch'), false)
  release(); assert.deepEqual(await response.json(), { answer: 42 })
  assert.equal(events.find(value => value.name === 'electron.net.fetch').attributes.receivedBytes, 13)
  const controller = new AbortController()
  phase('http-fetch-abort')
  const aborted = await net.fetch(origin + '/held', { signal: controller.signal })
  controller.abort()
  await assert.rejects(aborted.text())
  release()
  assert.ok(events.some(value => value.name === 'electron.net.fetch' && value.status === 'cancelled'))
  phase('session-fetch-and-resolve')
  const isolated = session.fromPartition(`native-proof-${Date.now()}`)
  assert.deepEqual(await (await isolated.fetch(origin + '/session')).json(), { size: 0 })
  await net.resolveHost('localhost'); await isolated.resolveHost('localhost')
  phase('http-request-post')
  await new Promise((resolve, reject) => {
    const request = net.request({ url: origin + '/private-path?credential=secret', method: 'POST' })
    request.on('response', response => {
      let text = ''; response.on('data', chunk => text += chunk)
      response.on('end', () => {
        try { assert.deepEqual(JSON.parse(text), { size: 5 }) } catch (error) { reject(error); return }
        net.resolveHost('localhost').then(resolve, reject)
      })
    })
    request.on('error', reject)
    request.write('abc'); request.end('de')
  })
  const beforeHeldRequest = events.filter(value => value.name === 'electron.net.request').length
  phase('http-request-held-body')
  const heldRequest = net.request(origin + '/held')
  const incoming = new Promise((resolve, reject) => { heldRequest.once('response', resolve); heldRequest.once('error', reject) })
  heldRequest.end()
  const heldBody = await incoming
  assert.equal(heldBody.readableFlowing, null)
  assert.equal(events.filter(value => value.name === 'electron.net.request').length, beforeHeldRequest)
  const consumed = once(heldBody, 'end'); heldBody.resume(); release(); await consumed
  assert.ok(events.some(value => value.name === 'electron.net.request' && value.status === 'ok' && value.attributes.receivedBytes === 13))
  const request = events.find(value => value.name === 'electron.net.request' && value.status === 'ok' && value.attributes.sentBytes === 5)
  assert.equal(request.attributes.sentBytes, 5); assert.equal(request.attributes.receivedBytes, 10)
  phase('network-gates')
  await assert.rejects(net.fetch('https://private-no-outbound.invalid/secret'), error => error.code === 'SANDBOX_NETWORK_BLOCKED')
  await assert.rejects(net.fetch(origin + '/redirect'))
  assert.throws(() => net.request('https://private-no-outbound.invalid/secret'), error => error.code === 'SANDBOX_NETWORK_BLOCKED')
  assert.equal(events.filter(value => value.name === 'electron.net.fetch' && value.status === 'ok').length, 1, 'net.fetch forwarding to session.fetch does not double count.')
  assert.equal(events.filter(value => value.name === 'electron.session.fetch' && value.status === 'ok').length, 1)
  assert.equal(events.filter(value => value.name === 'electron.net.resolveHost' && value.status === 'ok').length, 2, 'Nested app callback resolution is retained.')
  assert.equal(events.filter(value => value.name === 'electron.session.resolveHost' && value.status === 'ok').length, 1)
  assert.equal(events.filter(value => value.name === 'node.http.request' || value.name === 'socket.connect' || value.name === 'fetch.request').length, 0)
  if (capabilities.find(value => value.api === 'electron.net.WebSocket')?.enabled) {
    phase('websocket')
    exchange = await withOperationSuppressed(() => createNativeExchange())
    const connectionContext = { traceId: 'electron-socket-trace', parentId: 'electron-socket-parent', scenarioId: 'electron-socket-scenario' }
    const applicationContext = { traceId: 'electron-callback-trace', parentId: 'electron-callback-parent', scenarioId: 'electron-callback-scenario' }
    const socket = runWithOperationContext(connectionContext, () => new net.WebSocket(exchange.environment.PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN + '/ws/v5/public'))
    assert.ok(socket instanceof originalSocket)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    const beforeCallbackDNS = events.filter(value => value.name === 'electron.net.resolveHost').length
    const messages = runWithOperationContext(applicationContext, () => withOperationHookSuppressed('io', () => new Promise((resolve, reject) => {
      const message = function (event) {
        try {
          if (!JSON.parse(event.data).data) return
          socket.removeEventListener('message', message)
          assert.equal(this, socket)
          assert.deepEqual(getOperationContext(), applicationContext)
          assert.equal(isOperationHookSuppressed('network'), false)
          assert.equal(isOperationHookSuppressed('io'), true)
          net.resolveHost('localhost').then(resolve, reject)
        } catch (error) { reject(error) }
      }
      socket.addEventListener('message', message)
    })))
    socket.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'tickers', instId: 'BTC-USDT-SWAP' }] }))
    await messages
    const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true })); socket.close(); await closed
    const received = events.filter(value => value.name === 'websocket.receive' && value.attributes.stream === 'electron-native' && value.attributes.source === 'native')
    assert.ok(received.length > 0)
    for (const value of received) for (const key of ['traceId', 'parentId', 'scenarioId']) assert.equal(value[key], connectionContext[key])
    assert.equal(events.filter(value => value.name === 'electron.net.resolveHost').length, beforeCallbackDNS + 1, 'WebSocket application callbacks retain nested native network operations.')
    const resolved = events.filter(value => value.name === 'electron.net.resolveHost').at(-1)
    for (const key of ['traceId', 'parentId', 'scenarioId']) assert.equal(resolved[key], applicationContext[key])
  }
  assert.doesNotMatch(JSON.stringify(events), /private-path|credential|private-no-outbound|secret/)
  phase('assertions-passed')
  result = {passed:true,visibleWindows:0,names:[...new Set(events.map(value=>value.name))],capabilities:capabilities.filter(value=>value.api.startsWith('electron'))}
} catch (error) {
  console.error(error.stack ?? error); failed = true
} finally {
  const cleanup = async (name, action) => {
    phase(name)
    try { await withOperationSuppressed(action) } catch (error) { console.error(error.stack ?? error); failed = true }
  }
  await cleanup('cleanup-exchange', () => exchange?.close())
  const connectionsBeforeClose = ownedServer?.connections ?? 0
  await cleanup('cleanup-http', () => ownedServer?.close())
  phase('cleanup-recorder')
  await closeOperationRecording().catch(error => { console.error(error.stack); failed = true })
  let profilePresentBeforeQuit = false
  await cleanup('profile-retained-before-quit', async () => {
    profilePresentBeforeQuit = (await stat(userData)).isDirectory()
    assert.equal(profilePresentBeforeQuit, true)
  })
  if (failed) app.exit(1)
  else {
    phase('complete')
    console.log(JSON.stringify({...result,cleanupComplete:true,profilePresentBeforeQuit,connectionsBeforeClose,phases}))
    app.quit()
  }
}
}
void proof()
