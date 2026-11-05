import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { initializeOperationRecording, closeOperationRecording, closeExternalOperationSource } from '../../electron/services/operation-runtime.js'
import { createRendererOperationReceiver } from '../../electron/services/renderer-operations.js'
import { encodeChartWire } from '../../electron/chart-wire.js'
import { createNativeBroker } from './native-broker.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const profile = process.env.RADAR_COMPARE_PROFILE
const telemetry = process.env.RADAR_COMPARE_TELEMETRY ?? 'full', transport = process.env.RADAR_COMPARE_TRANSPORT ?? 'http'
const assets = join(root, 'dist')
if (!profile || telemetry !== 'off' && !process.env.PERPETUAL_SWAP_OPERATION_DIR) throw new Error('An isolated profile and explicit recording policy are required.')
await mkdir(profile, { recursive: true })
initializeOperationRecording({ label: 'comparison-backend' })
const { MarketBackend } = await import('../../electron/services/market-backend.js')
const backend = new MarketBackend({ userData: profile, testMode: true, e2eLiveRefresh: false })
const receiver = createRendererOperationReceiver(), owner = 'comparison-page', token = randomUUID()
let stream, native, nextCommand = 0, closing = false, metrics
const resetMetrics = () => { metrics = { requests: {}, requestBytes: {}, responseBytes: {}, events: {}, eventBytes: {} } }
resetMetrics()
const commands = new Map()
const bridge = await readFile(new URL('./browser.js', import.meta.url), 'utf8')
const probes = process.env.RADAR_COMPARE_DIAGNOSTICS === '1' ? await readFile(new URL('./timing-probes.js', import.meta.url), 'utf8') : ''
const send = value => {
  if (!stream && !native?.connected) return
  const key = value.channel ?? (value.command ? 'controller' : 'fatal'), encoded = JSON.stringify(value)
  metrics.events[key] = (metrics.events[key] ?? 0) + 1; metrics.eventBytes[key] = (metrics.eventBytes[key] ?? 0) + Buffer.byteLength(encoded)
  if (native?.connected) native.send(encoded); else stream.write(`data: ${encoded}\n\n`)
}
for (const [name, channel] of [['chart', 'radar:chart-prepared'], ['market', 'radar:market-changed'], ['audit', 'radar:audit-changed'], ['history-download', 'radar:history-download-changed']]) {
  backend.on(name, detail => send({ channel, detail: name === 'chart' ? encodeChartWire(detail) : detail }))
}
backend.on('failure', error => { console.error(error); send({ fatal: error.message }) })
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)) }
async function body(request) {
  const chunks = []; let bytes = 0
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw new Error('Comparison request exceeds 16 MiB.'); chunks.push(chunk) }
  return { value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), bytes }
}
async function command(value) {
  if (!stream && !native?.connected) throw new Error('Comparison page is not connected.')
  const id = ++nextCommand
  return new Promise((resolveCommand, reject) => {
    const timeout = setTimeout(() => { commands.delete(id); reject(new Error(`Browser command ${value.action} timed out.`)) }, Math.max(60_000, (value.durationMS ?? 0) + 60_000))
    commands.set(id, { resolve: value => { clearTimeout(timeout); resolveCommand(value) }, reject: error => { clearTimeout(timeout); reject(error) } })
    send({ command: { id, ...value } })
  })
}
async function rpc(path, value, bytes = 0) {
  if (!['metrics', 'status', 'control'].includes(path)) {
    metrics.requests[path] = (metrics.requests[path] ?? 0) + 1
    metrics.requestBytes[path] = (metrics.requestBytes[path] ?? 0) + bytes
  }
  let result
  if (path === 'connect') result = { ok: true }
  else if (path === 'status') result = { connected: Boolean(stream) || native?.connected === true, pid: process.pid, fixture, epochMS: performance.timeOrigin + performance.now() }
  else if (path === 'metrics') result = structuredClone(metrics)
  else if (path === 'control') { if (value.action === 'run') resetMetrics(); result = await command(value) }
  else if (path === 'result') {
    const pending = commands.get(value.id); commands.delete(value.id)
    if (value.error) pending?.reject(new Error(value.error)); else pending?.resolve(value.result)
    result = { ok: true }
  } else if (path === 'request') {
    result = await backend.request(value)
    if (['chartWindow', 'chartLocal', 'chartHistory', 'chartUniverse'].some(key => key in value)) result = encodeChartWire(result)
  } else if (path === 'probe') result = await backend.probe(value)
  else if (path === 'operations/init') result = receiver.initialize(owner, value.nonce)
  else if (path === 'operations/batch') result = await receiver.receive(owner, value)
  else if (path === 'operations/failure') { receiver.fail(owner, value); result = { ok: true } }
  else throw new Error(`Unknown comparison RPC: ${path}`)
  const encoded = JSON.stringify(result)
  if (!['metrics', 'status', 'control'].includes(path)) metrics.responseBytes[path] = (metrics.responseBytes[path] ?? 0) + Buffer.byteLength(encoded)
  return encoded
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1')
    const sessionPath = url.pathname.startsWith(`/${token}/`)
    if (!sessionPath && (request.method !== 'GET' || url.pathname !== '/' && !url.pathname.startsWith('/assets/'))) return json(response, 404, { error: 'Unknown comparison session.' })
    const path = sessionPath ? url.pathname.slice(token.length + 2) : url.pathname.slice(1)
    if (request.headers.origin && request.headers.origin !== origin) return json(response, 403, { error: 'Comparison origin mismatch.' })
    if (path === 'events') {
      if (stream) throw new Error('A comparison renderer is already connected.')
      stream = response; response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); response.write(': connected\n\n')
      request.on('close', () => { if (stream === response) stream = undefined }); return
    }
    if (request.method === 'POST') {
      const { value, bytes } = await body(request)
      const result = await rpc(path, value, bytes)
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(result); return
    }
    if (path === 'status') { response.setHeader('Content-Type', 'application/json'); response.end(await rpc(path)); return }
    if (path === 'browser.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(`globalThis.__radarComparisonClockOffsetMS=${Number(process.env.RADAR_COMPARE_CLOCK_OFFSET_MS ?? 0)};globalThis.__radarComparisonOptions=${JSON.stringify({ telemetry, transport, engineProfile: process.env.RADAR_COMPARE_ENGINE_PROFILE === '1' })};\n${probes};\n${bridge}`); return }
    const relative = path || 'index.html', file = resolve(assets, relative)
    if (!file.startsWith(assets + '/')) return json(response, 403, { error: 'Invalid asset path.' })
    let contents = await readFile(file)
    if (relative === 'index.html') contents = Buffer.from(contents.toString().replace('<head>', `<head><script src="/${token}/browser.js"></script>`))
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' })[extname(file)] ?? 'application/octet-stream')
    response.setHeader('Cache-Control', 'no-store'); response.end(contents)
  } catch (error) { json(response, 500, { error: error.message }); console.error(error.stack) }
})
await backend.ready
const fixture = await backend.probe({ action: 'scaleSeed', count: Number(process.env.RADAR_COMPARE_COUNT ?? 287), periods: 384 })
if (transport === 'native') native = await createNativeBroker({ token, dispatch: rpc })
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const origin = `http://127.0.0.1:${server.address().port}`
console.log(JSON.stringify({ ready: true, pid: process.pid, url: `${origin}/${token}/`, fixture, socketPath: native?.path, nativeToken: token }))
async function close() {
  if (closing) return; closing = true
  try {
    for (const pending of commands.values()) pending.reject(new Error('Comparison backend is closing.'))
    commands.clear()
    if (stream) { try { await command({ action: 'drain' }) } catch (error) { console.error(error.message) } }
    stream?.end(); server.closeAllConnections(); await new Promise(done => server.close(done))
    await native?.close()
    await backend.dispose()
    for (const source of receiver.sourcesFor(owner)) await closeExternalOperationSource(source)
    await closeOperationRecording()
  } catch (error) { console.error(error.stack); process.exitCode = 1 }
}
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close())
