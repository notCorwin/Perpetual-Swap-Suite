import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import dgram from 'node:dgram'
import http2 from 'node:http2'
import { errorMonitor } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { beginOperation } from './operations.js'
import { assertSandboxURL } from './sandbox-network.js'
import { constructRecordedWebSocket } from './network-operations.js'

const capabilities = new Map(), probes = new Map(), sockets = new WeakMap(), marker = Symbol('native-resource-hook')
const electronSocketConstructors = new WeakSet()
let integration, nextSocket = 0
const failure = error => ({ status: error?.name === 'AbortError' || error?.code === 'ECANCELLED' ? 'cancelled' : 'error', attributes: { errorName: error?.name ?? 'Error' } })
const scope = () => integration.captureScope()
const resume = (context, fn) => integration.resumeScope(context, fn)
const suppress = fn => integration.withNetwork(fn)
const suppressed = () => integration.suppressed()
const size = (value, encoding) => {
  if (typeof value === 'string') { try { return Buffer.byteLength(value, typeof encoding === 'string' ? encoding : 'utf8') } catch { return null } }
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer ? value.byteLength : Array.isArray(value) ? value.reduce((sum, part) => sum + (size(part) ?? 0), 0) : null
}
const spec = (name, transport, attributes = {}) => ({ category: 'network', name, resource: transport,
  attributes: { source: 'native', transport, ...attributes } })
