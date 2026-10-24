import { onOperationMessage, runWorkerInitialization } from './worker-operations.js'
import { parentPort, workerData, threadId } from 'node:worker_threads'
import { join } from 'node:path'
import { MetadataStore } from './metadata-store.js'
import { MarketStore } from './market-store.js'
import { MarketService } from './market-service.js'
import { ChartNotificationEncoder } from './chart-notifications.js'
import { createChartAcquisitionFixture, createChartColdBoundaryFixture, seedCachedListProjection, seedChartScrollBenchmark, seedHistoricalStatisticsBoundary, seedInstrumentNavigationBenchmark } from '../e2e-fixtures.js'
import { backgroundArchiveRows, seedMarketResources, startBackgroundArchive } from '../market-resource-fixtures.js'

let metadata, store, service, preferences, sourceProbe
let resourceFixture, acquisitionFixture, coldBoundaryFixture
const emit = (name, value) => parentPort.postMessage({ type: 'event', name, value })
const offline = async (_input, { signal } = {}) => {
  if (workerData.e2eLiveRefresh) await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Request cancelled.')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, 10_000)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
  return new Response(JSON.stringify({ code: '0', data: [] }))
}
// Exercise the production parsers and native transports against an isolated
// loopback exchange. This fixture is unavailable outside the E2E runtime.
function nativeExchangeFixture() {
  if (!workerData.testMode) return null
  const httpOrigin = process.env.PERPETUAL_SWAP_E2E_HTTP_ORIGIN
  const socketOrigin = process.env.PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN
  if (!httpOrigin && !socketOrigin) return null
  const validate = (value, protocol) => {
    const origin = new URL(value)
    if (origin.protocol !== protocol || !['127.0.0.1', '[::1]'].includes(origin.hostname)
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      throw new TypeError('Native exchange fixtures require a loopback origin with the expected protocol.')
    }
    return origin
  }
  const http = validate(httpOrigin, 'http:'), socket = validate(socketOrigin, 'ws:')
  return {
    fetcher: (input, options) => {
      const source = new URL(input)
      if (source.origin !== 'https://www.okx.com' || !source.pathname.startsWith('/api/v5/')) throw new TypeError('Unsupported exchange fixture HTTP endpoint.')
      return fetch(new URL(`${source.pathname}${source.search}`, http), options)
    },
    webSocketFactory: input => {
      const source = new URL(input)
      if (source.origin !== 'wss://ws.okx.com' || !['/ws/v5/public', '/ws/v5/business'].includes(source.pathname)
        || source.search || source.hash) throw new TypeError('Unsupported exchange fixture WebSocket endpoint.')
      return new WebSocket(new URL(source.pathname, socket))
    },
  }
}
const initialize = runWorkerInitialization('market-backend', async () => {
  metadata = await MetadataStore.open(workerData.userData, { legacySettingsPath: join(workerData.userData, 'settings.json') })
  preferences = metadata.getSettings().preferences
  store = await MarketStore.open(join(workerData.userData, 'MarketData'))
  const exchange = nativeExchangeFixture()
  service = new MarketService(store, () => preferences, exchange?.fetcher ?? (workerData.testMode ? offline : fetch),
    !workerData.testMode || Boolean(exchange), { metadata, ...(exchange ? { webSocketFactory: exchange.webSocketFactory } : {}) })
  await service.ready
  const notifications = new ChartNotificationEncoder()
  service.subscribePreparedCharts(frame => emit('chart', notifications.encode(frame)))
  service.subscribeMarket(() => emit('market'))
  service.subscribeAudit(report => emit('audit', report))
  service.subscribeHistoryDownload(report => emit('history-download', report))
  if (workerData.e2eLiveRefresh) void service.refresh().catch(error => console.error(error))
  parentPort.postMessage({ type: 'ready' })
})

