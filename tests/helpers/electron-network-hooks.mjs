import assert from 'node:assert/strict'
import { app, net, session } from 'electron'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { installOperationHooks, installElectronOperationHooks, getOperationHookCapabilities, getInstalledOperationHooks } from '../../electron/services/operation-hooks.js'
import { attachOperationSink, configureOperationContext, configureOperationPropagation, withOperationSuppressed } from '../../electron/services/operations.js'
import { initializeOperationRecording, closeOperationRecording } from '../../electron/services/operation-runtime.js'
import { createNativeExchange } from './native-exchange.mjs'

if (process.platform === 'darwin') app.setActivationPolicy('accessory')
const userData = await mkdtemp(join(tmpdir(), 'perp-electron-net-proof-'))
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
let server, exchange
async function proof() {
try {
  assert.equal(preReady.find(value=>value.api==='electron.net.fetch').enabled,false)
  await app.whenReady()
  const deadline = setTimeout(() => { console.error('proof: timeout'); app.exit(1) }, 15_000); deadline.unref()
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
  await withOperationSuppressed(() => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  events.length = 0
  const response = await net.fetch(origin + '/held')
  assert.equal(response.bodyUsed, false)
  assert.equal(events.some(value => value.name === 'electron.net.fetch'), false)
  release(); assert.deepEqual(await response.json(), { answer: 42 })
  assert.equal(events.find(value => value.name === 'electron.net.fetch').attributes.receivedBytes, 13)
  const controller = new AbortController()
  const aborted = await net.fetch(origin + '/held', { signal: controller.signal })
  controller.abort()
  await assert.rejects(aborted.text())
  release()
  assert.ok(events.some(value => value.name === 'electron.net.fetch' && value.status === 'cancelled'))
  const isolated = session.fromPartition(`native-proof-${Date.now()}`)
  assert.deepEqual(await (await isolated.fetch(origin + '/session')).json(), { size: 0 })
  await net.resolveHost('localhost'); await isolated.resolveHost('localhost')
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
  await assert.rejects(net.fetch('https://private-no-outbound.invalid/secret'), error => error.code === 'SANDBOX_NETWORK_BLOCKED')
  await assert.rejects(net.fetch(origin + '/redirect'))
  assert.throws(() => net.request('https://private-no-outbound.invalid/secret'), error => error.code === 'SANDBOX_NETWORK_BLOCKED')
  assert.equal(events.filter(value => value.name === 'electron.net.fetch' && value.status === 'ok').length, 1, 'net.fetch forwarding to session.fetch does not double count.')
  assert.equal(events.filter(value => value.name === 'electron.session.fetch' && value.status === 'ok').length, 1)
  assert.equal(events.filter(value => value.name === 'electron.net.resolveHost' && value.status === 'ok').length, 2, 'Nested app callback resolution is retained.')
  assert.equal(events.filter(value => value.name === 'electron.session.resolveHost' && value.status === 'ok').length, 1)
  assert.equal(events.filter(value => value.name === 'node.http.request' || value.name === 'socket.connect' || value.name === 'fetch.request').length, 0)
  if (capabilities.find(value => value.api === 'electron.net.WebSocket')?.enabled) {
    exchange = await withOperationSuppressed(() => createNativeExchange())
    const socket = new net.WebSocket(exchange.environment.PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN + '/ws/v5/public')
    assert.ok(socket instanceof originalSocket)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    const messages = new Promise(resolve => socket.addEventListener('message', event => { if (JSON.parse(event.data).data) resolve() }))
    socket.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'tickers', instId: 'BTC-USDT-SWAP' }] }))
    await messages
    const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true })); socket.close(); await closed
    assert.ok(events.some(value => value.name === 'websocket.receive' && value.attributes.stream === 'electron-native' && value.attributes.source === 'native'))
  }
  assert.doesNotMatch(JSON.stringify(events), /private-path|credential|private-no-outbound|secret/)
  console.log(JSON.stringify({passed:true,visibleWindows:0,names:[...new Set(events.map(value=>value.name))],capabilities:capabilities.filter(value=>value.api.startsWith('electron'))}))
} catch (error) {
  console.error(error.stack ?? error); globalThis.proofFailed = true
} finally {
  await withOperationSuppressed(() => exchange?.close())
  if (server) await withOperationSuppressed(() => new Promise(resolve => server.close(resolve)))
  await withOperationSuppressed(() => rm(userData, { recursive: true, force: true }))
  await closeOperationRecording().catch(error=>{console.error(error.stack);globalThis.proofFailed=true})
  if (globalThis.proofFailed) app.exit(1); else app.quit()
}
}
void proof()
