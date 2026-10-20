import fs from 'node:fs'
import filePromises from 'node:fs/promises'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { AsyncLocalStorage } from 'node:async_hooks'
import { errorMonitor } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { extname } from 'node:path'
import { beginOperation, captureOperationContext, isOperationSuppressed, readOperationCPUTime } from './operations.js'
import { constructRecordedWebSocket, networkByteLength, networkResource } from './network-operations.js'
import { installRecordedSQLite } from './recorded-database.js'
import { assertSandboxURL } from './sandbox-network.js'
import { installNativeNetworkHooks, installElectronNetworkHooks, getNativeNetworkHookCapabilities } from './operation-network-hooks.js'

const require = createRequire(import.meta.url)
const hookScopes = new AsyncLocalStorage()
const installed = new Set()
const capabilities = new Map()
function capability(api, enabled, scope, reason, owner, key, wrapped) {
  const reference = owner && new WeakRef(owner)
  capabilities.set(api, { api, enabled, scope, ...(reason ? { reason } : {}),
    ...(reference ? { probe: () => { const value=reference.deref(); return !value || value[key]===wrapped } } : {}) })
}
export function getOperationHookCapabilities() {
  return [...capabilities.values()].map(({probe,...entry})=>{
    try {if(entry.enabled&&probe&&!probe())return {...entry,enabled:false,reason:'hook-replaced-after-installation'}}catch{return {...entry,enabled:false,reason:'hook-readback-failed'}}
    return entry
  }).concat(getNativeNetworkHookCapabilities()).sort((a,b)=>a.api.localeCompare(b.api))
}
export function getInstalledOperationHooks(snapshot = getOperationHookCapabilities()) {
  const active=new Set(snapshot.filter(entry=>entry.enabled).map(entry=>entry.api))
  const checks={filesystem:['fs.readFileSync'],crypto:['crypto.pbkdf2Sync'],zlib:['zlib.gzipSync'],sockets:['net.Socket.connect','tls.connect'],http:['http.request','https.request'],fetch:['globalThis.fetch'],websocket:['globalThis.WebSocket'],sqlite:['node:sqlite.DatabaseSync']}
  const result=[...installed].filter(family=>checks[family]?.every(api=>active.has(api))??true)
  for(const [family,api] of [['dns','dns.lookup'],['udp','dgram.createSocket'],['http2','http2.connect'],['electron.net','electron.net.fetch']])if(active.has(api))result.push(family)
  return result
}
const handleHooks = new WeakSet()
const directoryHooks = new WeakSet()
const streamHooks = new WeakSet()
const readerHooks = new WeakSet()
const responseHooks = new WeakSet()
const socketConstructors = new WeakSet()
const emitterHooks = new WeakSet()
const eventTargetHooks = new WeakSet()
const tcpSockets = new WeakMap()
const hookMarker = Symbol('operation-hook')
const knownExtensions = new Set(['.sqlite', '.db', '.parquet', '.json', '.jsonl', '.js', '.cjs', '.mjs', '.ts', '.html', '.css', '.png', '.pdf', '.txt', '.log'])

export function withOperationHookSuppressed(domain, operation) {
  return hookScopes.run(new Set([...(hookScopes.getStore() ?? []), domain]), operation)
}
export function isOperationHookSuppressed(domain) { return isOperationSuppressed() || hookScopes.getStore()?.has(domain) === true }

const failed = error => ({ status: error?.name === 'AbortError' ? 'cancelled' : 'error', attributes: { errorName: error?.name ?? 'Error' } })
const fileResource = value => {
  if (typeof value === 'number') return 'file-descriptor'
  let path = typeof value === 'string' ? value : value instanceof URL ? value.pathname : undefined
  if (path === undefined) return 'filesystem'
  const extension = extname(path).toLowerCase()
  return knownExtensions.has(extension) ? `file:${extension.slice(1)}` : 'filesystem'
}
const resultAttributes = (value, name = '') => ({
  ...(typeof value === 'string' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer ? { bytes: networkByteLength(value) } : {}),
  ...(Array.isArray(value) ? { count: value.length } : {}),
  ...(typeof value?.bytesRead === 'number' ? { bytes: value.bytesRead } : {}),
  ...(typeof value?.bytesWritten === 'number' ? { bytes: value.bytesWritten } : {}),
  ...(typeof value === 'number' && /\.(?:read|readv|write|writev)(?:Sync)?$/.test(name) ? { bytes: value } : {}),
})
const run = (span, operation) => typeof span.run === 'function' ? span.run(operation) : operation()
const captureScope = () => ({ hooks: hookScopes.getStore(), run: captureOperationContext() })
const resumeScope = (scope, operation) => scope.run(() => hookScopes.run(scope.hooks, operation))

