import { setMaxListeners } from 'node:events'

const intervals = { '5m': 300_000, '15m': 900_000, '1H': 3_600_000 }

export function resourceCandle(instrumentIndex, timeframe, index, periods, asOf) {
  const interval = intervals[timeframe], timestamp = Math.floor(asOf / interval) * interval - (periods - index) * interval
  const offset = { '5m': 0, '15m': 10, '1H': 20 }[timeframe]
  const close = 100 + instrumentIndex * 3 + offset + index * 0.01, volume = 100 + index % 7
  return { instrument: `SCALE${String(instrumentIndex).padStart(3, '0')}-USDT-SWAP`, timeframe, timestamp,
    open: close - 0.02, high: close + 0.06, low: close - 0.05, close,
    volume, baseVolume: volume, quoteVolume: volume * close, statisticsVersion: 8, confirmed: true }
}

/** Synthetic intake only; storage, scheduler, service, IPC, React and SVG are real. */
export async function seedMarketResources(store, service, { count = 287, periods = 320 } = {}) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000 || !Number.isSafeInteger(periods) || periods < 300 || periods > 4096) throw new Error('Invalid resource benchmark size.')
  const startedAt = Date.now(), asOf = startedAt, timeframes = Object.keys(intervals), instIds = [], catalog = []
  const controller = new AbortController(), originalFetcher = service.fetcher
  setMaxListeners(0, controller.signal)
  let heldStatistics = 0, tickCount = 0, nativeUpdates = 0
  service.fetcher = async (input, options = {}) => {
    const url = new URL(input), signal = options.signal
    if (url.pathname.includes('/rubik/stat/') && url.searchParams.get('instId')?.startsWith('SCALE')) {
      heldStatistics += 1
      return new Promise((_resolve, reject) => {
        const abort = () => { signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', abort); reject(signal?.reason ?? controller.signal.reason ?? new Error('Synthetic statistics gate cancelled.')) }
        if (signal?.aborted || controller.signal.aborted) abort()
        else { signal?.addEventListener('abort', abort, { once: true }); controller.signal.addEventListener('abort', abort, { once: true }) }
      })
    }
    return originalFetcher(input, options)
  }
  for (let index = 0; index < count; index += 1) {
    const instId = `SCALE${String(index).padStart(3, '0')}-USDT-SWAP`, rows = []
    instIds.push(instId)
    const instrument = { instId, instType: 'SWAP', ctType: 'linear', instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '1', ctMult: '1', ctValCcy: `SCALE${index}`, ruleType: 'normal', listTime: String(asOf - (periods + 200) * 3_600_000) }
    service.instruments.set(instId, instrument)
    for (const timeframe of timeframes) for (let bar = 0; bar < periods; bar += 1) rows.push(resourceCandle(index, timeframe, bar, periods, asOf))
    await store.appendCandles(rows, 'background')
    service.cacheRankingCandles(instId, rows.filter(row => row.timeframe === '5m'))
    const lease = { observedAt: startedAt, expiresAt: startedAt + 10 * 60_000 }
    const price = resourceCandle(index, '15m', periods - 1, periods, asOf).close
    const ticker = { instId, last: String(price), bidPx: String(price - 0.01), askPx: String(price + 0.01), open24h: String(price - 1), low24h: String(price - 2), high24h: String(price + 2), volCcy24h: '500000', ts: String(startedAt) }
    service.instrumentObservations.set(instId, lease)
    const observations = { ticker: { value: ticker, ...lease } }
    service.observations.set(instId, observations)
    const config = service.prefs().liquidity, record = service.observedCandidate(instrument, config, JSON.stringify(config), observations, {}, startedAt)
    if (record.status !== 'verified') throw new Error('Resource fixture requires disabled liquidity conditions.')
    catalog.push(record)
  }
  service.candidateIDs = new Set(instIds)
  service.catalogUpdatedAt = Date.now(); service.catalogSource = 'live'
  service.replaceCatalog(catalog)
  service.error = ''; service.lastRefreshAt = Date.now()
  const tick = async ({ sequence = tickCount + 1, focusInstId = instIds[0], timeframe = '15m' } = {}) => {
    if (!Number.isSafeInteger(sequence) || sequence <= tickCount) throw new Error('Synthetic updates must advance monotonically.')
    tickCount = sequence
    const receivedAt = Date.now(), updates = []
    let expected = null
    for (let index = 0; index < count; index += 1) {
      const instId = instIds[index], price = resourceCandle(index, '15m', periods, periods, asOf).close + sequence * 0.001
      service.receivePublicObservation(instId, 'ticker', { instId, last: String(price), bidPx: String(price - 0.01), askPx: String(price + 0.01), ts: String(receivedAt) }, { receivedAt, acknowledged: false })
      for (const frame of timeframes) {
        const seed = resourceCandle(index, frame, periods, periods, asOf), close = seed.close + sequence * 0.001
        const value = { ...seed, high: Math.max(seed.high, close), close, volume: 100 + sequence, baseVolume: 100 + sequence, quoteVolume: close * (100 + sequence), confirmed: false }
        updates.push(Promise.resolve(service.setLive(instId, frame, value, { receivedAt })))
        if (instId === focusInstId && frame === timeframe) expected = close
      }
    }
    await Promise.all(updates)
    nativeUpdates += updates.length
    return { receivedAt, sequence, expected, instId: focusInstId, timeframe, nativeUpdates: updates.length }
  }
  return {
    fixture: { instIds, count, periods, timeframes, intervals, asOf, rowsSeeded: count * periods * timeframes.length, seedStartedAt: startedAt, seedCompletedAt: Date.now(), source: 'Synthetic native intake; external WebSocket transport and OKX network are not measured.' },
    tick,
    async stop() {
      controller.abort(new Error('Resource benchmark finished.'))
      service.fetcher = originalFetcher
      const counts = []
      for (const instId of instIds) for (const timeframe of timeframes) counts.push((await store.coverage(instId, timeframe)).count)
      return { heldStatistics, ticks: tickCount, nativeUpdates, actualRows: counts.reduce((sum, value) => sum + value, 0), minimumRowsPerSeries: Math.min(...counts),
        indicatorWorkerThreadIds: service.preparedCharts.workers.map(slot => slot.worker?.threadId ?? slot.threadId),
        residentChartSeries: service.preparedCharts.series.size, liveProjectionSeeds: service.preparedCharts.liveStates.size,
        cache: { estimatedResidentBytes: [...service.preparedCharts.series.values()].reduce((sum, state) => sum + (state.byteSize ?? 0), 0),
          configuredResidentBytes: service.preparedCharts.maxBytes, configuredResidentSeries: service.preparedCharts.maxSeries,
          residentSourceRows: [...service.preparedCharts.series.values()].reduce((sum, state) => sum + state.rows.size, 0),
          liveSeedSourceRows: [...service.preparedCharts.liveStates.values()].reduce((sum, state) => sum + state.rows.size, 0),
          snapshots: service.preparedCharts.snapshots.size, note: 'Byte accounting estimates serialized UTF-16 values; process working sets are reported separately.' },
        queuedCalculations: service.preparedCharts.calculationQueue.length, diagnostics: store.getDiagnostics() }
    },
  }
}

