import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import dns, { lookup as namedLookup, Resolver } from 'node:dns'
import dnsPromises from 'node:dns/promises'
import dgram from 'node:dgram'
import http2, { connect as namedConnect } from 'node:http2'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'
import { installOperationHooks, getOperationHookCapabilities, getInstalledOperationHooks } from '../../electron/services/operation-hooks.js'
import { attachOperationSink, configureOperationContext, configureOperationPropagation, withOperationSuppressed } from '../../electron/services/operations.js'

process.env.PERPETUAL_SWAP_SANDBOX = '1'; process.env.PERPETUAL_SWAP_ALLOW_NETWORK = '0'
const propagation = new AsyncLocalStorage(), entries = []
if(!process.env.PERPETUAL_SWAP_OPERATION_DIR){
  configureOperationPropagation({ get: () => propagation.getStore(), run: (context, fn) => propagation.run(context, fn) })
  configureOperationContext({ sessionId: 'native-network-test', executionId: 'native-network-test' })
}
after(attachOperationSink(value => entries.push(value)))
installOperationHooks()
const capabilities = getOperationHookCapabilities()
const lookup = () => new Promise((resolve, reject) => namedLookup('localhost', (error, address) => error ? reject(error) : resolve(address)))
const closeUDP = socket => new Promise(resolve => socket.close(resolve))

test('DNS callbacks/promises and pre-imported resolver prototypes preserve results, cancellation, privacy and offline gates', async () => {
  const server = withOperationSuppressed(() => dgram.createSocket('udp4'))
  let queries = 0
  withOperationSuppressed(() => server.on('message', (query, remote) => {
    queries++
    if (query.includes(Buffer.from('cancel'))) return
    let offset = 12
    while (query[offset] !== 0) offset += query[offset] + 1
    offset += 5
    const header = Buffer.from(query.subarray(0, 12)); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 6)
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1])
    server.send(Buffer.concat([header, query.subarray(12, offset), answer]), remote.port, remote.address)
  }))
  await withOperationSuppressed(() => new Promise(resolve => server.bind(0, '127.0.0.1', resolve)))
  const servers = [`127.0.0.1:${server.address().port}`]
  try {
    entries.length = 0
    assert.equal(typeof await lookup(), 'string')
    assert.ok(Array.isArray(await dnsPromises.lookup('localhost', { all: true })))
    assert.equal(typeof (await promisify(dns.lookup)('localhost')).address, 'string', 'Native multi-result promisify metadata is preserved.')
    const resolver = new Resolver(); resolver.setServers(servers)
    const result = await new Promise((resolve, reject) => resolver.resolve4('private-identity.invalid', (error, value) => error ? reject(error) : resolve(value)))
    assert.deepEqual(result, ['127.0.0.1'])
    const promised = new dnsPromises.Resolver(); promised.setServers(servers)
    assert.deepEqual(await promised.resolve4('private-identity.invalid'), ['127.0.0.1'])
    const cancelled = promised.resolve4('cancel.invalid'); promised.cancel()
    await assert.rejects(cancelled, error => error.code === 'ECANCELLED')
    const before = queries
    assert.throws(() => dns.resolve4('private-outbound.invalid', () => {}), error => error.code === 'SANDBOX_NETWORK_BLOCKED')
    assert.throws(() => dns.lookup('private-outbound.invalid', () => {}), error => error.code === 'SANDBOX_NETWORK_BLOCKED')
    assert.equal(queries, before)
    for (const name of ['dns.lookup', 'dns.promises.lookup', 'dns.Resolver.resolve4', 'dns.promises.Resolver.resolve4']) assert.ok(entries.some(entry => entry.name === name && entry.status === 'ok'), name)
    assert.ok(entries.some(entry => entry.name === 'dns.promises.Resolver.resolve4' && entry.status === 'cancelled'))
    assert.equal(entries.filter(entry => entry.name === 'udp.send').length, 0, 'Resolver C-ARES work does not invent lower-level Node datagrams.')
    assert.doesNotMatch(JSON.stringify(entries), /private-identity|private-outbound|cancel\.invalid/)
  } finally { await withOperationSuppressed(() => closeUDP(server)) }
})

test('UDP send completion, connected overloads, native receive and callback nested DNS preserve one action each', async () => {
  const server = withOperationSuppressed(() => dgram.createSocket('udp4'))
  withOperationSuppressed(() => server.on('message', (message, remote) => server.send(message, remote.port, remote.address)))
  await withOperationSuppressed(() => new Promise(resolve => server.bind(0, '127.0.0.1', resolve)))
  entries.length = 0
  const client = dgram.createSocket('udp4')
  try {
    const first = once(client, 'message')
    await new Promise((resolve, reject) => client.send(Buffer.from('private-content'), server.address().port, '127.0.0.1', function (error, bytes) {
      if (error) { reject(error); return }
      assert.equal(bytes, 15)
      lookup().then(resolve, reject)
    }))
    assert.equal((await first)[0].toString(), 'private-content')
    await new Promise(resolve => client.connect(server.address().port, '127.0.0.1', resolve))
    const second = once(client, 'message')
    await new Promise((resolve, reject) => client.send(Buffer.from('abcdef'), 1, 3, error => error ? reject(error) : resolve()))
    assert.equal((await second)[0].toString(), 'bcd')
    const blocked = dgram.createSocket('udp4')
    assert.throws(() => blocked.send('blocked', 1234, 'private-outbound.invalid'), error => error.code === 'SANDBOX_NETWORK_BLOCKED')
    await closeUDP(blocked)
    const bad = dgram.createSocket('udp4')
    const nativeError = once(bad, 'error')
    bad.send('x', server.address().port, '::1')
    const [sendError] = await nativeError
    assert.equal(sendError instanceof Error, true, 'Send without a callback retains its native error event.')
    assert.ok(entries.some(entry => entry.name === 'udp.send' && entry.status === 'error'))
    await closeUDP(bad)
    assert.deepEqual(entries.filter(entry => entry.name === 'udp.send' && entry.status === 'ok').map(entry => entry.attributes.sentBytes), [15, 3])
    assert.deepEqual(entries.filter(entry => entry.name === 'udp.receive').map(entry => entry.attributes.receivedBytes), [15, 3])
    assert.equal(entries.filter(entry => entry.name === 'dns.lookup' && entry.status === 'ok').length, 1, 'Application callback DNS escapes transport suppression; native UDP lookup is not counted twice.')
    assert.doesNotMatch(JSON.stringify(entries), /private-content|private-outbound/)
  } finally { await closeUDP(client); await withOperationSuppressed(() => closeUDP(server)) }
})