async function request(value) {
  if (value.preferences) {
    if (value.preferences.action === 'update') {
      const previous = preferences
      preferences = metadata.updateSettings(value.preferences.values).preferences
      await service.reconfigure(previous)
    }
    return preferences
  }
  if (value.snapshot) return service.snapshot(value.snapshot)
  if (value.dataAudit) return service.dataAuditRequest(value.dataAudit)
  if (value.historyDownload) return service.historyDownloadRequest(value.historyDownload)
  if (value.chartFocus || value.chartWindow || value.chartLocal || value.chartHistory) {
    if (service.closing || service.disposed) throw new Error('Market service is closed.')
    const task = service.ready.then(() => {
      if (value.chartFocus) { service.preparedCharts.setFocus(value.chartFocus.target, value.chartFocus.id); return { ok: true } }
      const { instId, timeframe, endHour, historyBars, focusId } = value.chartWindow ?? value.chartLocal ?? value.chartHistory
      if (value.chartWindow) return service.preparedCharts.prepare(instId, timeframe, endHour, historyBars, { focusId })
      if (value.chartLocal) return service.preparedCharts.local(instId, timeframe)
      return service.preparedCharts.localHistory(instId, timeframe, endHour)
    })
    service.barTasks.add(task)
    return task.finally(() => service.barTasks.delete(task))
  }
  if (value.chartUniverse) return service.preparedCharts.residentFrames()
  if (value.analysisSettings) {
    const input = value.analysisSettings
    if (input.action === 'save') metadata.updateAnalysisSettings({ model: input.model, apiKey: input.apiKey })
    if (input.action === 'removeKey') metadata.updateAnalysisSettings({ apiKey: '' })
    const current = metadata.getAnalysisSettings()
    return { model: current.model ?? '', hasAPIKey: Boolean(current.apiKey) }
  }
  if (value.e2e && workerData.testMode) {
    const input = value.e2e
    switch (input.action) {
      case 'smokeStatus': return { userData: workerData.userData, backendThreadId: threadId,
        preparedWorkerThreadId: service.preparedCharts.worker?.threadId ?? service.preparedCharts.workers?.[0]?.threadId ?? null }
      case 'seedCandles': return { written: await store.appendCandles(input.candles) }
      case 'readCandles': return store.candles(input)
      case 'seedCachedListProjection': return seedCachedListProjection(store, service)
      case 'seedChartScrollBenchmark': return seedChartScrollBenchmark(store, service)
      case 'seedHistoricalStatisticsBoundary': return seedHistoricalStatisticsBoundary(store, service)
      case 'seedInstrumentNavigationBenchmark': return seedInstrumentNavigationBenchmark(store, service)
      case 'settings': return preferences
    }
  }
  throw new Error('Unsupported market backend request.')
}

