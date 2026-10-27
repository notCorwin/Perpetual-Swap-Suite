import assert from 'node:assert/strict'
const crossProcessOriginToleranceMS = 2 // Epoch-origin precision across Node and Chromium monotonic clocks.
const liveDeliveryBudgetMS = 100

// Installed in the renderer so each RAF records the actual displayed state.
export function installResourcePaintProbe(fixture) {
  const state = window.__resourcePaint = { records: [], violations: [], indicatorValuesChecked: 0, previous: null, frameGaps: [], previousFrame: null }
  const snapshots = new WeakMap()
  const near = (actual, expected, description) => {
    if (expected === null ? actual !== null : typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual - expected) > Math.max(1, Math.abs(expected)) * 1e-10) {
      if (state.violations.length < 40) state.violations.push(`${description}: ${actual} != ${expected}`)
    }
  }
  const displayed = (chart = document.querySelector('[data-chart-inst]')) => {
    const snapshot = chart?.__chartSnapshot, svg = chart?.querySelector('svg[data-rendered-inst]')
    const number = value => value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : null
    const renderedEnd = number(svg?.dataset.renderedEnd), liveHour = snapshot?.liveBar?.hour ?? null
    const liveVisible = liveHour !== null && renderedEnd === liveHour
    const instrument = Number(snapshot?.instId?.slice(5, 8)), step = fixture.intervals[snapshot?.timeframe]
    const baseline = 100 + instrument * 3 + ({ '5m': 0, '15m': 10, '1H': 20 })[snapshot?.timeframe]
    const sequence = liveVisible && Number.isFinite(baseline) && step ? Math.round((snapshot.liveBar.close - baseline - fixture.periods * .01) * 1000) : 0
    return { snapshot, frame: { instId: snapshot?.instId ?? null, timeframe: snapshot?.timeframe ?? null,
      chartInst: chart?.dataset.chartInst ?? null, chartEnd: number(chart?.dataset.chartEnd),
      requestedEnd: number(chart?.dataset.chartRequestedEnd), visualStale: chart?.dataset.chartVisualStale ?? null,
      loading: chart?.dataset.chartLoading ?? null, endHour: snapshot?.endHour ?? null,
      renderedInst: svg?.dataset.renderedInst ?? null, renderedTimeframe: svg?.dataset.renderedTimeframe ?? null,
      renderedEnd, visible: Boolean(svg?.isConnected && svg.getAttribute('aria-hidden') !== 'true' && svg.style.visibility !== 'hidden'),
      liveHour, livePrice: snapshot?.liveBar?.close ?? null, priceObservedAt: snapshot?.priceObservedAt ?? null,
      sequence, expectedLivePrice: liveVisible ? baseline + fixture.periods * .01 + sequence * .001 : null,
      label: svg?.querySelector('[data-chart-price-label-value]')?.textContent ?? '',
      bars: snapshot?.bars?.length ?? 0, renderedBars: number(chart?.dataset.chartRenderedBars), indicatorState: snapshot?.indicatorState ?? null,
      oiState: snapshot?.oiState ?? null, takerState: snapshot?.takerState ?? null } }
  }
  state.isFrame = record => {
    const frame = record?.frame
    return Boolean(frame?.sameSnapshot && frame.visible && record.instId === frame.instId && frame.chartInst === frame.instId
      && frame.renderedInst === frame.instId && record.timeframe === frame.timeframe && frame.renderedTimeframe === frame.timeframe
      && frame.visualStale === 'false' && frame.chartEnd === frame.renderedEnd
      && record.endHour === frame.endHour && record.bars === 96 && frame.bars === 96 && frame.renderedBars === 96
      && record.label === frame.label && Number.isFinite(record.nextFrameAt)
      && record.nextFrameAt >= record.committedAt)
  }
  const observeFrame = (record, snapshot) => {
    snapshots.set(record, snapshot)
    requestAnimationFrame(() => {
      record.nextFrameAt = performance.timeOrigin + performance.now()
      const observed = displayed()
      record.frame = { ...observed.frame, sameSnapshot: observed.snapshot === snapshot }
      if (record.frame.sameSnapshot && record.frame.liveHour !== null && record.frame.liveHour === record.frame.renderedEnd) {
        near(record.frame.livePrice, record.frame.expectedLivePrice, 'RAF synthetic quote')
        near(Number(record.frame.label.split(/\s/)[0].replaceAll(',', '')), record.frame.livePrice, 'RAF SVG live-price label')
      }
    })
  }
  const sample = () => {
    const chart = document.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
    if (!snapshot?.instId?.startsWith('SCALE') || snapshot === state.previous) return
    const observed = displayed(chart)
    if (!observed.frame.renderedInst) return
    const frame = observed.frame
    state.previous = snapshot
    if (frame.renderedInst !== snapshot.instId || frame.renderedTimeframe !== snapshot.timeframe) state.violations.push('SVG mixed native series identities.')
    const instrument = Number(snapshot.instId.slice(5, 8)), step = fixture.intervals[snapshot.timeframe]
    const first = Math.floor(fixture.asOf / step) * step - fixture.periods * step
    const baseline = 100 + instrument * 3 + ({ '5m': 0, '15m': 10, '1H': 20 })[snapshot.timeframe]
    for (const value of snapshot.bars) {
      const index = (value.hour - first) / step, close = baseline + index * .01
      if (!Number.isInteger(index) || index < 0 || index >= fixture.periods) { state.violations.push('A persisted candle fell outside its seeded native range.'); continue }
      for (const [field, expected] of Object.entries({ open: close - .02, high: close + .06, low: close - .05, close })) near(value[field], expected, `${snapshot.instId}/${snapshot.timeframe}/${index}/${field}`)
      if (value.indicatorsObserved) {
        const middle = close - .095, deviation = .01 * Math.sqrt(399 / 12)
        const roc = i => (baseline + i * .01 - (baseline + (i - 9) * .01)) / Math.abs(baseline + (i - 9) * .01) * 100
        let numerator = 0, denominator = 0
        for (let i = Math.max(0, index - 13); i <= index; i += 1) { const volume = 100 + i % 7; numerator += (baseline + i * .01 + .01 / 3) * volume; denominator += volume }
        const expected = { ema: index >= 199 ? close - .995 : null,
          bollMiddle: index >= 19 ? middle : null, bollUpper: index >= 19 ? middle + 2 * deviation : null, bollLower: index >= 19 ? middle - 2 * deviation : null,
          vwap: index >= 13 ? numerator / denominator : null, roc: index >= 9 ? roc(index) : null,
          maroc: index >= 17 ? Array.from({ length: 9 }, (_, offset) => roc(index - offset)).reduce((a, b) => a + b, 0) / 9 : null,
          rsi6: index >= 6 ? 100 : null, rsi12: index >= 12 ? 100 : null, rsi24: index >= 24 ? 100 : null,
          atrPercent: index >= 13 ? .11 / close * 100 : null, bbw: index >= 19 ? 4 * deviation / middle * 100 : null }
        for (const [field, expectedValue] of Object.entries(expected)) { near(value[field], expectedValue, `${snapshot.instId}/${snapshot.timeframe}/${index}/${field}`); state.indicatorValuesChecked += 1 }
      }
    }
    const label = frame.label
    const liveVisible = snapshot.liveBar && frame.renderedEnd === snapshot.liveBar.hour
    if (liveVisible) {
      near(snapshot.liveBar.close, frame.expectedLivePrice, 'Visible synthetic quote')
      near(Number(label.split(/\s/)[0].replaceAll(',', '')), snapshot.liveBar.close, 'Visible SVG live-price label')
    }
    const record = { instId: snapshot.instId, timeframe: snapshot.timeframe, endHour: snapshot.endHour,
      livePrice: snapshot.liveBar?.close ?? null, priceObservedAt: snapshot.priceObservedAt,
      sequence: frame.sequence, kind: 'commit', committedAt: performance.timeOrigin + performance.now(), nextFrameAt: null, frame: null, label, bars: snapshot.bars.length,
      indicatorState: snapshot.indicatorState, oiState: snapshot.oiState, takerState: snapshot.takerState }
    state.records.push(record)
    state.current = record
    state.latestWitness = record
    observeFrame(record, snapshot)
  }
  // Recheck even an unchanged cached live snapshot after a viewport input.
  // This is a frame observation, not a new SVG commit.
  state.recheck = () => {
    sample()
    if (!state.current) return
    const record = { ...state.current, kind: 'recheck', sampledAt: performance.timeOrigin + performance.now(), nextFrameAt: null, frame: null }
    state.records.push(record)
    state.latestWitness = record
    observeFrame(record, state.previous)
  }
  state.readyForLatest = ({ instId, timeframe, sequence, afterAt }) => {
    const observed = displayed(), record = state.latestWitness
    if (!record || observed.snapshot !== state.previous || snapshots.get(record) !== observed.snapshot || !state.isFrame(record)
      || record.instId !== instId || record.timeframe !== timeframe || record.sequence !== sequence || record.nextFrameAt < afterAt) return false
    const frame = observed.frame
    const current = { ...record, frame: { ...frame, sameSnapshot: true } }
    return state.isFrame(current) && frame.sequence === sequence && frame.liveHour === frame.renderedEnd
      && Number.isFinite(frame.expectedLivePrice) && Number.isFinite(frame.livePrice)
      && Math.abs(frame.livePrice - frame.expectedLivePrice) <= Math.max(1, Math.abs(frame.expectedLivePrice)) * 1e-10
  }
  new MutationObserver(sample).observe(document, { subtree: true, attributes: true, childList: true })
  const frame = timestamp => { if (state.previousFrame !== null) state.frameGaps.push(timestamp - state.previousFrame); state.previousFrame = timestamp; sample(); requestAnimationFrame(frame) }
  requestAnimationFrame(frame)
}