test('HTTP2 preserves lazy bodies, exact write/end counts, callback context, receiver identity and no nested TCP/DNS duplicates', async () => {
  const server = withOperationSuppressed(() => http2.createServer())
  let release
  withOperationSuppressed(() => server.on('stream', stream => {
    stream.on('data', () => {})
    stream.on('end', () => { stream.respond({ ':status': 200 }); stream.write('{"answer":'); release = () => stream.end('42}') })
  }))
  await withOperationSuppressed(() => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)))
  entries.length = 0
  let nested
  const session = namedConnect(`http://127.0.0.1:${server.address().port}`, () => { nested = lookup() })
  try {
    await once(session, 'connect'); await nested
    assert.equal(session instanceof Object, true)
    const request = session.request({ ':method': 'POST', ':path': '/private-path?credential=never-log' })
    request.write('abc'); assert.equal(request.end('de'), request)
    await once(request, 'response')
    assert.equal(entries.filter(entry => entry.name === 'http2.request').length, 0, 'Receiving headers does not eagerly consume a body.')
    let text = ''; const reading = (async () => { for await (const chunk of request) text += chunk })()
    release(); await reading
    const observed = entries.find(entry => entry.name === 'http2.request')
    assert.ok(observed, JSON.stringify(entries))
    assert.equal(observed.status, 'ok'); assert.equal(observed.attributes.sentBytes, 5); assert.equal(observed.attributes.receivedBytes, 13)
    assert.equal(entries.filter(entry => entry.name === 'socket.connect').length, 0)
    assert.equal(entries.filter(entry => entry.name === 'dns.lookup' && entry.status === 'ok').length, 1)
    assert.throws(() => http2.connect('https://private-outbound.invalid'), error => error.code === 'SANDBOX_NETWORK_BLOCKED')
    let customInvoked = false
    assert.throws(() => http2.connect('http://127.0.0.1', { createConnection() { customInvoked = true } }), error => error.code === 'OPERATION_HOOK_UNSUPPORTED')
    assert.equal(customInvoked, false, 'A custom factory cannot bypass offline endpoint admission.')
    assert.throws(() => http2.connect('http://localhost', { lookup() { customInvoked = true } }), error => error.code === 'OPERATION_HOOK_UNSUPPORTED')
    assert.equal(customInvoked, false, 'A custom resolver cannot bypass offline endpoint admission.')
    assert.doesNotMatch(JSON.stringify(entries), /private-path|credential|never-log|private-outbound/)
  } finally {
    const closed = once(session, 'close'); session.close(); await closed
    await withOperationSuppressed(() => new Promise(resolve => server.close(resolve)))
  }
})

test('dynamic capability readback separates installed APIs from unsupported constructor/server scopes', () => {
  for(const api of ['dns.lookup','dns.promises.Resolver.resolve4','dgram.Socket.prototype.send','dgram.Socket.message','http2.connect']) {
    assert.equal(capabilities.find(entry=>entry.api===api)?.enabled,true,api)
    assert.equal(typeof capabilities.find(entry=>entry.api===api)?.scope,'string')
  }
  for(const api of ['dgram.Socket','dgram.Socket.prototype.bind','http2.createServer','http2.createSecureServer','http2.ServerHttp2Stream.prototype.pushStream']) {
    const entry=capabilities.find(entry=>entry.api===api)
    assert.equal(entry?.enabled,false,api);assert.equal(entry.reason,'application-source-boundary-rejects-uninstrumented-api')
  }
  assert.equal(capabilities.find(entry=>entry.api==='electron.net.fetch').enabled,false)
  const original=globalThis.fetch
  try {
    globalThis.fetch=async()=>{}
    assert.equal(getOperationHookCapabilities().find(entry=>entry.api==='globalThis.fetch').enabled,false)
    assert.equal(getInstalledOperationHooks().includes('fetch'),false)
  } finally {globalThis.fetch=original}
  assert.equal(getInstalledOperationHooks().includes('fetch'),true)
  const snapshot=getOperationHookCapabilities();snapshot.find(entry=>entry.api==='dns.lookup').enabled=false
  assert.equal(getOperationHookCapabilities().find(entry=>entry.api==='dns.lookup').enabled,true,'Public snapshots cannot mutate registry state.')
})