/** Preserve application callback context while native transport internals are suppressed. */
function restoreEmitterContexts(target) {
  if (emitterHooks.has(target)) return
  emitterHooks.add(target)
  const mappings = new Map(), remove = target.removeListener, removeAll = target.removeAllListeners
  for (const key of ['on', 'addListener', 'prependListener']) {
    const original = target[key]
    target[key] = function (type, listener) {
      if (typeof listener !== 'function') return Reflect.apply(original, this, arguments)
      const scope = captureScope()
      const wrapped = function (...args) { return resumeScope(scope, () => Reflect.apply(listener, this, args)) }
      wrapped.listener = listener.listener ?? listener
      const handlers = mappings.get(type) ?? []
      handlers.push({ listener, wrapped }); mappings.set(type, handlers)
      return Reflect.apply(original, this, [type, wrapped])
    }
  }
  target.removeListener = target.off = function (type, listener) {
    const handlers = mappings.get(type)
    const index = handlers?.findLastIndex(record => record.listener === listener || record.listener.listener === listener || record.wrapped === listener) ?? -1
    const wrapped = index < 0 ? listener : handlers.splice(index, 1)[0].wrapped
    if (handlers?.length === 0) mappings.delete(type)
    return Reflect.apply(remove, this, [type, wrapped])
  }
  target.removeAllListeners = function (...args) {
    const result = Reflect.apply(removeAll, this, args)
    if (args.length) mappings.delete(args[0]); else mappings.clear()
    return result
  }
}

function restoreEventTargetContexts(target) {
  if (eventTargetHooks.has(target)) return
  eventTargetHooks.add(target)
  const add = target.addEventListener, remove = target.removeEventListener, listeners = new WeakMap(), propertyListeners = new WeakMap()
  target.addEventListener = function (type, listener, options) {
    if (!listener || !['function', 'object'].includes(typeof listener)) return Reflect.apply(add, this, arguments)
    let registered = listeners.get(listener)
    if (!registered) listeners.set(listener, registered = new Map())
    const key = `${type}:${typeof options === 'boolean' ? options : options?.capture === true}`
    let wrapped = registered.get(key)
    if (!wrapped) {
      const scope = captureScope()
      wrapped = function (...args) {
        if (options?.once === true) registered.delete(key)
        return resumeScope(scope, () => typeof listener === 'function'
          ? Reflect.apply(listener, this, args) : Reflect.apply(listener.handleEvent, listener, args))
      }
      registered.set(key, wrapped)
    }
    return Reflect.apply(add, this, [type, wrapped, options])
  }
  target.removeEventListener = function (type, listener, options) {
    const key = `${type}:${typeof options === 'boolean' ? options : options?.capture === true}`
    const wrapped = listeners.get(listener)?.get(key)
    listeners.get(listener)?.delete(key)
    return Reflect.apply(remove, this, [type, wrapped ?? listener, options])
  }
  for (const key of ['onopen', 'onmessage', 'onclose', 'onerror']) {
    let prototype = Object.getPrototypeOf(target), descriptor
    while (prototype && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(prototype, key); prototype = Object.getPrototypeOf(prototype) }
    if (!descriptor?.get || !descriptor.set) continue
    Object.defineProperty(target, key, { configurable: true, enumerable: descriptor.enumerable,
      get() { const value = Reflect.apply(descriptor.get, this, []); return propertyListeners.get(value) ?? value },
      set(listener) {
        let wrapped = listener
        if (typeof listener === 'function') {
          const scope = captureScope()
          wrapped = function (...args) { return resumeScope(scope, () => Reflect.apply(listener, this, args)) }
          propertyListeners.set(wrapped, listener)
        }
        return Reflect.apply(descriptor.set, this, [wrapped])
      } })
  }
}

function preserveFunction(original, replacement) {
  for (const key of Reflect.ownKeys(original)) {
    if (['arguments', 'caller', 'prototype'].includes(key)) continue
    try { Object.defineProperty(replacement, key, Object.getOwnPropertyDescriptor(original, key)) } catch { /* Native metadata can be read-only. */ }
  }
  Object.defineProperty(replacement, hookMarker, { value: true })
  return replacement
}