// A commit is only evidence of a displayed frame when the RAF callback read
// the same snapshot and the actual visible SVG, including its price label.
// Requested history can be pending while the previous live SVG is still shown.
function verifiedFrame(record) {
  const frame = record.frame
  return Boolean(frame?.sameSnapshot === true && frame.visible === true
    && Number.isFinite(record.committedAt) && Number.isFinite(record.nextFrameAt) && record.nextFrameAt >= record.committedAt
    && typeof record.instId === 'string' && typeof record.timeframe === 'string'
    && frame.instId === record.instId && frame.chartInst === record.instId && frame.renderedInst === record.instId
    && frame.timeframe === record.timeframe && frame.renderedTimeframe === record.timeframe && frame.visualStale === 'false'
    && Number.isFinite(record.endHour) && frame.endHour === record.endHour && Number.isFinite(frame.renderedEnd)
    && frame.chartEnd === frame.renderedEnd
    && record.bars === 96 && frame.bars === 96 && frame.renderedBars === 96
    && frame.label === record.label && typeof frame.label === 'string' && frame.label.length > 0)
}

function verifiedLiveFrame(record, ticksBySequence) {
  if (!verifiedFrame(record)) return false
  const frame = record.frame, source = ticksBySequence.get(record.sequence)
  const labelPrice = Number(frame.label.split(/\s/)[0].replaceAll(',', ''))
  return Boolean(source && Number.isSafeInteger(record.sequence) && record.sequence > 0
    && frame.sequence === record.sequence && Number.isFinite(record.livePrice) && frame.livePrice === record.livePrice
    && Number.isFinite(frame.expectedLivePrice)
    && Math.abs(frame.livePrice - frame.expectedLivePrice) <= Math.max(1, Math.abs(frame.expectedLivePrice)) * 1e-10
    && record.priceObservedAt === source.receivedAt && frame.priceObservedAt === source.receivedAt
    && Number.isFinite(frame.liveHour) && frame.liveHour === frame.renderedEnd
    && Number.isFinite(labelPrice) && Math.abs(labelPrice - frame.livePrice) <= Math.max(1, Math.abs(frame.livePrice)) * 1e-10
    && record.committedAt + crossProcessOriginToleranceMS >= source.receivedAt
    && record.nextFrameAt + crossProcessOriginToleranceMS >= source.receivedAt)
}

