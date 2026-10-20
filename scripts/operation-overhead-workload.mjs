import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { Session } from 'node:inspector'
import { setTimeout as delay, setImmediate as turn } from 'node:timers/promises'
import { createMemorySampler } from './operation-overhead-memory.mjs'
const root = resolve(process.env.PERPETUAL_SWAP_OVERHEAD_ROOT ?? new URL('../', import.meta.url).pathname)
const moduleAt = path => import(pathToFileURL(join(root, path)).href)
const { closeOperationRecording, flushOperationRecording } = await moduleAt('electron/services/operation-runtime.js')
const { buildIndicatorSeries } = await moduleAt('electron/services/indicators.js')
const { MarketStore } = await moduleAt('electron/services/market-store.js')
const { MarketService } = await moduleAt('electron/services/market-service.js')
const { DEFAULT_PREFERENCES } = await moduleAt('electron/services/preferences.js')
const config = JSON.parse(process.argv[2]); config.epoch ??= Math.floor(Date.now() / 300000) * 300000; const directory = resolve(config.directory)
// Keep each isolated business workload away from an accidental native-period
// rollover while its transport timers still advance monotonically. Metrics and
// operation timestamps continue to use the real performance/CPU clocks.
const businessStart = performance.now()
Date.now = () => config.epoch + 60_000 + Math.floor(performance.now() - businessStart)
await mkdir(directory, { recursive: true })
const metrics = {}
const memorySampler = createMemorySampler()
async function measure(name, operation) {
  const histogram = monitorEventLoopDelay({ resolution: 1 }); histogram.enable()
  await turn()
  const cpu = process.cpuUsage(), thread = process.threadCpuUsage(), memoryWindow = memorySampler.begin(), memory = memoryWindow.initial, utilization = performance.eventLoopUtilization(), started = performance.now()
  try {
    const value = await operation()
    await turn()
    const wallMS = performance.now() - started, used = process.cpuUsage(cpu), threadUsed = process.threadCpuUsage(thread)
    const active = performance.eventLoopUtilization(utilization), after = memoryWindow.end()
    histogram.disable()
    metrics[name] = { startedAt: performance.timeOrigin + started, endedAt: performance.timeOrigin + started + wallMS, wallMS, cpuMS: (used.user + used.system) / 1000, mainThreadCpuMS: (threadUsed.user + threadUsed.system) / 1000,
      eventLoopP99MS: Number.isFinite(histogram.mean) ? histogram.percentile(99) / 1e6 : 0, eventLoopMaxMS: histogram.max / 1e6,
      eventLoopActiveMS: active.active, eventLoopUtilization: active.utilization, rssDeltaBytes: after.final.rss - memory.rss,
      peakRSSBytes: after.peakRSSBytes, peakHeapBytes: after.peakHeapBytes }
    return value
  } finally { memoryWindow.end(); histogram.disable() }
}
const frame = (text, opcode = 1) => {
  const body = Buffer.isBuffer(text) ? text : Buffer.from(text), header = Buffer.alloc(body.length < 126 ? 2 : 4)
  header[0] = 0x80 | opcode
  if (body.length < 126) header[1] = body.length
  else { header[1] = 126; header.writeUInt16BE(body.length, 2) }
  return Buffer.concat([header, body])
}
async function exchange() {
  const clients = new Set(), errors = []
  const server = createServer((_request, response) => response.writeHead(404).end())
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    socket.setNoDelay(true)
    const client = { socket, pending: Buffer.alloc(0), subscriptions: new Map() }; clients.add(client)
    socket.on('error', error => errors.push(error.message)); socket.on('close', () => clients.delete(client))
    socket.on('data', chunk => {
      client.pending = Buffer.concat([client.pending, chunk])
      while (client.pending.length >= 2) {
        const buffer = client.pending, opcode = buffer[0] & 15
        let size = buffer[1] & 127, offset = 2
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4 }
        if (size === 127) throw new Error('Fixture does not accept oversized client frames.')
        if (buffer.length < offset + 4 + size) return
        const mask = buffer.subarray(offset, offset + 4), body = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size))
        for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4]
        client.pending = buffer.subarray(offset + 4 + size)
        if (opcode === 8) { socket.end(frame(body, 8)); continue }
        if (opcode !== 1) continue
        if (body.toString() === 'ping') { socket.write(frame('pong')); continue }
        const command = JSON.parse(body)
        for (const arg of command.args) {
          const key = `${arg.channel}:${arg.instId}`
          if (command.op === 'subscribe') client.subscriptions.set(key, arg); else client.subscriptions.delete(key)
          socket.write(frame(JSON.stringify({ id: command.id, event: command.op, arg })))
        }
      }
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const send = (arg, data, action) => {
    let sent = 0
    for (const client of clients) if (client.subscriptions.has(`${arg.channel}:${arg.instId}`)) {
      client.socket.write(frame(JSON.stringify({ arg, data: [data], ...(action ? { action } : {}) }))); sent++
    }
    assert.equal(sent, 1, 'Every deterministic market message must have exactly one native subscriber.')
  }
  return { url: `ws://127.0.0.1:${server.address().port}/feed`, send, errors,
    async close() { for (const { socket } of clients) socket.destroy(); await new Promise(resolve => server.close(resolve)) } }
}
const ids = Array.from({ length: config.contracts }, (_, index) => `ASSET${index}-USDT-SWAP`)
const epoch = config.epoch, candle = (instrument, timeframe, timestamp, index) => ({ instrument, timeframe, timestamp,
  open: 100, high: 105, low: 95, close: 100 + (index % 17) / 100, volume: 100, baseVolume: 1, quoteVolume: 10000, confirmed: true })