export const backgroundArchiveRows = async store => (await Promise.all(Object.keys(intervals).map(timeframe => store.coverage('LOAD-USDT-SWAP', timeframe))))
  .reduce((sum, value) => sum + value.count, 0)

/** Admit real archive work before starting the timed renderer measurements. */
export async function startBackgroundArchive(store, service, { timeoutMS = 180_000, pollMS = 100 } = {}) {
  const initialRows = await backgroundArchiveRows(store)
  const original = service.get.bind(service)
  service.get = async (path, parameters, ...rest) => {
    if (parameters?.instId !== 'LOAD-USDT-SWAP') return original(path, parameters, ...rest)
    if (path !== '/market/history-candles') return []
    const step = intervals[parameters.bar]
    const end = Math.floor((Number(parameters.after) - 1) / step) * step
    return Array.from({ length: Number(parameters.limit) }, (_, index) => [String(end - index * step), '100', '102', '99', '101', '100', '100', '10100', '1'])
  }
  service.instruments.set('LOAD-USDT-SWAP', { instId: 'LOAD-USDT-SWAP' })
  const asOf = Date.now()
  for (const [timeframe, step] of Object.entries(intervals)) {
    const through = Math.floor(asOf / step) * step - step
    await service.history.sync.enqueue({ instrument: 'LOAD-USDT-SWAP', timeframe, source: 'candles',
      from: through - 30 * 86_400_000 + step, through, priority: 'background' })
  }
  await service.dataAuditRequest({ action: 'start' })
  // Enqueueing is not evidence of load: a native candle boundary can put
  // hundreds of existing series ahead of LOAD in the fair background queue.
  const deadline = performance.now() + timeoutMS
  while (true) {
    service.shutdownController.signal.throwIfAborted()
    const writtenRecords = await backgroundArchiveRows(store)
    if (writtenRecords > initialRows) return { ok: true, initialRows, writtenRecords }
    if (performance.now() >= deadline) throw new Error(`Background archive readiness timed out after ${timeoutMS} ms without a new LOAD candle commit.`)
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMS, Math.max(1, deadline - performance.now()))))
  }
}