/** Callback overloads, promises and synchronous returns retain their native API. */
function hookFunction(owner, key, { domain, category, name, api: apiName, resource, attributes, returned, callback = false } = {}) {
  const original = owner[key]
  const api=apiName??name??String(key),scope=domain==='io'?'node-filesystem-api-call':'node-native-computation-api-call'
  if (typeof original !== 'function') { capability(api,false,scope,'runtime-api-unavailable'); return }
  if(original[hookMarker]) {capability(api,true,scope,undefined,owner,key,original);return}
  const replacement = preserveFunction(original, function (...args) {
    if (isOperationHookSuppressed(domain)) return Reflect.apply(original, this, args)
    const span = beginOperation({ category, name: name ?? key, resource: resource?.(args), attributes: attributes?.(args) })
    const cpu = category === 'cpu' || typeof key === 'string' && key.endsWith('Sync') ? readOperationCPUTime() : undefined
    const callerScope = captureScope()
    const callbackIndex = (typeof callback === 'function' ? callback(args) : callback) && typeof args.at(-1) === 'function' ? args.length - 1 : -1
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex]
      args[callbackIndex] = function (...values) {
        const error = values[0]
        if (!error) returned?.(values[1])
        span.end(error ? failed(error) : { attributes: resultAttributes(values[1], name) })
        return resumeScope(callerScope, () => Reflect.apply(callback, this, values))
      }
    }
    try {
      const value = run(span, () => withOperationHookSuppressed(domain, () => Reflect.apply(original, this, args)))
      if (callbackIndex >= 0) return value
      if (value && typeof value.then === 'function') return Promise.resolve(value).then(result => {
        returned?.(result)
        span.end({ attributes: resultAttributes(result, name) })
        return result
      }, error => { span.end(failed(error)); throw error })
      returned?.(value)
      span.end({ attributes: resultAttributes(value, name), ...(cpu === undefined ? {} : { cpuTimeMS: readOperationCPUTime() - cpu }) })
      return value
    } catch (error) { span.end({ ...failed(error), ...(cpu === undefined ? {} : { cpuTimeMS: readOperationCPUTime() - cpu }) }); throw error }
  })
  try { owner[key] = replacement; capability(api,owner[key]===replacement,scope,owner[key]===replacement?undefined:'native-property-not-writable',owner,key,replacement) }
  catch { capability(api,false,scope,'native-property-not-writable') }
}

function hookNodeStreamFactory(owner, key, category, name, domain) {
  const original = owner[key]
  const scope='factory-created-node-stream-lifecycle'
  if (typeof original !== 'function') {capability(name,false,scope,'runtime-api-unavailable');return}
  if(original[hookMarker]) {capability(name,true,scope,undefined,owner,key,original);return}
  const replacement = preserveFunction(original, function (...args) {
    if (isOperationHookSuppressed(domain)) return Reflect.apply(original, this, args)
    const span = beginOperation({ category, name, ...(category === 'io' ? { resource: fileResource(args[0]) } : {}),
      attributes: { measurement: 'stream-wall', source: 'native' } })
    try {
      const stream = run(span, () => Reflect.apply(original, this, args))
      const finish = (status = 'ok') => span.end({ status, attributes: {
        ...(typeof stream.bytesRead === 'number' ? { bytes: stream.bytesRead } : {}),
        ...(typeof stream.bytesWritten === 'number' ? { bytes: stream.bytesWritten } : {}),
      } })
      stream.once(errorMonitor, error => span.end(failed(error)))
      stream.once(key.includes('Read') ? 'end' : 'finish', () => finish())
      stream.once('close', () => finish(stream.destroyed && !stream.readableEnded && !stream.writableFinished ? 'cancelled' : 'ok'))
      return stream
    } catch (error) { span.end(failed(error)); throw error }
  })
  try { Object.defineProperty(owner,key,{configurable:true,writable:true,enumerable:Object.getOwnPropertyDescriptor(owner,key)?.enumerable??false,value:replacement});capability(name,owner[key]===replacement,scope,owner[key]===replacement?undefined:'native-property-not-writable',owner,key,replacement) }
  catch {capability(name,false,scope,'native-property-not-writable')}
}

function hookFileHandle(handle) {
  if (!handle || handleHooks.has(handle)) return
  handleHooks.add(handle)
  for (const method of ['appendFile', 'chmod', 'chown', 'datasync', 'sync', 'read', 'readv', 'readFile', 'stat', 'truncate', 'utimes', 'write', 'writev', 'writeFile', 'close']) {
    hookFunction(handle, method, { domain: 'io', category: 'io', name: `fs.handle.${method}`, resource: () => 'file-descriptor' })
  }
  for (const method of ['createReadStream', 'createWriteStream']) hookNodeStreamFactory(handle, method, 'io', `fs.handle.${method}`, 'io')
}

function hookDirectory(directory) {
  if (!directory || directoryHooks.has(directory)) return
  directoryHooks.add(directory)
  for (const method of ['read', 'readSync', 'close', 'closeSync']) hookFunction(directory, method, {
    domain: 'io', category: 'io', name: `fs.directory.${method}`, resource: () => 'directory', callback: !method.endsWith('Sync'),
  })
}