function verifiedHistoricalFrame(record, intent) {
  const frame = record.frame
  return verifiedFrame(record) && frame.instId === intent.instId && frame.timeframe === intent.timeframe
    && frame.liveHour === null && frame.renderedEnd === frame.endHour
    && (intent.endHour === undefined || frame.endHour === intent.endHour)
}

export function summarizeResourceDelivery(load, commits, { intents = [] } = {}) {
  assert.equal(load.state, 'complete', 'Fixed-rate intake must finish without failures or pending work.')
  assert.equal(load.emitted, load.plannedTicks, 'Every scheduled input must be emitted.')
  assert.equal(load.completed, load.plannedTicks, 'Every emitted input must settle.')
  assert.equal(load.failed, 0)
  assert.ok(load.ticks?.length === load.plannedTicks && load.ticks.every((row, index) =>
    Number.isSafeInteger(row.sequence) && row.sequence > 0 && (!index || row.sequence > load.ticks[index - 1].sequence)
    && ['plannedAt', 'emittedAt', 'receivedAt', 'completedAt'].every(field => Number.isFinite(row[field]))
    && row.plannedAt <= row.emittedAt && row.emittedAt <= row.receivedAt && row.receivedAt <= row.completedAt),
  'Every input needs ordered scheduled, emitted, received and completed source timestamps on its monotonic clock.')
  assert.ok(intents.every((intent, index) => Number.isFinite(intent.at) && typeof intent.instId === 'string'
    && typeof intent.timeframe === 'string' && (!index || intent.at >= intents[index - 1].at)), 'Viewport intents must have ordered renderer timestamps and series identities.')
  const activeAt = at => intents.findLast(value => value.at <= at)
  const ticksBySequence = new Map(load.ticks.map(tick => [tick.sequence, tick]))
  const frames = commits.filter(value => Number.isFinite(value.nextFrameAt)).sort((a, b) => a.nextFrameAt - b.nextFrameAt)
  const liveFrames = frames.filter(value => verifiedLiveFrame(value, ticksBySequence))
  const historyTransitions = intents.filter((intent, index) => intent.historical && !intents[index - 1]?.historical)
  const excluded = [], supersededLiveInputs = [], viewportOriginAmbiguities = []

  const matchesActiveSeries = (record, at, fallback) => {
    const intent = activeAt(at)
    return record.instId === (intent?.instId ?? fallback.instId) && record.timeframe === (intent?.timeframe ?? fallback.timeframe)
      && (intent?.liveEndHour === undefined || record.frame.endHour === intent.liveEndHour)
  }
  const definitelyHistorical = (tick, possibleIntents) => {
    if (!possibleIntents.length || !possibleIntents.every(value => value?.historical)) return false
    const intent = activeAt(tick.receivedAt - crossProcessOriginToleranceMS)
    const last = frames.findLast(value => value.nextFrameAt < tick.receivedAt - crossProcessOriginToleranceMS)
    // A later unverified commit may have changed the chart before receipt.
    return Boolean(last && verifiedHistoricalFrame(last, intent)
      && !commits.some(value => value.kind !== 'recheck' && Number.isFinite(value.committedAt)
        && value.committedAt > last.nextFrameAt && value.committedAt <= tick.receivedAt + crossProcessOriginToleranceMS))
  }

  const deliveries = load.ticks.flatMap(tick => {
    const possibleIntents = [...new Set([intents.findLast(value => value.at < tick.receivedAt - crossProcessOriginToleranceMS),
      ...intents.filter(value => Math.abs(value.at - tick.receivedAt) <= crossProcessOriginToleranceMS)])]
    const possibleViews = new Set(possibleIntents.map(value => `${value?.instId ?? tick.instId}:${value?.timeframe ?? tick.timeframe}:${Boolean(value?.historical)}`))
    if (possibleViews.size > 1) viewportOriginAmbiguities.push({ sequence: tick.sequence, possibleViews: [...possibleViews] })
    if (definitelyHistorical(tick, possibleIntents)) { excluded.push(tick.sequence); return [] }

    // A history transition can cancel a live obligation only when it is
    // definitely after receipt and strictly before its 100 ms deadline, even
    // at the worst permitted offset between the two clocks.
    const timelyHistory = historyTransitions.find(intent => intent.at - crossProcessOriginToleranceMS > tick.receivedAt
      && intent.at + crossProcessOriginToleranceMS < tick.receivedAt + liveDeliveryBudgetMS)
    const nextLiveIntent = timelyHistory && intents.find(intent => intent.at > timelyHistory.at && !intent.historical)
    const candidates = liveFrames.filter(value => value.sequence >= tick.sequence && matchesActiveSeries(value, value.nextFrameAt, tick)
      && value.committedAt + crossProcessOriginToleranceMS >= tick.receivedAt
      && value.nextFrameAt + crossProcessOriginToleranceMS >= tick.receivedAt)
    let commit = candidates[0]
    if (timelyHistory) {
      // Prefer an actual live frame during the pending history request. A
      // later return to live instead starts a separate freshness obligation.
      commit = candidates.find(value => value.nextFrameAt - tick.receivedAt <= liveDeliveryBudgetMS
        && (!nextLiveIntent || value.nextFrameAt < nextLiveIntent.at))
      if (!commit) {
        supersededLiveInputs.push({ sequence: tick.sequence, receivedAt: tick.receivedAt, historyIntentAt: timelyHistory.at,
          receiveToHistoryClockDeltaMS: timelyHistory.at - tick.receivedAt })
        return []
      }
    }
    // If history was already requested but its previous live chart was still
    // visible at receipt, its verified historical frame can supersede that
    // obligation only after it is shown and before the same strict deadline.
    if (possibleIntents.every(value => value?.historical)) {
      const intent = activeAt(tick.receivedAt - crossProcessOriginToleranceMS)
      const historical = frames.find(value => value.nextFrameAt > tick.receivedAt + crossProcessOriginToleranceMS
        && value.nextFrameAt + crossProcessOriginToleranceMS < tick.receivedAt + liveDeliveryBudgetMS
        && activeAt(value.nextFrameAt) === intent && verifiedHistoricalFrame(value, intent))
      if (historical && (!commit || historical.nextFrameAt < commit.nextFrameAt)) {
        supersededLiveInputs.push({ sequence: tick.sequence, receivedAt: tick.receivedAt, historyIntentAt: intent.at,
          historicalFrameAt: historical.nextFrameAt, receiveToHistoryClockDeltaMS: intent.at - tick.receivedAt })
        return []
      }
    }
    assert.ok(commit, `Scheduled update ${tick.sequence} never reached a verified renderer frame opportunity and was not superseded before its deadline.`)
    assert.ok(commit.committedAt + crossProcessOriginToleranceMS >= tick.receivedAt && commit.nextFrameAt >= commit.committedAt,
      'Renderer delivery must use valid, ordered receive/commit/RAF timestamps.')
    const receiveToCommitClockDeltaMS = commit.committedAt - tick.receivedAt
    const receiveToFrameClockDeltaMS = commit.nextFrameAt - tick.receivedAt
    return [{ sequence: tick.sequence, instId: commit.instId, timeframe: commit.timeframe,
      renderedSequence: commit.sequence, coalesced: commit.sequence !== tick.sequence,
      plannedAt: tick.plannedAt, emittedAt: tick.emittedAt, receivedAt: tick.receivedAt, completedAt: tick.completedAt,
      committedAt: commit.committedAt, nextFrameAt: commit.nextFrameAt,
      scheduleToCommitMS: commit.committedAt - tick.plannedAt, scheduleToFrameMS: commit.nextFrameAt - tick.plannedAt,
      receiveToCommitClockDeltaMS, receiveToFrameClockDeltaMS,
      receiveToCommitMS: Math.max(0, receiveToCommitClockDeltaMS), receiveToFrameMS: Math.max(0, receiveToFrameClockDeltaMS) }]
  })
  assert.ok(deliveries.length >= Math.max(2, Math.ceil(load.plannedTicks / 2)), 'At least half of the fixed-rate inputs must exercise visible live delivery.')

  // Returning to live owes the most recent quote that could already have been
  // received at the renderer input, even if the source emits nothing afterward.
  // Subsequent history toggles cannot silently erase this obligation.
  const returnsToLive = intents.flatMap((intent, index) => {
    if (intent.historical || !intents[index - 1]?.historical) return []
    const latest = load.ticks.filter(tick => tick.receivedAt <= intent.at + crossProcessOriginToleranceMS).at(-1)
    if (!latest) return []
    const commit = liveFrames.find(value => value.nextFrameAt >= intent.at
      && value.instId === intent.instId && value.timeframe === intent.timeframe
      && (intent.endHour === undefined || value.frame.endHour === intent.endHour)
      && value.sequence >= latest.sequence && matchesActiveSeries(value, value.nextFrameAt, intent))
    assert.ok(commit, `Return to live at ${intent.at} never reached a verified renderer frame with accepted sequence ${latest.sequence}.`)
    return [{ instId: intent.instId, timeframe: intent.timeframe, inputAt: intent.at,
      requiredSequence: latest.sequence, requiredReceivedAt: latest.receivedAt, renderedSequence: commit.sequence,
      committedAt: commit.committedAt, nextFrameAt: commit.nextFrameAt, inputToFrameMS: commit.nextFrameAt - intent.at }]
  })

  const values = deliveries.map(value => value.scheduleToFrameMS).sort((a, b) => a - b)
  return { count: values.length, crossProcessOriginToleranceMS, maxMS: values.at(-1), p50MS: values[Math.ceil(values.length * .5) - 1],
    p95MS: values.length >= 100 ? values[Math.ceil(values.length * .95) - 1] : null,
    p99MS: values.length >= 1000 ? values[Math.ceil(values.length * .99) - 1] : null,
    receiveToFrameMaxMS: Math.max(...deliveries.map(value => value.receiveToFrameMS)),
    coalesced: deliveries.filter(value => value.coalesced).length, historicalViewportInputs: excluded,
    supersededLiveInputs, viewportOriginAmbiguities, returnsToLive, samples: deliveries }
}

