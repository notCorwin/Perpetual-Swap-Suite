(() => {
  // Controlled active-page replay, identical in both shells. Real system
  // visibility is retained separately; this never claims physical presentation.
  const visibilityGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get
  const nativeVisibility = () => visibilityGetter.call(document)
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true })
  const clockOffsetMS = globalThis.__radarComparisonClockOffsetMS ?? 0
  if (clockOffsetMS) {
    const nativeNow = Date.now.bind(Date)
    Date.now = () => nativeNow() + clockOffsetMS
    Object.defineProperty(performance, 'timeOrigin', { value: performance.timeOrigin + clockOffsetMS, configurable: true })
  }
  const base = new URL('./', document.currentScript.src)
  const post = async (path, value) => {
    const response = await fetch(new URL(path, base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || `Comparison request failed (${response.status}).`)
    return result
  }
  const pending = [], events = new EventSource(new URL('events', base)), errors = []
  let hooks, connected = false, phase, clockCalibration, oracle
  const checkedFields = ['open', 'high', 'low', 'close', 'ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
  const equalValue = (left, right) => Object.is(left, right) || typeof left === 'number' && typeof right === 'number' && Math.abs(left - right) <= 1e-10 * Math.max(1, Math.abs(right))
  window.addEventListener('error', event => errors.push(`${event.message}\n${event.error?.stack || ''}`))
  window.addEventListener('unhandledrejection', event => errors.push(`${event.reason?.message || event.reason}\n${event.reason?.stack || ''}`))
  const epoch = () => performance.timeOrigin + performance.now()
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const raf = () => new Promise(resolve => requestAnimationFrame(resolve))
  async function until(predicate, label, timeout = 30000) {
    const end = performance.now() + timeout
    while (performance.now() < end) { const result = predicate(); if (result) return result; await pause(20) }
    throw new Error(`${label} timed out. ${JSON.stringify({ visibility: document.visibilityState, body: document.body.innerText.slice(0, 2500), errors })}`)
  }
  function view() {
    const element = document.querySelector('[data-chart-inst]')
    return { element, snapshot: element?.__chartSnapshot, svg: document.querySelector('svg[data-rendered-inst]') }
  }
  const summarize = values => {
    const sorted = values.toSorted((a, b) => a - b)
    return { count: sorted.length, p50: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] ?? null,
      p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? null, max: sorted.at(-1) ?? null }
  }
  window.radarDesktopBootstrap = { connect(accept) {
    if (connected) throw new Error('Comparison bridge is already connected.')
    connected = true
    accept({ nativeWindowControls: false, request: value => post('request', value),
      initializeOperations: async value => {
        hooks = value
        const source = await post('operations/init', { nonce: crypto.randomUUID() })
        for (const item of pending.splice(0)) hooks.receive(item.channel, item.detail)
        return source
      }, recordOperations: value => post('operations/batch', value), operationSourceFailure: value => post('operations/failure', value) })
  } }
  async function prepare({ fixture, expectedBars }) {
    if (expectedBars) oracle = new Map(expectedBars.map(bar => [bar.hour, bar]))
    const clocks = []
    for (let index = 0; index < 5; index++) {
      const before = epoch(), result = await fetch(new URL('status', base)).then(value => value.json()), after = epoch()
      clocks.push({ offsetMS: result.epochMS - (before + after) / 2, uncertaintyMS: (after - before) / 2 })
    }
    clockCalibration = clocks.toSorted((a, b) => a.uncertaintyMS - b.uncertaintyMS)[0]
    await until(() => window.radarDesktop && document.querySelector('[data-market-index]'), 'Market list')
    const row = [...document.querySelectorAll('[data-market-index]')].find(row => row.getAttribute('aria-label') === `View ${fixture.instIds[0]} chart`)
    if (!row) throw new Error('The canonical first contract is missing.')
    row.click()
    await until(() => {
      const { snapshot, svg } = view()
      return snapshot?.instId === fixture.instIds[0] && snapshot.timeframe === '15m' && snapshot.bars.length === 96
        && ['ready', 'unavailable'].includes(snapshot.indicatorState) && svg && svg.querySelector('[data-chart-indicator="ema"]')
    }, 'Canonical 96-candle chart', 90000)
    await pause(1500)
    return { userAgent: navigator.userAgent, visibility: document.visibilityState, nativeVisibility: nativeVisibility(), activePageSimulated: true, focused: document.hasFocus(),
      devicePixelRatio, innerWidth, innerHeight, selected: view().snapshot.instId, timeframe: view().snapshot.timeframe,
      bars: view().snapshot.bars.length, clockCalibration, clockOffsetMS, chart: canonicalChart(), errors: [...errors] }
  }
  function canonicalChart() {
    const { snapshot, svg } = view()
    return { instId: snapshot?.instId, endHour: snapshot?.endHour, bars: snapshot?.bars.map(bar => ({ hour: bar.hour, close: bar.close, ema: bar.ema,
      rsi6: bar.rsi6, vwap: bar.vwap, roc: bar.roc })), svgPaths: [...svg?.querySelectorAll('[data-chart-indicator]') ?? []].map(path => [path.getAttribute('data-chart-indicator'), path.getAttribute('d')]) }
  }
  function checkView() {
    const { snapshot, svg } = view()
    if (!snapshot || !svg || snapshot.bars.length !== 96 || Number(svg.dataset.renderedEnd) !== (snapshot.liveBar ?? snapshot.bars.at(-1)).hour) return false
    return snapshot.bars.every((bar, index, bars) => (index === 0 || bar.hour === bars[index - 1].hour + snapshot.intervalMS)
      && oracle?.has(bar.hour) && checkedFields.every(field => equalValue(bar[field], oracle.get(bar.hour)[field])))
  }
  async function run(options) {
    if (phase) throw new Error('Comparison phase is already running.')
    const state = phase = { name: options.scenario, startedAt: epoch(), frameGaps: [], inputs: [], live: [], checks: 0, failures: [], rafCount: 0,
      errorsAtStart: errors.length, active: true, pendingInputs: new Set(), visibility: new Set(), nativeVisibility: new Set(), seenQuotes: new Set() }
    const visibility = () => { state.visibility.add(document.visibilityState); state.nativeVisibility.add(nativeVisibility()) }
    document.addEventListener('visibilitychange', visibility)
    let lastFrame, frameHandle, inputTimer, iteration = 0, load
    const inputOrigin = performance.now(), plannedInputs = options.scenario === 'idle' ? 0 : Math.floor(options.durationMS / 200)
    const latestEnd = view().snapshot.endHour
    let plannedEnd = latestEnd
    const frame = time => {
      if (!state.active) return
      if (lastFrame !== undefined) state.frameGaps.push(time - lastFrame)
      lastFrame = time; state.rafCount++; state.visibility.add(document.visibilityState)
      frameHandle = requestAnimationFrame(frame)
    }
    visibility()
    if (options.scenario !== 'idle') frameHandle = requestAnimationFrame(frame)
    const input = () => {
      for (const pending of state.pendingInputs) { pending.status = 'superseded'; state.pendingInputs.delete(pending) }
      const record = { index: iteration++, startedAt: epoch(), completedAt: null, kind: options.scenario === 'history' ? 'wheel' : 'search', status: 'pending' }
      record.plannedAt = performance.timeOrigin + inputOrigin + record.index * 200
      record.scheduleLatenessMS = record.startedAt - record.plannedAt
      state.inputs.push(record); state.pendingInputs.add(record)
      let term
      if (options.scenario === 'history') {
        const sign = Math.floor(record.index / 8) % 2 ? 1 : -1
        plannedEnd = Math.min(latestEnd, plannedEnd + sign * view().snapshot.intervalMS)
        record.targetEnd = plannedEnd
        document.querySelector('[data-chart-plot]')?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -sign * 12, deltaMode: 0 }))
      } else {
        const element = document.querySelector('[aria-label="Search contracts"]')
        if (!element) { record.error = 'Search input missing'; state.pendingInputs.delete(record); return }
        term = record.index % 2 ? '' : options.fixture.instIds[0].toLowerCase()
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, term)
        element.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const expected = term === undefined ? null : options.fixture.instIds.filter(id => id.toLowerCase().includes(term)).length
      void (async () => {
        const deadline = performance.now() + 3000
        while (state.active && record.status === 'pending' && performance.now() < deadline) {
          await raf()
          const changed = options.scenario === 'history' ? Number(view().element?.dataset.chartRequestedEnd) === record.targetEnd && Number(view().element?.dataset.chartCompletedEnd) === record.targetEnd
            : Number(document.querySelector('[data-market-count]')?.dataset.marketCount) === expected
          if (!changed) continue
          await raf()
          if (record.status !== 'pending') return
          record.completedAt = epoch(); record.latencyMS = record.completedAt - record.startedAt; record.correct = checkView(); record.status = 'committed'
          if (!record.correct) state.failures.push(`Invalid chart after input ${record.index}`)
          state.pendingInputs.delete(record); return
        }
        if (record.status === 'pending') { record.status = 'missed'; record.error = 'No matching commit before input deadline'; state.pendingInputs.delete(record) }
      })()
    }
    // Idle has no synthetic interaction: the UI's own countdown and production
    // notification/telemetry schedules remain intact in both shells.
    const nextInput = () => {
      if (!state.active || iteration >= plannedInputs) return
      input()
      if (iteration < plannedInputs) inputTimer = setTimeout(nextInput, Math.max(0, inputOrigin + iteration * 200 - performance.now()))
    }
    if (plannedInputs) nextInput()
    const live = event => {
      if (options.scenario !== 'realtime') return
      const detail = event.detail, live = detail?.liveBar
      if (!live || detail.instId !== options.fixture.instIds[0] || detail.timeframe !== '15m') return
      const key = `${live.hour}:${live.close}:${detail.priceObservedAt}`
      if (state.seenQuotes.has(key)) return
      state.seenQuotes.add(key)
      const receivedAt = epoch(), sourceAt = detail.priceObservedAt
      const record = { sourceAt, receivedAt, close: live.close, status: 'pending' }
      state.live.push(record)
      void (async () => {
        const deadline = performance.now() + 3000
        while (state.active && performance.now() < deadline) {
          await raf()
          const current = view().snapshot?.liveBar
          if (current?.hour !== live.hour || current.close < live.close) continue
          if (current.close > live.close) { record.status = 'coalesced'; record.displayedClose = current.close; return }
          const expected = options.expectedLive.find(bar => bar.close === live.close)
          const correct = expected && checkedFields.every(field => equalValue(current[field], expected[field]))
          Object.assign(record, { observedAt: epoch(), displayedClose: current.close, status: correct ? 'committed' : 'incorrect',
            receiveToRAFMS: epoch() - receivedAt, sourceToRAFMS: epoch() + clockCalibration.offsetMS - sourceAt, caughtUp: Boolean(correct) })
          if (!correct) state.failures.push(`Live indicator mismatch at ${live.close}`)
          return
        }
        record.status = 'missed'
      })()
    }
    window.addEventListener('radar-chart-prepared', live)
    try {
      if (options.scenario === 'realtime') load = await post('probe', { action: 'scaleLoadStart', ticks: options.ticks, cadenceMS: 500,
        focusInstId: options.fixture.instIds[0], timeframe: '15m' })
      if (options.scenario === 'download') {
        state.downloadStart = await post('probe', { action: 'backgroundStart' })
        if (state.downloadStart.initialRows !== 0) throw new Error('Download fixture is not pristine; refusing to measure reused archive rows.')
      }
      await pause(options.durationMS)
      if (options.scenario === 'realtime') {
        let status
        for (let tries = 0; tries < 100; tries++) {
          status = await post('probe', { action: 'scaleLoadRead', includeTicks: true })
          if (['complete', 'failed', 'cancelled'].includes(status.state)) break
          await pause(100)
        }
        load = status
        const expected = load.ticks?.at(-1)?.expected
        await until(() => view().snapshot?.liveBar?.close === expected, 'Latest replayed candle')
        await until(() => state.live.every(item => item.status !== 'pending'), 'Verified replay deliveries')
        state.expectedClose = expected
        state.deliveries = load.ticks.map(tick => ({ sequence: tick.sequence, expected: tick.expected,
          status: state.live.find(item => item.close === tick.expected)?.status ?? 'missing' }))
      }
      if (options.scenario === 'download') {
        state.downloadEnd = await post('probe', { action: 'backgroundStatus' })
        if (state.downloadEnd.archiveRows !== 12240) throw new Error(`Download did not commit the identical 30-day workload: ${state.downloadEnd.archiveRows}/12240 rows.`)
        if (state.downloadEnd.audit.phase !== 'idle') throw new Error('Download-only comparison unexpectedly ran an integrity audit.')
      }
      clearTimeout(inputTimer)
      await pause(100)
      state.checks++; if (!checkView()) state.failures.push('Final chart is incomplete or inconsistent.')
      state.stoppedAt = epoch(); state.active = false
      cancelAnimationFrame(frameHandle); window.removeEventListener('radar-chart-prepared', live)
      return { scenario: options.scenario, startedAt: state.startedAt, stoppedAt: state.stoppedAt, durationMS: state.stoppedAt - state.startedAt,
        visibility: [...state.visibility], nativeVisibility: [...state.nativeVisibility], activePageSimulated: true, userAgent: navigator.userAgent, viewport: { innerWidth, innerHeight, devicePixelRatio },
        rafOpportunityGapsMS: summarize(state.frameGaps), rafCount: state.rafCount,
        interactionMS: summarize(state.inputs.flatMap(input => input.status === 'committed' && input.correct ? [input.latencyMS] : [])), inputs: state.inputs,
        inputCounts: { planned: plannedInputs, dispatched: state.inputs.length, committed: state.inputs.filter(input => input.status === 'committed').length, superseded: state.inputs.filter(input => input.status === 'superseded').length },
        liveReceiveToRAFMS: summarize(state.live.filter(item => item.status === 'committed').map(item => item.receiveToRAFMS)), liveSourceToRAFMS: summarize(state.live.filter(item => item.status === 'committed').map(item => item.sourceToRAFMS)),
        live: state.live, deliveries: state.deliveries, load, expectedClose: state.expectedClose, pendingInputs: state.pendingInputs.size,
        downloadStart: state.downloadStart, downloadEnd: state.downloadEnd,
        errors: errors.slice(state.errorsAtStart), failures: state.failures, finalChart: canonicalChart() }
    } finally {
      state.active = false; clearTimeout(inputTimer); cancelAnimationFrame(frameHandle); window.removeEventListener('radar-chart-prepared', live); document.removeEventListener('visibilitychange', visibility); phase = undefined
    }
  }
  events.onmessage = async event => {
    const item = JSON.parse(event.data)
    if (item.fatal) { errors.push(item.fatal); return }
    if (item.channel) { if (hooks) hooks.receive(item.channel, item.detail); else pending.push(item); return }
    if (!item.command) return
    const { id, ...options } = item.command
    try {
      const result = options.action === 'prepare' ? await prepare(options) : options.action === 'run' ? await run(options)
        : options.action === 'drain' ? (await hooks?.flush(), events.close(), { ok: true }) : (() => { throw new Error('Unsupported browser comparison command.') })()
      await post('result', { id, result })
    } catch (error) { await post('result', { id, error: `${error.message}\n${error.stack || ''}` }) }
  }
})()