function installFilesystem() {
  const names = ['access', 'appendFile', 'chmod', 'chown', 'close', 'copyFile', 'cp', 'fdatasync', 'fchmod', 'fchown', 'fstat', 'fsync', 'ftruncate', 'futimes', 'lchmod', 'lchown', 'link', 'lstat', 'lutimes', 'mkdir', 'mkdtemp', 'open', 'opendir', 'read', 'readv', 'readdir', 'readFile', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'statfs', 'symlink', 'truncate', 'unlink', 'utimes', 'write', 'writev', 'writeFile']
  for (const method of names) {
    const options = { domain: 'io', category: 'io', name: `fs.${method}`, resource: args => fileResource(args[0]) }
    hookFunction(fs, method, { ...options, returned: method === 'opendir' ? hookDirectory : undefined, callback: true })
    hookFunction(fs, `${method}Sync`, { ...options, name: `fs.${method}Sync`, returned: method === 'opendir' ? hookDirectory : undefined })
    if(!['close','fdatasync','fchmod','fchown','fstat','fsync','ftruncate','futimes','read','readv','write','writev'].includes(method))hookFunction(filePromises, method, { ...options, name: `fs.promises.${method}`, returned: method === 'open' ? hookFileHandle : method === 'opendir' ? hookDirectory : undefined })
  }
  for (const method of ['createReadStream', 'createWriteStream']) hookNodeStreamFactory(fs, method, 'io', `fs.${method}`, 'io')
  for (const method of ['realpath', 'realpathSync']) if (fs[method]?.native) hookFunction(fs[method], 'native', {
    domain: 'io', category: 'io', name: `fs.${method}.native`, resource: args => fileResource(args[0]), callback: !method.endsWith('Sync'),
  })
  installed.add('filesystem')
}

function installCrypto() {
  const names = ['pbkdf2', 'scrypt', 'hkdf', 'argon2', 'randomBytes', 'randomFill', 'generateKey', 'generateKeyPair', 'generatePrime', 'checkPrime', 'createPrivateKey', 'createPublicKey', 'createSecretKey', 'diffieHellman', 'sign', 'verify', 'publicEncrypt', 'privateDecrypt', 'privateEncrypt', 'publicDecrypt', 'hash']
  const syncVariants=new Set(['pbkdf2','scrypt','hkdf','argon2','randomFill','generateKey','generateKeyPair','generatePrime','checkPrime'])
  for (const method of names) for (const key of syncVariants.has(method)?[method,`${method}Sync`]:[method]) hookFunction(crypto, key, {
    domain: 'cpu', category: 'cpu', name: `crypto.${key}`, attributes: () => ({ measurement: key.endsWith('Sync') ? 'native-thread-wall' : 'native-call-wall' }),
    callback: args => !key.endsWith('Sync') && (method === 'sign' ? args.length >= 4 : method === 'verify' ? args.length >= 5 : !['createPrivateKey', 'createPublicKey', 'createSecretKey', 'hash', 'publicEncrypt', 'privateDecrypt', 'privateEncrypt', 'publicDecrypt'].includes(method)),
  })
  for (const [type, methods] of [['Hash', ['update', 'digest', 'copy']], ['Hmac', ['update', 'digest']], ['Sign', ['update', 'sign']], ['Verify', ['update', 'verify']], ['Cipheriv', ['update', 'final']], ['Decipheriv', ['update', 'final']], ['ECDH', ['computeSecret', 'generateKeys']]]) {
    if (!crypto[type]) continue
    for (const method of methods) hookFunction(crypto[type].prototype, method, { domain: 'cpu', category: 'cpu', name: `crypto.${type.toLowerCase()}.${method}`,api:`crypto.${type}.prototype.${method}`,
      attributes: args => ({ measurement: 'native-thread-wall', ...(method === 'update' ? { bytes: networkByteLength(args[0]) } : {}) }) })
  }
  const subtle = crypto.webcrypto?.subtle
  if (subtle) for (const method of ['digest', 'deriveBits', 'deriveKey', 'generateKey', 'importKey', 'encrypt', 'decrypt', 'sign', 'verify', 'wrapKey', 'unwrapKey']) {
    hookFunction(subtle, method, { domain: 'cpu', category: 'cpu', name: `crypto.subtle.${method}`, attributes: () => ({ measurement: 'native-pool-wall' }) })
  }
  installed.add('crypto')
}

function installZlib() {
  for (const method of ['deflate', 'gzip', 'deflateRaw', 'unzip', 'inflate', 'gunzip', 'inflateRaw', 'brotliCompress', 'brotliDecompress', 'zstdCompress', 'zstdDecompress']) {
    for (const key of [method, `${method}Sync`]) hookFunction(zlib, key, { domain: 'cpu', category: 'cpu', name: `zlib.${key}`,
      attributes: args => ({ bytes: networkByteLength(args[0]), measurement: key.endsWith('Sync') ? 'native-thread-wall' : 'native-pool-wall' }), callback: !key.endsWith('Sync') })
  }
  for (const method of ['createDeflate', 'createGzip', 'createDeflateRaw', 'createUnzip', 'createInflate', 'createGunzip', 'createInflateRaw', 'createBrotliCompress', 'createBrotliDecompress', 'createZstdCompress', 'createZstdDecompress']) {
    hookNodeStreamFactory(zlib, method, 'cpu', `zlib.${method}`, 'cpu')
  }
  installed.add('zlib')
}

