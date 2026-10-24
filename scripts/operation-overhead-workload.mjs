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
const { isOperationJournal } = await moduleAt('electron/services/operation-journal.js')
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
  const clients = new Set(), errors = [], messageCounts = {}
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
  const send = (arg, data) => {
    let sent = 0
    for (const client of clients) if (client.subscriptions.has(`${arg.channel}:${arg.instId}`)) {
      client.socket.write(frame(JSON.stringify({ arg, data: [data] }))); sent++
    }
    assert.equal(sent, 1, 'Every deterministic market message must have exactly one native subscriber.')
    messageCounts[arg.channel] = (messageCounts[arg.channel] ?? 0) + sent
  }
  return { url: `ws://127.0.0.1:${server.address().port}/feed`, send, errors,
    get messages() { return Object.values(messageCounts).reduce((sum, count) => sum + count, 0) },
    get messageCounts() { return { ...messageCounts } },
    async close() { for (const { socket } of clients) socket.destroy(); await new Promise(resolve => server.close(resolve)) } }
}
const ids = Array.from({ length: config.contracts }, (_, index) => `ASSET${index}-USDT-SWAP`)
const nativePeriods = [['5m', 300000], ['15m', 900000], ['1H', 3600000]]
const epoch = config.epoch, candle = (instrument, timeframe, timestamp, index) => ({ instrument, timeframe, timestamp,
  open: 100, high: 105, low: 95, close: 100 + (index % 17) / 100, volume: 100, baseVolume: 1, quoteVolume: 10000, confirmed: true })
const seedRows = ids.flatMap(id => nativePeriods.flatMap(([timeframe, step]) =>
  Array.from({ length: 300 }, (_, index) => candle(id, timeframe, Math.floor(epoch / step) * step - (300 - index) * step, index))))
const source = Array.from({ length: 4096 }, (_, index) => candle(ids[0], '5m', epoch + index * 300000, index))
const store = await MarketStore.open(join(directory, 'MarketData'))
const transport = await exchange()
const preferences = structuredClone(DEFAULT_PREFERENCES)
for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
// Measure the unfiltered catalog's price/OI updates. Disabled depth and
// slippage have no book demand; enabling one here changes the business work.
let unexpectedRequests = 0
const service = new MarketService(store, () => preferences, async () => { unexpectedRequests++; return new Response(JSON.stringify({ code: '0', data: [] })) }, false,
  { webSocketFactory: () => new WebSocket(transport.url) })
