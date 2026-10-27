import { onOperationMessage, runWorkerInitialization } from './worker-operations.js'
import { parentPort, workerData, threadId } from 'node:worker_threads'
import { join } from 'node:path'
import { MetadataStore } from './metadata-store.js'
import { MarketStore } from './market-store.js'
import { MarketService } from './market-service.js'
import { drainCallbackProbeObserverCostMonotonicUS, monotonicMicroseconds, validateMarketTrafficDrainWindow, wrapAcceptedCallback } from './market-traffic-callback-probe.js'
import { ChartNotificationEncoder } from './chart-notifications.js'
import { createChartAcquisitionFixture, createChartColdBoundaryFixture, seedCachedListProjection, seedChartScrollBenchmark, seedHistoricalStatisticsBoundary, seedInstrumentNavigationBenchmark } from '../e2e-fixtures.js'
import { backgroundArchiveRows, seedMarketResources, startBackgroundArchive } from '../market-resource-fixtures.js'

let metadata, store, service, preferences, sourceProbe
let resourceFixture, acquisitionFixture, coldBoundaryFixture
let coldBoundaryOperation = Promise.resolve()
const coldBoundaryLifecycle = operation => {
  const result = coldBoundaryOperation.then(operation)
  coldBoundaryOperation = result.then(() => undefined, () => undefined)
  return result
}
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
      case 'readStatistics': return store.statistics(input)
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
      focus: pipeline.focus ? { instId: pipeline.focus.instId, timeframe: pipeline.focus.timeframe } : null,
      catalog: [...service.catalog.keys()], listRemovals: [...service.listRemovals.keys()],
      seeds: [...pipeline.liveSeeds.keys()], sources: [...pipeline.sourceTasks.values()].map(value => ({ key: value.seriesKey, source: value.source, from: value.from, through: value.through })),
      series: [...pipeline.universe.keys()].map(key => ({ key, compact: state(pipeline.liveStates.get(key)), history: state(pipeline.series.get(key)),
        cached: pipeline.cached(key)?.indicatorState, cachedGeneration: pipeline.cached(key)?.generation })) }
  }
  if (input.action === 'seedChartScrollBenchmark') return seedChartScrollBenchmark(store, service, { instId: input.instId })
  if (input.action === 'coldBoundaryInstall') return coldBoundaryLifecycle(async () => {
    await coldBoundaryFixture?.remove()
    coldBoundaryFixture = null
    coldBoundaryFixture = await createChartColdBoundaryFixture(store, service, input)
    return coldBoundaryFixture.fixture
  })
  if (input.action === 'coldBoundaryRead') return coldBoundaryFixture?.read() ?? null
  if (input.action === 'coldBoundaryRelease') { coldBoundaryFixture?.release(); return { ok: true } }
  if (input.action === 'coldBoundaryRemove') return coldBoundaryLifecycle(async () => {
    const previous = coldBoundaryFixture
    await previous?.remove()
    coldBoundaryFixture = null
    return { ok: true, disposed: previous?.read() ?? null }
  })
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
  if (input.action === 'scaleLoadStart') { if (!resourceFixture) throw new Error('Resource benchmark is not seeded.'); return resourceFixture.startLoad(input) }
  if (input.action === 'scaleLoadRead') { if (!resourceFixture) throw new Error('Resource benchmark is not seeded.'); return resourceFixture.readLoad(input) }
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
  if (input.action === 'marketTrafficEvidence') {
    if (input.phase === 'arm') {
      if (service.__marketTrafficEvidence) throw new Error('Market traffic receipt capture is already armed.')
      const candidateIDs = [...(service.candidateIDs ?? [])].sort()
      const eligibleIDs = [...service.listedUniverse].sort()
      const focusedInstrumentID = service.preparedCharts.focus?.instId ?? null
      const liquidity = service.prefs().liquidity
      const booksEnabled = liquidity.depth.enabled || liquidity.slippage.enabled
      const publicSubscriptions = service.publicRealtime.subscriptions
      const expectedSubscriptions = {
        tickers: candidateIDs,
        'open-interest': candidateIDs,
        books: booksEnabled ? [...(service.publicSubscriptionDemand?.books ?? [])].sort() : [],
        trades: candidateIDs.filter(instId => service.statisticsDemand(instId)).sort(),
        candle5m: [], candle15m: [], candle1H: [],
      }
      for (const { instId, timeframe } of service.realtime.subscriptions.values()) {
        const channel = `candle${timeframe}`
        expectedSubscriptions[channel] ??= []
        expectedSubscriptions[channel].push(instId)
      }
      for (const channel of ['candle5m', 'candle15m', 'candle1H']) expectedSubscriptions[channel].sort()
      const actualSubscriptions = {
        tickers: [], 'open-interest': [], books: [], trades: [], candle5m: [], candle15m: [], candle1H: [],
      }
      for (const { instId, channel } of publicSubscriptions.values()) if (channel !== 'instruments') actualSubscriptions[channel].push(instId)
      for (const { instId, timeframe } of service.realtime.subscriptions.values()) actualSubscriptions[`candle${timeframe}`].push(instId)
      for (const values of Object.values(actualSubscriptions)) values.sort()
      for (const channel of Object.keys(expectedSubscriptions)) {
        if (!actualSubscriptions[channel]) actualSubscriptions[channel] = []
        if (JSON.stringify(actualSubscriptions[channel]) !== JSON.stringify(expectedSubscriptions[channel])) {
          throw new Error(`Application ${channel} demand does not match its configured eligible/focus demand.`)
        }
      }
      if (booksEnabled && eligibleIDs.some(instId => !expectedSubscriptions.books.includes(instId))) {
        throw new Error('Configured depth/slippage checks require books for every eligible listed contract.')
      }
      const expectedTrades = [...new Set([...eligibleIDs, focusedInstrumentID].filter(Boolean))].sort()
      if (JSON.stringify(expectedSubscriptions.trades) !== JSON.stringify(expectedTrades)) {
        throw new Error('Configured trade statistics demand does not match listed contracts and chart focus.')
      }
      const capture = { expectedSubscriptions, actualSubscriptions,
        candidateIDs, eligibleIDs, focusedInstrumentID, booksEnabled, nativeIngressEvents: [], callbackEvents: [],
        callbackEventsByID: new Map(), probeObserverCostMonotonicUS: 0, ingressOptions: new Set(), restore: [] }
      const restoreCapture = () => {
        for (const restore of capture.restore.splice(0).reverse()) restore()
        if (service.__marketTrafficEvidence === capture) delete service.__marketTrafficEvidence
      }
      capture.restoreCapture = restoreCapture
      drainCallbackProbeObserverCostMonotonicUS()
      const installIngressObserver = options => {
        if (capture.ingressOptions.has(options)) return
        capture.ingressOptions.add(options)
        const previous = options.onMarketTrafficIngress
        const observer = (events, observerCostUS = 0) => {
          capture.probeObserverCostMonotonicUS += Number.isSafeInteger(observerCostUS) && observerCostUS >= 0 ? observerCostUS : 0
          if (Array.isArray(events)) capture.nativeIngressEvents.push(...events)
        }
        options.onMarketTrafficIngress = observer
        capture.restore.push(() => {
          if (options.onMarketTrafficIngress !== observer) return
          if (previous === undefined) delete options.onMarketTrafficIngress
          else options.onMarketTrafficIngress = previous
        })
      }
      const wrap = (options, name, channelFor) => {
        wrapAcceptedCallback(options, name, (args, timing) => {
          const evidence = channelFor(args)
          if (!evidence) return
          const events = evidence.context?.marketTrafficEvents
          if (timing.phase === 'entry') {
            if (!Array.isArray(events)) return
            const records = events.map(event => {
              if (event.channel !== evidence.channel || event.instId !== evidence.instId) return null
              const record = { ...event, callbackID: timing.callbackID,
                callbackEnteredAtMonotonicUS: timing.callbackEnteredAtMonotonicUS,
                callbackAcceptedAtMonotonicUS: null, receivedAt: evidence.context.receivedAt,
                fillCount: evidence.fillCount ?? 0 }
              capture.callbackEvents.push(record)
              return record
            })
            capture.callbackEventsByID.set(timing.callbackID, records.filter(Boolean))
          } else {
            for (const record of capture.callbackEventsByID.get(timing.callbackID) ?? []) {
              record.callbackAcceptedAtMonotonicUS = timing.callbackAcceptedAtMonotonicUS
            }
            capture.callbackEventsByID.delete(timing.callbackID)
          }
        }, capture.restore)
      }
      try {
        const publicMarket = service.publicRealtime
        const instruments = new Set()
        const instrumentChannels = { onTicker: 'tickers', onOpenInterest: 'open-interest', onBook: 'books' }
        const instrumentOptionForShard = options => {
          if (instruments.has(options)) return
          instruments.add(options)
          for (const [name, channel] of Object.entries(instrumentChannels)) instrumentCallbackForOptions(options, name, channel)
          instrumentCallbackForOptions(options, 'onTrades', 'trades')
        }
        function instrumentCallbackForOptions(options, name, channel) {
          installIngressObserver(options)
          wrap(options, name, ([instId, values, context]) => ({ channel, instId, context,
            ...(channel === 'trades' ? { fillCount: Array.isArray(values) ? values.length : 0 } : {}) }))
        }
        for (const market of [...publicMarket.shards, publicMarket.controlShard].filter(Boolean)) instrumentOptionForShard(market.options)
        const makeShard = publicMarket.makeShard
        const wrappedMakeShard = function (...args) {
          const market = makeShard.apply(this, args)
          instrumentOptionForShard(market.options)
          return market
        }
        publicMarket.makeShard = wrappedMakeShard
        capture.restore.push(() => { if (publicMarket.makeShard === wrappedMakeShard) publicMarket.makeShard = makeShard })
        installIngressObserver(service.realtime.options)
        wrap(service.realtime.options, 'onForming', ([row, context]) => ({
          channel: `candle${row?.timeframe}`, instId: row?.instrument, context,
        }))
        wrap(service.realtime.options, 'onConfirmed', ([row, context]) => ({
          channel: `candle${row?.timeframe}`, instId: row?.instrument, context,
        }))
        service.__marketTrafficEvidence = capture
        return { source: 'market-service accepted callbacks after native parsing', expectedSubscriptions, actualSubscriptions,
          marketDemand: { candidateIDs, eligibleIDs, focusedInstrumentID, booksEnabled } }
      } catch (error) {
        restoreCapture()
        throw error
      }
    }
    if (input.phase === 'end') {
      const capture = service.__marketTrafficEvidence
      if (!capture) throw new Error('Market traffic receipt capture was not armed.')
      const { sampleStartedAt, sampleEndedAt, sampleStartedMonotonicUS, sampleEndedMonotonicUS,
        drainDeadlineMonotonicUS } = input
      const snapshotCapture = () => {
        capture.probeObserverCostMonotonicUS += drainCallbackProbeObserverCostMonotonicUS()
        return { source: 'fixture socket write matched to native WebSocket handler entry and fulfilled production callback', sampleStartedAt, sampleEndedAt,
          sampleStartedMonotonicUS, sampleEndedMonotonicUS, drainDeadlineMonotonicUS,
          expectedSubscriptions: capture.expectedSubscriptions, actualSubscriptions: capture.actualSubscriptions,
          marketDemand: { candidateIDs: capture.candidateIDs, eligibleIDs: capture.eligibleIDs,
            focusedInstrumentID: capture.focusedInstrumentID, booksEnabled: capture.booksEnabled },
          applicationReceipts: { callbackEvents: capture.callbackEvents.map(event => ({ ...event })) },
          nativeIngressEvents: capture.nativeIngressEvents.map(event => ({ ...event })),
          probeObserverCostMonotonicUS: capture.probeObserverCostMonotonicUS }
      }
      try {
        if (!Number.isSafeInteger(sampleStartedAt) || !Number.isSafeInteger(sampleEndedAt) || sampleEndedAt <= sampleStartedAt) {
          throw new Error('Market traffic receipt capture requires the complete fixture sample window.')
        }
        validateMarketTrafficDrainWindow(input)
        while (monotonicMicroseconds() < drainDeadlineMonotonicUS) {
          const remainingMS = (drainDeadlineMonotonicUS - monotonicMicroseconds()) / 1_000
          await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.ceil(remainingMS))))
        }
        return snapshotCapture()
      } catch (error) {
        // Return a serializable failure together with the raw capture; worker
        // RPC errors preserve only message/stack and would discard this data.
        return { ...snapshotCapture(), captureError: { name: error.name, message: error.message } }
      } finally {
        capture.restoreCapture()
      }
    }
    throw new Error('Market traffic receipt capture phase must be arm or end.')
  }
  if (input.action === 'diagnostics') return { backendThreadId: threadId, tasks: service.history.sync.listTasks(),
    activeHistory: [...service.history.sync.active.values()].map(({ group }) => ({ instrument: group.instrument, timeframe: group.timeframe, source: group.source })),
    writeMetrics: store.getWriteMetrics() }
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
      for (const close of [() => coldBoundaryLifecycle(async () => { await coldBoundaryFixture?.remove(); coldBoundaryFixture = null }),
        () => service.dispose(), () => store.close(), () => metadata.close()]) {
        try { await close() } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, `Market backend shutdown failed: ${failures.map(error => error?.message ?? String(error)).join('; ')}`)
      result = { ok: true }
    } else throw new Error('Unsupported backend operation.')
    return { id, value: result }
  } catch (error) { return { id, error: { message: error.message, code: error.code } } }
}, { closeWhen: message => message.method === 'dispose' })
initialize.catch(error => parentPort.postMessage({ type: 'fatal', error: error.message }))