function httpURL(args, protocol) {
  const first = args[0], urlInput = typeof first === 'string' || first instanceof URL
  const options = (urlInput ? args[1] : first) ?? {}
  const host = options.hostname ?? options.host ?? 'localhost'
  const authority = String(host).includes(':') && !String(host).startsWith('[') && net.isIP(String(host)) === 6 ? `[${host}]` : host
  let url = urlInput ? new URL(first) : new URL(`${protocol}//${authority}`)
  if (options.hostname || options.host) url.hostname = String(authority)
  if (options.protocol) url.protocol = options.protocol
  if (options.port !== undefined) url.port = String(options.port)
  if (options.path) url = new URL(options.path, url)
  return url
}

function observeIncomingMessage(response, state) {
  if (state.response) return
  state.response = response
  state.attributes.httpStatus = response.statusCode
  restoreEmitterContexts(response)
  const push = response.push
  response.push = function (chunk, ...args) {
    const bytes = networkByteLength(chunk)
    if (bytes !== null) state.attributes.receivedBytes = (state.attributes.receivedBytes ?? 0) + bytes
    return Reflect.apply(push, this, [chunk, ...args])
  }
  response.once(errorMonitor, error => state.finish(failed(error)))
  response.once('aborted', () => state.finish({ status: 'error', attributes: { reason: 'response-aborted' } }))
  response.once('end', () => state.finish({ status: response.statusCode >= 400 ? 'error' : 'ok' }))
  response.once('close', () => { if (!response.complete) state.finish({ status: 'error', attributes: { reason: 'response-incomplete' } }) })
}

function installHTTP() {
  for (const [owner, protocol] of [[http, 'http:'], [https, 'https:']]) {
    for (const method of ['request', 'get']) {
      const original = owner[method]
      owner[method] = preserveFunction(original, function (...args) {
        if (isOperationHookSuppressed('network')) return Reflect.apply(original, this, args)
        const url = httpURL(args, protocol), caller = captureScope()
        const span = beginOperation({ category: 'network', name: 'node.http.request', resource: networkResource(url),
          attributes: { source: 'native', transport: 'http', method: (typeof args[0] === 'string' || args[0] instanceof URL ? args[1]?.method : args[0]?.method) ?? 'GET', measurement: 'http-body-wall' } })
        const state = { attributes: { sentBytes: 0, receivedBytes: 0 }, ended: false }
        state.finish = result => { if (!state.ended) { state.ended = true; span.end({ ...result, attributes: { ...state.attributes, ...result.attributes } }) } }
        const callbackIndex = typeof args.at(-1) === 'function' ? args.length - 1 : -1
        if (callbackIndex >= 0) {
          const callback = args[callbackIndex]
          args[callbackIndex] = function (response) { observeIncomingMessage(response, state); return resumeScope(caller, () => Reflect.apply(callback, this, [response])) }
        }
        try {
          assertSandboxURL(url)
          const request = run(span, () => withOperationHookSuppressed('network', () => Reflect.apply(original, this, args)))
          restoreEmitterContexts(request)
          request.once('response', response => observeIncomingMessage(response, state))
          request.once(errorMonitor, error => state.finish(failed(error)))
          request.once('close', () => { if (!state.response) state.finish({ status: 'cancelled' }) })
          for (const key of ['write', 'end']) {
            const submit = request[key]
            request[key] = function (...values) {
              const bytes = networkByteLength(values[0])
              if (!state.submissionDepth && bytes !== null) state.attributes.sentBytes += bytes
              if (typeof values.at(-1) === 'function') {
                const callback = values.at(-1), scope = captureScope()
                values[values.length - 1] = function (...result) { return resumeScope(scope, () => Reflect.apply(callback, this, result)) }
              }
              state.submissionDepth = (state.submissionDepth ?? 0) + 1
              try { return withOperationHookSuppressed('network', () => Reflect.apply(submit, this, values)) }
              finally { state.submissionDepth-- }
            }
          }
          for (const key of ['abort', 'destroy']) {
            const destroy = request[key]
            if (typeof destroy !== 'function') continue
            request[key] = function (...values) {
              const result = Reflect.apply(destroy, this, values)
              if (!state.ended && !state.response?.complete) state.finish(values[0] ? failed(values[0]) : { status: 'cancelled' })
              return result
            }
          }
          return request
        } catch (error) { state.finish(failed(error)); throw error }
      })
    }
  }
  for(const [owner,prefix] of [[http,'http'],[https,'https']])for(const key of ['request','get'])capability(`${prefix}.${key}`,true,'node-client-request-through-consumed-response',undefined,owner,key,owner[key])
  installed.add('http')
}