async function probe(input) {
  if (!workerData.testMode) throw new Error('Backend probes are unavailable outside tests.')
  if (input.action === 'persistCandles') {
    for (const rows of Map.groupBy(input.candles, row => row.instrument).values()) await service.persistCandles(rows[0].instrument, rows, { projectList: false })
    return { ok: true }
  }
  if (input.action === 'preparedDiagnostics') {
    const pipeline = service.preparedCharts
    const state = value => value ? { rows: value.rows.size, indicators: value.indicators.size, generation: value.generation,
      calculating: Boolean(value.calculation), indicatorVersion: value.indicatorVersion, latestHour: value.latestHour } : null
    return { tasks: [...pipeline.candidateTasks.keys()].map(value => value.key), queue: pipeline.candidateQueue.map(value => value.key),
      seeds: [...pipeline.liveSeeds.keys()], sources: [...pipeline.sourceTasks.values()].map(value => ({ key: value.seriesKey, source: value.source, from: value.from, through: value.through })),
      series: [...pipeline.universe.keys()].map(key => ({ key, compact: state(pipeline.liveStates.get(key)), history: state(pipeline.series.get(key)),
        cached: pipeline.cached(key)?.indicatorState, cachedGeneration: pipeline.cached(key)?.generation })) }
  }
  if (input.action === 'seedChartScrollBenchmark') return seedChartScrollBenchmark(store, service, { instId: input.instId })
  if (input.action === 'coldBoundaryInstall') {
    coldBoundaryFixture?.remove()
    coldBoundaryFixture = await createChartColdBoundaryFixture(store, service, input)
    return coldBoundaryFixture.fixture
  }
  if (input.action === 'coldBoundaryRead') return coldBoundaryFixture?.read() ?? null
  if (input.action === 'coldBoundaryRelease') { coldBoundaryFixture?.release(); return { ok: true } }
  if (input.action === 'coldBoundaryRemove') { coldBoundaryFixture?.remove(); coldBoundaryFixture = null; return { ok: true } }
  if (input.action === 'acquisitionInstall') {
    acquisitionFixture = await createChartAcquisitionFixture(store, service, input)
    return acquisitionFixture.fixture
  }
  if (input.action === 'acquisitionStep') {
    if (!acquisitionFixture) throw new Error('Chart acquisition fixture is not installed.')
    return acquisitionFixture.step(input.source)
  }
  if (input.action === 'scaleSeed') {
    const previous = preferences
    preferences = metadata.updateSettings({ liquidity: Object.fromEntries(Object.entries(preferences.liquidity).map(([key, value]) => [key, { ...value, enabled: false }])) }).preferences
    await service.reconfigure(previous)
    resourceFixture = await seedMarketResources(store, service, input)
    return { ...resourceFixture.fixture, backendThreadId: threadId, diagnostics: store.getDiagnostics() }
  }
  if (input.action === 'scaleTick') { if (!resourceFixture) throw new Error('Resource benchmark is not seeded.'); return resourceFixture.tick(input) }
  if (input.action === 'scaleStop') { if (!resourceFixture) throw new Error('Resource benchmark is not seeded.'); return resourceFixture.stop() }
  if (input.action === 'persistNavigationCatalog') {
    const lease = { observedAt: Date.now(), expiresAt: Date.now() + 90_000 }
    await service.persistCatalog([...service.catalog.values()].map(entry => ({ ...entry, ...lease,
      instrumentObservation: lease, observations: { ticker: { value: entry.ticker, ...lease } } })))
    return service.catalog.size
  }
  if (input.action === 'sourceInstall') {
    const original = service.get.bind(service)
    let release
    const released = new Promise(resolve => { release = resolve })
    sourceProbe = { original, requests: [], hold: false, release }
    service.get = async (path, parameters, ...rest) => {
      if (parameters?.instId === input.instId) {
        sourceProbe.requests.push({ path, parameters: { ...parameters } })
        if (sourceProbe.hold) await released
      }
      return original(path, parameters, ...rest)
    }
    return { ok: true }
  }
  if (input.action === 'sourceHold') { if (sourceProbe) sourceProbe.hold = input.hold; return { ok: true } }
  if (input.action === 'sourceRead') return sourceProbe?.requests ?? []
  if (input.action === 'sourceRelease') { sourceProbe?.release(); return { ok: true } }
  if (input.action === 'sourceRemove') {
    sourceProbe?.release()
    if (sourceProbe) service.get = sourceProbe.original
    sourceProbe = null
    return { ok: true }
  }
  if (input.action === 'diagnostics') return { backendThreadId: threadId, tasks: service.history.sync.listTasks(), writeMetrics: store.getWriteMetrics() }
  if (input.action === 'backgroundStart') return startBackgroundArchive(store, service)
  if (input.action === 'backgroundStatus') {
    const audit = await service.dataAuditRequest({ action: 'status' }), tasks = service.history.sync.listTasks()
    const result = { source: 'offline synthetic source; worker backend, HistorySync and SQLite WAL',
      audit: { phase: audit.phase, progress: audit.progress }, tasks: tasks.length,
      writtenRecords: tasks.reduce((sum, task) => sum + (task.writtenRecords ?? 0), 0), archiveRows: await backgroundArchiveRows(store), writeMetrics: store.getWriteMetrics() }
    await service.dataAuditRequest({ action: 'cancel' })
    return result
  }
  throw new Error('Unsupported backend probe.')
}

onOperationMessage(parentPort, 'market-backend', async ({ id, method, value }) => {
  try {
    await initialize
    let result
    if (method === 'request') result = await request(value)
    else if (method === 'credentials') result = metadata.getAnalysisSettings().apiKey ?? ''
    else if (method === 'probe') result = await probe(value)
    else if (method === 'dispose') {
      sourceProbe?.release()
      const failures = []
      for (const close of [() => service.dispose(), () => store.close(), () => metadata.close()]) {
        try { await close() } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, `Market backend shutdown failed: ${failures.map(error => error?.message ?? String(error)).join('; ')}`)
      result = { ok: true }
    } else throw new Error('Unsupported backend operation.')
    return { id, value: result }
  } catch (error) { return { id, error: { message: error.message, code: error.code } } }
}, { closeWhen: message => message.method === 'dispose' })
initialize.catch(error => parentPort.postMessage({ type: 'fatal', error: error.message }))