function assertReceiveToFrameBudget(summary, budgetMS) {
  if (budgetMS === null) return
  assert.ok(Number.isFinite(budgetMS) && budgetMS > 0, 'The renderer delivery budget must be a positive measurement.')
  assert.ok(Number.isFinite(summary.receiveToFrameMaxMS) && summary.receiveToFrameMaxMS <= budgetMS,
    `An accepted market input waited ${summary.receiveToFrameMaxMS?.toFixed(2)} ms for a renderer frame opportunity (budget ${budgetMS} ms).`)
}

function assertReturnToLiveBudget(summary, budgetMS) {
  assert.ok(Array.isArray(summary.returnsToLive), 'Verified return-to-live measurements are required; older reports do not contain RAF display evidence.')
  if (budgetMS === null) return
  assert.ok(Number.isFinite(budgetMS) && budgetMS > 0, 'The renderer delivery budget must be a positive measurement.')
  for (const sample of summary.returnsToLive) assert.ok(Number.isFinite(sample.inputToFrameMS) && sample.inputToFrameMS <= budgetMS,
    `Return to live waited ${sample.inputToFrameMS?.toFixed(2)} ms to show accepted sequence ${sample.requiredSequence} (budget ${budgetMS} ms).`)
}

export function assertResourceDeliveryBudget(summary, budgetMS = liveDeliveryBudgetMS) {
  assertReturnToLiveBudget(summary, budgetMS)
  assertReceiveToFrameBudget(summary, budgetMS)
}