function connectionURL(args, secure) {
  const first = args[0]
  const options = first && typeof first === 'object' ? first : {
    ...(typeof first === 'number' || typeof first === 'string' && /^\d+$/.test(first) ? { port: first } : { path: first }),
    ...(typeof args[1] === 'string' ? { host: args[1] } : typeof args[1] === 'object' ? args[1] : {}),
    ...(typeof args[2] === 'object' ? args[2] : {}),
  }
  if (options.path || options.socket) return new URL(`${secure ? 'tls' : 'tcp'}://localhost/`)
  const host = options.host ?? options.hostname ?? 'localhost'
  const authority = net.isIP(String(host)) === 6 ? `[${host}]` : host
  return new URL(`${secure ? 'tls' : 'tcp'}://${authority}${options.port !== undefined ? `:${options.port}` : ''}/`)
}

function trackConnection(socket, span, url, secure) {
  if (tcpSockets.has(socket)) return socket
  const resource = networkResource(url), metadata = { resource, transport: secure ? 'tls' : 'tcp' }
  tcpSockets.set(socket, metadata)
  restoreEmitterContexts(socket)
  socket.once(secure ? 'secureConnect' : 'connect', () => span.end())
  socket.once(errorMonitor, error => span.end(failed(error)))
  socket.once('close', hadError => {
    span.end({ status: hadError ? 'error' : 'cancelled' })
    beginOperation({ category: 'network', name: 'socket.closed', resource, attributes: { source: 'native', transport: metadata.transport } }).end({ status: hadError ? 'error' : 'ok' })
  })
  return socket
}

function installSockets() {
  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = preserveFunction(connect, function (...args) {
    if (isOperationHookSuppressed('network')) return Reflect.apply(connect, this, args)
    // net.createConnection normalizes overloaded args to one array internally.
    const normalized = Array.isArray(args[0]) ? args[0] : args
    const forwarded = [...normalized]
    if (typeof forwarded.at(-1) === 'function') {
      const callback = forwarded.at(-1), scope = captureScope()
      forwarded[forwarded.length - 1] = function (...values) { return resumeScope(scope, () => Reflect.apply(callback, this, values)) }
    }
    const url = connectionURL(normalized, false)
    const span = beginOperation({ category: 'network', name: 'socket.connect', resource: networkResource(url), attributes: { source: 'native', transport: 'tcp' } })
    try {
      assertSandboxURL(url)
      const socket = run(span, () => withOperationHookSuppressed('network', () => Reflect.apply(connect, this, forwarded)))
      return trackConnection(socket, span, url, false)
    } catch (error) { span.end(failed(error)); throw error }
  })
  const secureConnect = tls.connect
  tls.connect = preserveFunction(secureConnect, function (...args) {
    if (isOperationHookSuppressed('network')) return Reflect.apply(secureConnect, this, args)
    const url = connectionURL(args, true)
    const span = beginOperation({ category: 'network', name: 'socket.connect', resource: networkResource(url), attributes: { source: 'native', transport: 'tls' } })
    try {
      assertSandboxURL(url)
      if (typeof args.at(-1) === 'function') {
        const callback = args.at(-1), scope = captureScope()
        args[args.length - 1] = function (...values) { return resumeScope(scope, () => Reflect.apply(callback, this, values)) }
      }
      const socket = run(span, () => withOperationHookSuppressed('network', () => Reflect.apply(secureConnect, this, args)))
      return trackConnection(socket, span, url, true)
    } catch (error) { span.end(failed(error)); throw error }
  })
  for (const key of ['write', 'end', 'push']) {
    const original = net.Socket.prototype[key]
    net.Socket.prototype[key] = preserveFunction(original, function (...args) {
      const metadata = tcpSockets.get(this)
      if (!metadata || (key === 'push' ? isOperationSuppressed() : isOperationHookSuppressed('network'))) return Reflect.apply(original, this, args)
      if (key === 'push' && args[0] === null) return Reflect.apply(original, this, args)
      const span = beginOperation({ category: 'network', name: key === 'push' ? 'socket.receive' : `socket.${key}`, resource: metadata.resource,
        attributes: { source: 'native', transport: metadata.transport, bytes: networkByteLength(args[0]), measurement: 'transport-submission' } })
      try {
        const result = withOperationHookSuppressed('network', () => Reflect.apply(original, this, args))
        span.end({ attributes: { bufferedBytes: this.writableLength } }); return result
      } catch (error) { span.end(failed(error)); throw error }
    })
  }
  for(const [owner,key,api] of [[net.Socket.prototype,'connect','net.Socket.connect'],[net.Socket.prototype,'write','net.Socket.write'],[net.Socket.prototype,'end','net.Socket.end'],[net.Socket.prototype,'push','net.Socket.push'],[tls,'connect','tls.connect']])capability(api,true,'tracked-outbound-socket-connect-and-submission',undefined,owner,key,owner[key])
  installed.add('sockets')
}