const seedRows = ids.flatMap(id => [['5m', 300000], ['15m', 900000]].flatMap(([timeframe, step]) =>
  Array.from({ length: 300 }, (_, index) => candle(id, timeframe, Math.floor(epoch / step) * step - (300 - index) * step, index))))
const source = Array.from({ length: 4096 }, (_, index) => candle(ids[0], '5m', epoch + index * 300000, index))
const store = await MarketStore.open(join(directory, 'MarketData'))
const transport = await exchange()
const preferences = structuredClone(DEFAULT_PREFERENCES)
for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
let unexpectedRequests = 0
const service = new MarketService(store, () => preferences, async () => { unexpectedRequests++; return new Response(JSON.stringify({ code: '0', data: [] })) }, false,
  { webSocketFactory: () => new WebSocket(transport.url) })
const waitFor = async (condition, description) => { const until = performance.now() + 30000; while (!condition()) { assert.ok(performance.now() < until, `Timed out: ${description}`); await delay(2) } }
let sequence = 0, messages = 0
const sendRound = async () => {
  const started = performance.now()
  sequence++
  const before = service.publicRealtime.getTelemetry().receivedEvents
  for (const [index, instId] of ids.entries()) {
    const price = 100 + index / 10 + sequence / 1000, ts = String(Date.now())
    transport.send({ instId, channel: 'tickers' }, { instId, last: String(price), bidPx: String(price - .01), askPx: String(price + .01), ts })
    transport.send({ instId, channel: 'open-interest' }, { instId, oi: String(10000 + sequence), oiUsd: '10000000', ts })
    const levels = side => Array.from({ length: sequence === 1 ? 400 : 1 }, (_, level) => [(side === 'bid' ? 99 - level / 100 : 101 + level / 100).toFixed(2), String(1000 + sequence), '0', '1'])
    transport.send({ instId, channel: 'books' }, { bids: levels('bid'), asks: levels('ask'), seqId: sequence, prevSeqId: sequence === 1 ? -1 : sequence - 1, ts }, sequence === 1 ? 'snapshot' : 'update')
    messages += 3
  }
  await waitFor(() => service.publicRealtime.getTelemetry().receivedEvents >= before + ids.length * 3, 'native market receive barrier')
  await service.publicRealtime.whenIdle()
  // Await the actual 100ms coalescing deadline rather than invoking internals.
  await waitFor(() => service.streamQualifications.size === 0 && !service.streamQualificationTimer && service.streamEvaluations.size === 0, 'qualification batch')
  // Input rate is a fixture property; removing redundant qualification must
  // not turn this into a faster producer or shift deferred writes outside it.
  const remaining = 100 - (performance.now() - started)
  if (remaining > 0) await delay(remaining)
}
try {
  await service.ready; await store.appendCandles(seedRows)
  service.installInstruments(new Map(ids.map(instId => [instId, { instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '1', ctMult: '1', ctValCcy: instId.split('-')[0], ruleType: 'normal' }])))
  service.publicRealtime.start()
  await waitFor(() => service.publicRealtime.getState().status === 'live', 'all130 subscriptions')
  for (let index = 0; index < config.warmup; index++) await sendRound()
  await waitFor(() => service.backgroundTasks.size === 0 && service.preparedCharts.liveSeeds.size === 0, 'warm catalog/history projections')
  for (let index = 0; index < config.warmup; index++) buildIndicatorSeries(source)
  for (let index = 0; index < config.warmup; index++) await service.preparedCharts.calculate(source, 300000, 'foreground')
  await delay(300); await flushOperationRecording()
  const business = await measure('backendEndToEnd', async () => {
  const CPU = await measure('cpu', async () => { let checksum = 0; for (let index = 0; index < config.cycles; index++) { const result = buildIndicatorSeries(source); checksum += result.bars.at(-1).ema; await turn() } return checksum })
  const WORKER = await measure('preparedWorker', async () => { let checksum = 0; for (let index = 0; index < config.cycles; index++) { const result = await service.preparedCharts.calculate(source, 300000, 'foreground'); checksum += result.bars.at(-1).ema } return checksum })
  const DATABASE = await measure('databaseWorker', async () => {
    let checksum = 0, written = 0
    for (let index = 0; index < Math.max(2, Math.floor(config.cycles / 4)); index++) {
      written += await store.appendCandles(Array.from({ length: 128 }, (_, offset) => candle('ARCHIVE-USDT-SWAP', '5m', 1700000100000 + (index * 128 + offset) * 300000, offset)))
      const rows = await Promise.all(ids.map(instrument => store.candles({ instrument, timeframe: '5m', through: epoch, limit: 16, order: 'desc' }, 'foreground')))
      checksum += rows.reduce((sum, values) => sum + values.reduce((total, row) => total + row.close, 0), 0)
    }
    return { checksum, written }
  })
  const before = messages
  const profiler = config.profile ? new Session() : undefined
  const profileCall = method => new Promise((resolve, reject) => profiler.post(method, (error, result) => error ? reject(error) : resolve(result)))
  if(profiler){profiler.connect();await profileCall('Profiler.enable');await profileCall('Profiler.start')}
  await measure('nativeMarket', async () => { for (let index = 0; index < config.cycles; index++) await sendRound() })
  if(profiler){const {profile}=await profileCall('Profiler.stop');profiler.disconnect();await writeFile(join(directory,'native-market.cpuprofile'),JSON.stringify(profile))}
  const rows = service.listRowsFor('15m')
  assert.equal(rows.length, config.contracts); assert.equal(service.publicRealtime.getTelemetry().rejectedEvents, 0)
  assert.deepEqual(transport.errors, []); assert.equal(unexpectedRequests, 0, 'The warmed workload must not reacquire available history.')
  await measure('durableFlush', () => flushOperationRecording())
  const business = { CPU, WORKER, DATABASE, contracts: rows.length, finalPrices: rows.map(row => [row.instId, row.lastPrice]).sort(), marketMessages: messages - before }
  await service.dispose(); await store.close(); await transport.close(); await closeOperationRecording()
  return business
  })
  let journalBytes = 0
  if (process.env.PERPETUAL_SWAP_OPERATION_DIR) for (const file of await readdir(process.env.PERPETUAL_SWAP_OPERATION_DIR)) if (/\.jsonl(?:\.gz)?$/.test(file)) journalBytes += (await stat(join(process.env.PERPETUAL_SWAP_OPERATION_DIR, file))).size
  const runtime = { mode: process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1' ? 'electron-as-node' : 'node',
    node: process.version, v8: process.versions.v8, electron: process.versions.electron ?? null, executable: process.execPath }
  console.log(JSON.stringify({ business, metrics, journalBytes, runtime, parameters: { contracts: config.contracts, cycles: config.cycles, warmup: config.warmup, bookLevels: 400, nativeTransport: 'WebSocket', database: 'SQLite WAL workers',businessClock: 'fixed midperiod epoch plus monotonic elapsed time',warmupDrainMS:300,memorySampling:memorySampler.snapshot() } }))
} catch (error) {
  await Promise.allSettled([service.dispose(), store.close(), transport.close()]); await closeOperationRecording().catch(() => {}); throw error
}