const offline = () => process.env.PERPETUAL_SWAP_SANDBOX === '1' && process.env.PERPETUAL_SWAP_ALLOW_NETWORK !== '1'
const endpoint = (host, protocol = 'udp:') => `${protocol}//${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}/`
function gateHost(host, protocol) { assertSandboxURL(endpoint(String(host), protocol)) }
function preserve(original, replacement) {
  for (const key of Reflect.ownKeys(original)) if (!['arguments', 'caller', 'prototype'].includes(key)) {
    try { Object.defineProperty(replacement, key, Object.getOwnPropertyDescriptor(original, key)) } catch {}
  }
  Object.defineProperty(replacement, marker, { value: true }); return replacement
}
function capabilityScope(api) {
  if(api.startsWith('dns.'))return /lookup(?:Service)?$/.test(api)?'os-resolver-api-wall':'configured-resolver-api-wall'
  if(api==='dgram.Socket.message')return 'factory-created-socket-message-delivery'
  if(api==='dgram.createSocket')return 'factory-created-datagram-lifecycle'
  if(api.startsWith('dgram.')||api.startsWith('udp.'))return 'datagram-api-completion'
  if(['http2.createServer','http2.createSecureServer','http2.ServerHttp2Stream.prototype.pushStream'].includes(api))return 'application-source-boundary-unsupported-api'
  if(api.startsWith('http2.'))return 'factory-created-client-session-and-consumed-stream'
  if(api==='electron.net.WebSocket')return 'electron-main-native-websocket-connect-send-receive'
  return 'electron-main-after-ready-http-and-resolver'
}
function patch(owner, key, name, build) {
  const original = owner?.[key]
  if (original?.[marker]) return true
  if (typeof original !== 'function') { capabilities.set(name, { name, enabled: false, reason: 'runtime-api-unavailable' }); return false }
  const wrapped = preserve(original, build(original))
  try {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    Object.defineProperty(owner, key, { configurable: descriptor?.configurable ?? true, enumerable: descriptor?.enumerable ?? true, writable: descriptor?.writable ?? true, value: wrapped })
    if (owner[key] !== wrapped) throw Error('Hook readback failed')
    capabilities.set(name, { name, enabled: true }); probes.set(name, () => owner[key] === wrapped); return true
  } catch {
    capabilities.set(name, { name, enabled: false, reason: 'native-property-not-writable' }); return false
  }
}
function dnsGate(owner, method, args) {
  if (!offline()) return
  if (['lookup', 'lookupService'].includes(method)) { gateHost(args[0], 'dns:'); return }
  for (const server of owner.getServers()) {
    const host = server.startsWith('[') ? server.slice(1, server.indexOf(']')) : /^[\d.]+:\d+$/.test(server) ? server.split(':')[0] : server
    gateHost(host, 'dns:')
  }
}
function dnsMethod(owner, method, name, promise) {
  return patch(owner, method, name, original => function (...args) {
    if (suppressed()) return Reflect.apply(original, this, args)
    const operation = beginOperation(spec(name, 'dns', { method, measurement: ['lookup', 'lookupService'].includes(method) ? 'os-resolver-wall' : 'dns-resolver-wall' }))
    const context = scope(), target = this && typeof this.getServers === 'function' ? this : owner
    const count = value => ({ count: Array.isArray(value) ? value.length : value ? 1 : 0 })
    if (!promise && typeof args.at(-1) === 'function') {
      const callback = args.at(-1)
      args[args.length - 1] = function (...values) {
        operation.end(values[0] ? failure(values[0]) : { attributes: count(values[1]) })
        return resume(context, () => Reflect.apply(callback, this, values))
      }
    }
    try {
      dnsGate(target, method, args)
      const result = operation.run(() => suppress(() => Reflect.apply(original, this, args)))
      if (!promise) return result
      return Promise.resolve(result).then(value => { operation.end({ attributes: count(value) }); return value }, error => { operation.end(failure(error)); throw error })
    } catch (error) { operation.end(failure(error)); if (promise) return Promise.reject(error); throw error }
  })
}
function installDNS() {
  const methods = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse']
  for (const [owner, prefix, promise] of [[dns, 'dns', false], [dnsPromises, 'dns.promises', true]]) {
    for (const method of ['lookup', 'lookupService', ...methods]) dnsMethod(owner, method, `${prefix}.${method}`, promise)
    for (const method of methods) dnsMethod(owner.Resolver?.prototype, method, `${prefix}.Resolver.${method}`, promise)
  }
}
function datagramDestination(socket, args) {
  try { return socket.remoteAddress().address } catch {}
  const values = typeof args.at(-1) === 'function' ? args.slice(0, -1) : args
  return typeof values[1] === 'number' && typeof values[2] === 'number' ? values[4] ?? '127.0.0.1' : values[2] ?? '127.0.0.1'
}
function installUDP() {
  patch(dgram, 'createSocket', 'dgram.createSocket', original => function (...args) {
    if (suppressed()) return Reflect.apply(original, this, args)
    const context = scope()
    if (typeof args.at(-1) === 'function') {
      const callback = args.at(-1)
      args[args.length - 1] = function (...values) { return resume(context, () => Reflect.apply(callback, this, values)) }
    }
    const socket = Reflect.apply(original, this, args)
    const connection = ++nextSocket, lifetime = beginOperation(spec('udp.lifetime', 'udp', { connection, measurement: 'resource-lifetime' }))
    const state = { context, connection, lifetime, error: false }
    sockets.set(socket, state)
    integration.restoreEmitterContexts(socket)
    socket.once('close', () => lifetime.end({ status: state.error ? 'error' : 'ok' }))
    socket.on(errorMonitor, error => { state.error = true; beginOperation(spec('udp.error', 'udp', { connection })).end(failure(error)) })
    return socket
  })
  patch(dgram.Socket.prototype, 'send', 'dgram.Socket.prototype.send', original => function (...args) {
    if (suppressed()) return Reflect.apply(original, this, args)
    const context = scope(), metadata = sockets.get(this)
    const operation = beginOperation(spec('udp.send', 'udp', { connection: metadata?.connection ?? 0, measurement: 'datagram-completion' }))
    const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined, socket = this
    try {
      gateHost(datagramDestination(this, args), 'udp:')
      args.push(function (error, bytes) {
        operation.end(error ? failure(error) : { attributes: { sentBytes: bytes } })
        return resume(context, () => callback ? Reflect.apply(callback, this, [error, bytes]) : error ? socket.emit('error', error) : undefined)
      })
      return operation.run(() => suppress(() => Reflect.apply(original, this, args)))
    } catch (error) { operation.end(failure(error)); throw error }
  })
  patch(dgram.Socket.prototype, 'connect', 'dgram.Socket.prototype.connect', original => function (...args) {
    if (suppressed()) return Reflect.apply(original, this, args)
    const context=scope(),operation=beginOperation(spec('udp.connect','udp',{measurement:'endpoint-admission'})),socket=this
    const callback=typeof args.at(-1)==='function'?args.pop():undefined
    let settled=false
    const finish=result=>{if(settled)return;settled=true;socket.removeListener(errorMonitor,onError);socket.removeListener('close',onClose);operation.end(result)}
    const onError=error=>finish(failure(error)),onClose=()=>finish({status:'cancelled'})
    try {
      gateHost(args[1]??'127.0.0.1','udp:')
      args.push(function(...values){finish();return resume(context,()=>callback&&Reflect.apply(callback,this,values))})
      socket.once(errorMonitor,onError);socket.once('close',onClose)
      return operation.run(()=>suppress(()=>Reflect.apply(original,this,args)))
    } catch(error){finish(failure(error));throw error}
  })
  patch(dgram.Socket.prototype, 'emit', 'dgram.Socket.message', original => function (type, ...args) {
    const metadata = sockets.get(this)
    if (!metadata) return Reflect.apply(original, this, [type, ...args])
    return resume(metadata.context, () => {
      if (type === 'message' && !suppressed()) {
        const operation = beginOperation(spec('udp.receive', 'udp', { connection: metadata.connection, receivedBytes: size(args[0]), measurement: 'datagram-delivery' }))
        try { return operation.run(() => Reflect.apply(original, this, [type, ...args])) } finally { operation.end() }
      }
      return Reflect.apply(original, this, [type, ...args])
    })
  })
  for(const api of ['dgram.Socket','dgram.Socket.prototype.bind','dgram.Socket.prototype.addMembership','dgram.Socket.prototype.dropMembership','dgram.Socket.prototype.addSourceSpecificMembership','dgram.Socket.prototype.dropSourceSpecificMembership','dgram.Socket.prototype.setMulticastInterface'])capabilities.set(api,{name:api,enabled:false,reason:'application-source-boundary-rejects-uninstrumented-api'})
  capabilities.set('udp.preexistingSocket.receive', {name:'udp.preexistingSocket.receive',enabled:false,reason:'install-before-socket-factory-use'})
}
function observeHTTP2Stream(stream, operation) {
  integration.restoreEmitterContexts(stream)
  const attributes = { sentBytes: 0, receivedBytes: 0 }, push = stream.push
  let ended = false, readableEnded = false, writableEnded = stream.writableFinished, depth = 0
  const finish = result => { if (!ended) { ended = true; operation.end({ ...result, attributes: { ...attributes, ...result?.attributes } }) } }
  const complete = () => { if (readableEnded && writableEnded) finish({ status: attributes.httpStatus >= 400 ? 'error' : 'ok' }) }
  stream.push = function (chunk, ...args) { if (chunk !== null) attributes.receivedBytes += size(chunk, args[0]) ?? 0; return Reflect.apply(push, this, [chunk, ...args]) }
  stream.once('response', headers => { attributes.httpStatus = headers[':status'] })
  stream.once('end', () => { readableEnded = true; complete() })
  stream.once('finish', () => { writableEnded = true; complete() })
  stream.once(errorMonitor, error => finish(failure(error)))
  stream.once('aborted', () => finish({ status: 'cancelled' }))
  stream.once('close', () => { if (!ended) finish({ status: stream.rstCode ? 'error' : 'cancelled', attributes: { code: stream.rstCode } }) })
  for (const key of ['write', 'end']) {
    const original = stream[key]
    stream[key] = function (...args) {
      if (!depth) attributes.sentBytes += size(args[0], args[1]) ?? 0
      const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined, context = scope()
      if (callback) args.push(function (...values) { return resume(context, () => Reflect.apply(callback, this, values)) })
      depth++
      try { return suppress(() => Reflect.apply(original, this, args)) } catch (error) { finish(failure(error)); throw error } finally { depth-- }
    }
  }
  return stream
}
function installHTTP2() {
  patch(http2, 'connect', 'http2.connect', original => function (...args) {
    if (suppressed()) return Reflect.apply(original, this, args)
    const connect = beginOperation(spec('http2.connect', 'http2', { measurement: 'connection-wall' })), context = scope()
    if (typeof args.at(-1) === 'function') {
      const callback = args.at(-1); args[args.length - 1] = function (...values) { return resume(context, () => Reflect.apply(callback, this, values)) }
    }
    try {
      assertSandboxURL(args[0])
      if (offline() && ['createConnection', 'lookup'].some(key => typeof args[1]?.[key] === 'function')) throw Object.assign(new Error('Offline HTTP/2 custom transport callbacks are unsupported.'), { code: 'OPERATION_HOOK_UNSUPPORTED' })
      const session = connect.run(() => suppress(() => Reflect.apply(original, this, args)))
      integration.restoreEmitterContexts(session)
      const lifetime = beginOperation(spec('http2.lifetime', 'http2', { measurement: 'resource-lifetime' }))
      session.once('connect', () => connect.end())
      session.once(errorMonitor, error => { connect.end(failure(error)); lifetime.end(failure(error)) })
      session.once('close', () => { connect.end({ status: 'cancelled' }); lifetime.end() })
      const request = session.request
      const wrapped = function (...values) {
        if(suppressed())return Reflect.apply(request,this,values)
        const operation = beginOperation(spec('http2.request', 'http2', { method: ['GET', 'POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'CONNECT', 'PATCH'].includes(values[0]?.[':method']) ? values[0][':method'] : 'GET', measurement: 'http-body-wall' }))
        try { return observeHTTP2Stream(operation.run(() => suppress(() => Reflect.apply(request, this, values))), operation) }
        catch (error) { operation.end(failure(error)); throw error }
      }
      session.request = wrapped
      if (session.request !== wrapped) { session.destroy(); throw new Error('HTTP/2 request instrumentation is unsupported.') }
      return session
    } catch (error) { connect.end(failure(error)); throw error }
  })
  capabilities.set('http2.ClientHttp2Session.request',{name:'http2.ClientHttp2Session.request',enabled:true})
  capabilities.set('http2.custom-transport-offline', { name: 'http2.custom-transport-offline', enabled: false, reason: 'offline-custom-factory-or-resolver-rejected-before-invocation' })
  for(const api of ['http2.createServer','http2.createSecureServer','http2.ServerHttp2Stream.prototype.pushStream'])capabilities.set(api,{name:api,enabled:false,reason:'application-source-boundary-rejects-uninstrumented-api'})
  capabilities.set('http2.preexistingSession.request',{name:'http2.preexistingSession.request',enabled:false,reason:'install-before-session-factory-use'})
}
export function installNativeNetworkHooks(helpers) {
  integration ??= helpers
  installDNS(); installUDP(); installHTTP2(); syncBuiltinESMExports()
  return [...capabilities.values()]
}
export function getNativeNetworkHookCapabilities() {
  return [...capabilities.values()].map(({name,...entry})=>{
    let enabled=entry.enabled,reason=entry.reason
    try {if(enabled&&probes.has(name)&&!probes.get(name)()){enabled=false;reason='hook-replaced-after-installation'}}catch {enabled=false;reason='hook-readback-failed'}
    return {api:name,enabled,...(reason?{reason}:{}),scope:capabilityScope(name)}
  }).sort((a,b)=>a.api.localeCompare(b.api))
}
const electronAPIs=['electron.net.fetch','electron.net.request','electron.net.resolveHost','electron.session.fetch','electron.session.resolveHost','electron.net.WebSocket']
for(const name of electronAPIs)capabilities.set(name,{name,enabled:false,reason:process.versions.electron?'requires-electron-ready-initializer':'electron-api-unavailable-in-node'})

function requestURL(value) {
  if (typeof value === 'string' || value instanceof URL) return new URL(value)
  if (value.url) return new URL(value.url)
  return new URL(value.path ?? '/', `${value.protocol ?? 'http:'}//${value.hostname ?? value.host ?? 'localhost'}${value.port ? `:${value.port}` : ''}`)
}
function installElectronFetch(owner, key, name) {
  patch(owner, key, name, original => async function (input, options) {
    if (suppressed()) return Reflect.apply(original, this, arguments)
    const operation = beginOperation(spec(name, 'electron-http', { measurement: 'http-body-wall' }))
    const signal = options?.signal ?? input?.signal
    const state = { span: operation, signal, ended: false, attributes: {}, methods: 0, bytes: new WeakMap() }
    state.finish = result => {
      if (state.ended) return
      state.ended = true; signal?.removeEventListener('abort', abort)
      operation.end({ ...result, ...(result?.status === 'ok' && state.successStatus === 'error' ? { status: 'error' } : {}), attributes: { ...state.attributes, ...result?.attributes } })
    }
    const abort = () => state.finish({ status: 'cancelled' })
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('Native fetch coverage supports HTTP(S) only.'), { code: 'OPERATION_HOOK_UNSUPPORTED' })
      assertSandboxURL(url)
      const args = [input, offline() ? { ...options, redirect: 'error' } : options]
      const response = await operation.run(() => suppress(() => Reflect.apply(original, this, args)))
      state.attributes.httpStatus = response.status; state.successStatus = response.ok ? 'ok' : 'error'
      integration.decorateResponse(response, state)
      if (!response.body || response.headers.get('content-length') === '0') state.finish({ status: 'ok' })
      return response
    } catch (error) { state.finish(failure(error)); throw error }
  })
}
function installElectronResolver(owner, name) {
  patch(owner, 'resolveHost', name, original => function (host, options) {
    if (suppressed()) return Reflect.apply(original, this, arguments)
    const operation = beginOperation(spec(name, 'electron-dns', { measurement: 'chromium-resolver-wall' }))
    try {
      gateHost(host, 'dns:')
      const args = [host, offline() ? { ...options, source: 'localOnly' } : options]
      return Promise.resolve(operation.run(() => suppress(() => Reflect.apply(original, this, args)))).then(value => {
        operation.end({ attributes: { count: value.endpoints?.length ?? 0 } }); return value
      }, error => { operation.end(failure(error)); throw error })
    } catch (error) { operation.end(failure(error)); return Promise.reject(error) }
  })
}
function observeElectronResponse(response, operation, attributes, finish) {
  integration.restoreEmitterContexts(response)
  attributes.httpStatus = response.statusCode
  const push = response.push
  if (typeof push !== 'function') throw Object.assign(Error('Electron IncomingMessage lacks the tested Readable API.'), { code: 'OPERATION_HOOK_UNSUPPORTED' })
  response.push = function (chunk, ...args) { if (chunk !== null) attributes.receivedBytes += size(chunk, args[0]) ?? 0; return Reflect.apply(push, this, [chunk, ...args]) }
  response.once(errorMonitor, error => finish(failure(error)))
  response.once('end', () => finish({ status: attributes.httpStatus >= 400 ? 'error' : 'ok' }))
  response.once('aborted', () => finish({ status: 'cancelled' }))
  response.once('close', () => { if (!response.readableEnded) finish({ status: 'cancelled' }) })
}
/** Must be invoked with the real Electron exports after app.ready, before app transport use. */
export function installElectronNetworkHooks({ app, net, session }, helpers = integration) {
  integration ??= helpers
  if (!app?.isReady()) {
    for (const name of electronAPIs) {
      capabilities.set(name, { name, enabled: false, reason: 'electron-app-not-ready' })
    }
    return [...capabilities.values()]
  }
  installElectronFetch(net, 'fetch', 'electron.net.fetch')
  installElectronResolver(net, 'electron.net.resolveHost')
  const sessionPrototype = Object.getPrototypeOf(session.defaultSession)
  installElectronFetch(sessionPrototype, 'fetch', 'electron.session.fetch')
  installElectronResolver(sessionPrototype, 'electron.session.resolveHost')
  patch(net, 'request', 'electron.net.request', original => function (...args) {
    if (suppressed()) return Reflect.apply(original, this, args)
    const operation = beginOperation(spec('electron.net.request', 'electron-http', { measurement: 'http-body-wall' }))
    const attributes = { sentBytes: 0, receivedBytes: 0 }
    let ended = false, response, depth = 0
    const finish = result => { if (!ended) { ended = true; operation.end({ ...result, attributes: { ...attributes, ...result?.attributes } }) } }
    try {
      const url = requestURL(args[0]); assertSandboxURL(url)
      if (offline()) args[0] = typeof args[0] === 'string' ? { url: args[0], redirect: 'error' } : { ...args[0], redirect: 'error' }
      const request = operation.run(() => suppress(() => Reflect.apply(original, this, args)))
      integration.restoreEmitterContexts(request)
      request.once('response', incoming => {
        response = incoming
        try { observeElectronResponse(incoming, operation, attributes, finish) } catch (error) { finish(failure(error)); request.abort(); throw error }
      })
      request.once(errorMonitor, error => finish(failure(error)))
      request.once('abort', () => finish({ status: 'cancelled' }))
      // Chromium may finish/close its upload side before delivering the response.
      // A response is terminal only on consumption, abort, or transport error.
      request.once('close', () => { if (request.aborted) finish({ status: 'cancelled' }) })
      for (const key of ['write', 'end']) {
        const submit = request[key]
        request[key] = function (...values) {
          if (!depth) attributes.sentBytes += size(values[0], values[1]) ?? 0
          const callback = typeof values.at(-1) === 'function' ? values.pop() : undefined, context = scope()
          if (callback) values.push(function (...result) { return resume(context, () => Reflect.apply(callback, this, result)) })
          depth++
          try { return suppress(() => Reflect.apply(submit, this, values)) } catch (error) { finish(failure(error)); throw error } finally { depth-- }
        }
      }
      return request
    } catch (error) { finish(failure(error)); throw error }
  })
  const Socket = net.WebSocket
  if (typeof Socket === 'function' && !electronSocketConstructors.has(Socket)) {
    try {
      const Wrapped = new Proxy(Socket, { construct(target, args, newTarget) {
        const construct = () => {
          assertSandboxURL(args[0])
          return suppress(() => Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget))
        }
        const socket = suppressed() ? construct() : constructRecordedWebSocket(construct, args[0], { source: 'native', stream: 'electron-native' })
        integration.restoreEventTargetContexts(socket)
        return socket
      } })
      Object.defineProperty(net, 'WebSocket', { configurable: true, writable: true, value: Wrapped })
      electronSocketConstructors.add(Wrapped)
      capabilities.set('electron.net.WebSocket', { name: 'electron.net.WebSocket', enabled: net.WebSocket === Wrapped }); probes.set('electron.net.WebSocket',()=>net.WebSocket===Wrapped)
    } catch { capabilities.set('electron.net.WebSocket', { name: 'electron.net.WebSocket', enabled: false, reason: 'native-property-not-writable' }) }
  } else if (typeof Socket !== 'function') capabilities.set('electron.net.WebSocket', { name: 'electron.net.WebSocket', enabled: false, reason: 'runtime-api-unavailable' })
  capabilities.set('electron.net.custom-protocols', { name: 'electron.net.custom-protocols', enabled: false, reason: 'non-http-protocols-rejected-before-native-fetch' })
  return [...capabilities.values()]
}