function installFetch() {
  const fetcher = globalThis.fetch
  if(typeof fetcher!=='function'){capability('globalThis.fetch',false,'native-fetch-through-lazy-consumed-body','runtime-api-unavailable');return}
  if(fetcher[hookMarker])return
  globalThis.fetch = preserveFunction(fetcher, async function (input, init) {
    if (isOperationHookSuppressed('network')) return Reflect.apply(fetcher, this, arguments)
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const span = beginOperation({ category: 'network', name: 'fetch.request', resource: networkResource(typeof input === 'string' || input instanceof URL ? input : input?.url),
      attributes: { source: 'native', transport: 'http', method: init?.method ?? (input instanceof Request ? input.method : 'GET') } })
    const state = { span, signal, ended: false, attributes: {}, methods: 0, bytes: new WeakMap() }
    state.finish = result => {
      if (state.ended) return
      state.ended = true
      signal?.removeEventListener('abort', abort)
      span.end({ ...result, ...(result?.status === 'ok' && state.successStatus === 'error' ? { status: 'error' } : {}), attributes: { ...state.attributes, ...result?.attributes } })
    }
    const abort = () => state.finish({ status: 'cancelled' })
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (signal?.aborted) abort()
      assertSandboxURL(typeof input === 'string' || input instanceof URL ? input : input?.url)
      const response = await run(span, () => withOperationHookSuppressed('network', () => Reflect.apply(fetcher, this, arguments)))
      state.attributes.httpStatus = response.status
      state.successStatus = response.ok ? 'ok' : 'error'
      const length = response.headers.get('content-length')
      if (length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length))) state.attributes.declaredResponseBytes = Number(length)
      decorateResponse(response, state)
      if (!response.body || length === '0') state.finish({ status: 'ok' })
      return response
    } catch (error) { state.finish(failed(error)); throw error }
  })
  capability('globalThis.fetch',true,'native-fetch-through-lazy-consumed-body',undefined,globalThis,'fetch',globalThis.fetch)
  installed.add('fetch')
}