// Evaluate independent performance budgets together. A source scheduling miss
// must not discard valid renderer samples or hide a simultaneous frame stall.
export function assessResourceBudgets({ load, delivery, switches, frameCadence }, { offscreen = false } = {}) {
  const checks = [
    ['source-cadence', () => assert.ok(Number.isFinite(load.cadenceMS) && load.cadenceMS > 0
      && Number.isFinite(load.maxScheduleLatenessMS) && load.maxScheduleLatenessMS >= 0
      && load.maxScheduleLatenessMS <= load.cadenceMS,
    `The source scheduler fell behind by ${load.maxScheduleLatenessMS} ms (budget ${load.cadenceMS} ms).`)],
    ['receive-to-raf', () => assertReceiveToFrameBudget(delivery, offscreen ? null : 100)],
    ['return-to-live', () => assertReturnToLiveBudget(delivery, offscreen ? null : 100)],
  ]
  if (!offscreen) checks.push(
    ['prepared-selection', () => assert.ok(Array.isArray(switches) && switches.length > 0
      && switches.every(value => Number.isFinite(value.rowClickToFrameMS) && value.rowClickToFrameMS >= 0 && value.rowClickToFrameMS <= 100),
    'A prepared contract selection exceeded the 100 ms row-click-to-RAF budget or has no valid measurement.')],
    ['raf-gap', () => assert.ok(Number.isFinite(frameCadence?.maxMS) && frameCadence.maxMS >= 0 && frameCadence.maxMS < 100,
      `The renderer RAF gap was ${frameCadence?.maxMS} ms (budget <100 ms).`)],
    ['raf-p95', () => assert.ok(Number.isFinite(frameCadence?.p95MS) && frameCadence.p95MS >= 0 && frameCadence.p95MS <= 50,
      `The renderer RAF p95 was ${frameCadence?.p95MS} ms (budget 50 ms).`)],
  )
  return checks.flatMap(([gate, check]) => {
    try { check(); return [] }
    catch (error) { return [{ gate, message: error.message }] }
  })
}