const waitFor = async (condition, description) => { const until = performance.now() + 30000; while (!condition()) { assert.ok(performance.now() < until, `Timed out: ${description}`); await delay(2) } }
let sequence = 0
const sendRound = async () => {
  const started = performance.now()
  sequence++
  const before = service.publicRealtime.getTelemetry().receivedEvents
  const sentBefore = transport.messages
  for (const [index, instId] of ids.entries()) {
    const price = 100 + index / 10 + sequence / 1000, ts = String(Date.now())
    const ticker = service.publicRealtime.subscriptions.get(`tickers:${instId}`)
    const openInterest = service.publicRealtime.subscriptions.get(`open-interest:${instId}`)
    if (ticker) transport.send(ticker, { instId, last: String(price), bidPx: String(price - .01), askPx: String(price + .01), ts })
    if (openInterest) transport.send(openInterest, { instId, oi: String(10000 + sequence), oiUsd: '10000000', ts })
  }
  const sent = transport.messages - sentBefore
  await waitFor(() => service.publicRealtime.getTelemetry().receivedEvents >= before + sent, 'native market receive barrier')
  await service.publicRealtime.whenIdle()
  assert.equal(service.publicRealtime.getTelemetry().receivedEvents, before + sent, 'Every sent market update must be received exactly once.')
  // Await the actual 100ms coalescing deadline rather than invoking internals.
  await waitFor(() => service.streamQualifications.size === 0 && !service.streamQualificationTimer && service.streamEvaluations.size === 0, 'qualification batch')
  // Input rate is a fixture property; removing redundant qualification must
  // not turn this into a faster producer or shift deferred writes outside it.
  const remaining = 100 - (performance.now() - started)
  if (remaining > 0) await delay(remaining)
}
try {
  await service.ready; await store.appendCandles(seedRows)
  // This workload measures warmed native traffic, not first acquisition. Seed
  // successful-empty independent statistics for every native period before
  // backend qualification admits automatic preparation in either paired mode.
  for (const instrument of ids) for (const [timeframe, step] of nativePeriods) {
    const through = Math.floor(epoch / step) * step - step, from = through - 299 * step
    for (const source of ['oi', 'taker']) await store.appendStatistics({ instrument, timeframe, source, from, through, values: [], expiresAt: Date.now() + 600000 })
  }
  service.installInstruments(new Map(ids.map(instId => [instId, { instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '1', ctMult: '1', ctValCcy: instId.split('-')[0], ruleType: 'normal' }])))
  service.publicRealtime.start()
  await waitFor(() => service.publicRealtime.getState().status === 'live', 'all native subscriptions')
  const subscribedChannels = [...new Set([...service.publicRealtime.subscriptions.values()].map(value => value.channel))].sort()
  assert.ok(!subscribedChannels.includes('books'), 'Disabled depth/slippage must not create book demand.')
  for (let index = 0; index < config.warmup; index++) await sendRound()
  // Qualified membership owns the all-period universe. A selected viewport is
  // a separate backend intent; local/resident reads never start that lifecycle.
  assert.deepEqual([...service.catalog.keys()].sort(), [...ids].sort())
  const pipeline = service.preparedCharts
  pipeline.setFocus({ instId: ids[0], timeframe: '15m' }, 'overhead-workload')
  await pipeline.focus.task
  await waitFor(() => {
    const ready = new Set(pipeline.residentFrames().frames.filter(frame => frame.bars.length === 96 && frame.indicatorState === 'ready'
      && frame.priceState === 'ready' && frame.oiState === 'unavailable' && frame.takerState === 'unavailable').map(frame => `${frame.instId}:${frame.timeframe}`))
    return ids.every(instId => nativePeriods.every(([timeframe]) => ready.has(`${instId}:${timeframe}`)))
      && service.backgroundTasks.size === 0 && pipeline.candidateTasks.size === 0 && pipeline.candidateQueue.length === 0
      && pipeline.liveSeeds.size === 0 && pipeline.sourceTasks.size === 0 && pipeline.calculations.size === 0
  }, 'backend-owned preparation of every qualified native frame')
  const preparedFrames = pipeline.residentFrames().frames.length
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
  const before = transport.messages, countsBefore = transport.messageCounts
  const profiler = config.profile ? new Session() : undefined
  const profileCall = method => new Promise((resolve, reject) => profiler.post(method, (error, result) => error ? reject(error) : resolve(result)))
  if(profiler){profiler.connect();await profileCall('Profiler.enable');await profileCall('Profiler.start')}
  await measure('nativeMarket', async () => { for (let index = 0; index < config.cycles; index++) await sendRound() })
  if(profiler){const {profile}=await profileCall('Profiler.stop');profiler.disconnect();await writeFile(join(directory,'native-market.cpuprofile'),JSON.stringify(profile))}
  const rows = service.listRowsFor()
  assert.equal(rows.length, config.contracts); assert.equal(service.publicRealtime.getTelemetry().rejectedEvents, 0)
  assert.deepEqual(transport.errors, []); assert.equal(unexpectedRequests, 0, 'The warmed workload must not reacquire available history.')
  await measure('durableFlush', () => flushOperationRecording())
  const marketMessagesByChannel = Object.fromEntries(Object.entries(transport.messageCounts).map(([channel, count]) => [channel, count - (countsBefore[channel] ?? 0)]))
  const business = { CPU, WORKER, DATABASE, contracts: rows.length, preparedFrames, finalPrices: rows.map(row => [row.instId, row.lastPrice]).sort(), marketMessages: transport.messages - before, marketMessagesByChannel }
  await service.dispose(); await store.close(); await transport.close(); await closeOperationRecording()
  return business
  })
  let journalBytes = 0
  if (process.env.PERPETUAL_SWAP_OPERATION_DIR) for (const file of await readdir(process.env.PERPETUAL_SWAP_OPERATION_DIR)) if (isOperationJournal(file)) journalBytes += (await stat(join(process.env.PERPETUAL_SWAP_OPERATION_DIR, file))).size
  const runtime = { mode: process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1' ? 'electron-as-node' : 'node',
    node: process.version, v8: process.versions.v8, electron: process.versions.electron ?? null, executable: process.execPath }
  console.log(JSON.stringify({ business, metrics, journalBytes, runtime, parameters: { contracts: config.contracts, cycles: config.cycles, warmup: config.warmup,
    liquidityFilters: Object.fromEntries(Object.entries(preferences.liquidity).map(([name, rule]) => [name, rule.enabled])),
    subscribedChannels, inputChannels: Object.keys(transport.messageCounts).sort(), nativePeriods: nativePeriods.map(([timeframe]) => timeframe),
    nativeTransport: 'WebSocket', database: 'SQLite WAL workers',businessClock: 'fixed midperiod epoch plus monotonic elapsed time',warmupDrainMS:300,memorySampling:memorySampler.snapshot() } }))
} catch (error) {
  await Promise.allSettled([service.dispose(), store.close(), transport.close()]); await closeOperationRecording().catch(() => {}); throw error
}