function observeChunk(state, stream, chunk) {
  if (state.byteCountUnavailable) return
  const size = networkByteLength(chunk)
  if (size !== null) {
    const bytes = (state.bytes.get(stream) ?? 0) + size
    state.bytes.set(stream, bytes)
    state.attributes.receivedBytes = Math.max(state.attributes.receivedBytes ?? 0, bytes)
  }
}
function decorateIterator(iterator, state, stream, preventCancel = false) {
  const next = iterator.next, returned = iterator.return
  iterator.next = function (...args) {
    return Promise.resolve(withOperationHookSuppressed('network', () => Reflect.apply(next, this, args))).then(result => {
      if (result.done) { if (!state.methods) state.finish({ status: 'ok' }) }
      else observeChunk(state, stream, result.value)
      return result
    }, error => { state.finish(failed(error)); throw error })
  }
  if (returned) iterator.return = function (...args) {
    return Promise.resolve(Reflect.apply(returned, this, args)).then(result => { if (!preventCancel) state.finish({ status: 'cancelled' }); return result }, error => { state.finish(failed(error)); throw error })
  }
  return iterator
}
function decorateStream(stream, state) {
  if (!stream || streamHooks.has(stream)) return
  streamHooks.add(stream)
  const getReader = stream.getReader, cancel = stream.cancel, pipeTo = stream.pipeTo, pipeThrough = stream.pipeThrough, tee = stream.tee
  stream.getReader = function (...args) {
    const reader = Reflect.apply(getReader, this, args)
    if (isOperationHookSuppressed('network') || readerHooks.has(reader)) return reader
    readerHooks.add(reader)
    const read = reader.read, readerCancel = reader.cancel
    reader.read = function (...values) {
      return Promise.resolve(withOperationHookSuppressed('network', () => Reflect.apply(read, this, values))).then(result => {
        if (result.done) { if (!state.methods) state.finish({ status: 'ok' }) }
        else observeChunk(state, stream, result.value)
        return result
      }, error => { state.finish(failed(error)); throw error })
    }
    reader.cancel = function (...values) {
      return Promise.resolve(Reflect.apply(readerCancel, this, values)).then(result => { state.finish({ status: 'cancelled' }); return result }, error => { state.finish(failed(error)); throw error })
    }
    return reader
  }
  stream.cancel = function (...args) {
    return Promise.resolve(Reflect.apply(cancel, this, args)).then(result => { state.finish({ status: 'cancelled' }); return result }, error => { state.finish(failed(error)); throw error })
  }
  for (const method of ['values', Symbol.asyncIterator]) {
    const original = stream[method]
    if (typeof original === 'function') stream[method] = function (...args) {
      const iterator = withOperationHookSuppressed('network', () => Reflect.apply(original, this, args))
      return isOperationHookSuppressed('network') ? iterator : decorateIterator(iterator, state, stream, args[0]?.preventCancel === true)
    }
  }
  stream.pipeTo = function (...args) {
    state.byteCountUnavailable = true; delete state.attributes.receivedBytes
    state.attributes.measurement = 'body-wall-unmeasured-bytes'
    return Promise.resolve(Reflect.apply(pipeTo, this, args)).then(result => { if (!state.methods) state.finish({ status: 'ok' }); return result }, error => { state.finish(failed(error)); throw error })
  }
  stream.pipeThrough = function (...args) {
    const result = Reflect.apply(pipeThrough, this, args)
    state.byteCountUnavailable = true; delete state.attributes.receivedBytes
    state.attributes.measurement = 'body-wall-unmeasured-bytes'
    decorateStream(result, state); return result
  }
  stream.tee = function (...args) { const result = Reflect.apply(tee, this, args); for (const branch of result) decorateStream(branch, state); return result }
}
function decorateResponse(response, state) {
  decorateStream(response.body, state)
  if (responseHooks.has(response)) return
  responseHooks.add(response)
  for (const method of ['json', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes']) {
    const original = response[method]
    if (typeof original !== 'function') continue
    response[method] = function (...args) {
      state.methods++
      try {
        return Promise.resolve(Reflect.apply(original, this, args)).then(value => {
          state.methods--; if (!state.methods) state.finish({ status: 'ok' }); return value
        }, error => { state.methods--; state.finish(failed(error)); throw error })
      } catch (error) { state.methods--; state.finish(failed(error)); throw error }
    }
  }
  const clone = response.clone
  response.clone = function (...args) { const result = Reflect.apply(clone, this, args); decorateStream(response.body, state); decorateResponse(result, state); return result }
}

function installWebSocket() {
  const Socket = globalThis.WebSocket
  if(typeof Socket!=='function'){capability('globalThis.WebSocket',false,'native-socket-connect-send-receive','runtime-api-unavailable');return}
  if(socketConstructors.has(Socket))return
  const HookedSocket = new Proxy(Socket, { construct(target, args, newTarget) {
    const construct = () => {
      assertSandboxURL(args[0])
      const socket = withOperationHookSuppressed('network', () => Reflect.construct(target, args, newTarget === HookedSocket ? target : newTarget))
      restoreEventTargetContexts(socket)
      for (const method of ['send', 'close']) {
        const original = socket[method]
        socket[method] = function (...values) { return withOperationHookSuppressed('network', () => Reflect.apply(original, this, values)) }
      }
      return socket
    }
    if (isOperationHookSuppressed('network')) return construct()
    return constructRecordedWebSocket(construct, args[0], { source: 'native', stream: 'native' })
  } })
  socketConstructors.add(HookedSocket)
  globalThis.WebSocket = HookedSocket
  capability('globalThis.WebSocket',globalThis.WebSocket===HookedSocket,'native-socket-connect-send-receive',undefined,globalThis,'WebSocket',HookedSocket)
  installed.add('websocket')
}

/** Install once per process/worker; existing named builtin imports are live-updated. */
export function installOperationHooks() {
  if (installed.size) return getInstalledOperationHooks()
  installFilesystem()
  installCrypto()
  installZlib()
  installSockets()
  installHTTP()
  installFetch()
  installWebSocket()
  try {
    const sqlite=require('node:sqlite'),enabled=installRecordedSQLite(sqlite)
    if(enabled)installed.add('sqlite')
    capability('node:sqlite.DatabaseSync',enabled,'default-module-constructor-and-recorded-opens-only',enabled?undefined:'native-constructor-not-writable',sqlite,'DatabaseSync',sqlite.DatabaseSync)
  } catch {capability('node:sqlite.DatabaseSync',false,'default-module-constructor-and-recorded-opens-only','runtime-api-unavailable')}
  installNativeNetworkHooks(nativeNetworkIntegration())
  syncBuiltinESMExports()
  return getInstalledOperationHooks()
}

function nativeNetworkIntegration() {
  return {captureScope,resumeScope,restoreEmitterContexts,restoreEventTargetContexts,decorateResponse,
    suppressed:()=>isOperationHookSuppressed('network'),withNetwork:operation=>withOperationHookSuppressed('network',operation)}
}
/** Call after Electron ready, before net or Session transports are used. */
export function installElectronOperationHooks(electron) {
  installOperationHooks()
  installElectronNetworkHooks(electron,nativeNetworkIntegration())
  return getOperationHookCapabilities()
}
