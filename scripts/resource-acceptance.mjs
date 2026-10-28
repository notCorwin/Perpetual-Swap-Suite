import assert from 'node:assert/strict'
const crossProcessOriginToleranceMS = 2 // Epoch-origin precision across Node and Chromium monotonic clocks.
const liveDeliveryBudgetMS = 100

// Timed callbacks retain observed data and the displayed SVG. The fixture
// oracle runs only after capture and the benchmark's measurement windows stop.
export function installResourcePaintProbe(fixture) {
  if (window.__resourcePaint?.active) throw new Error('The previous resource paint probe must stop before starting another.')
  const state = window.__resourcePaint = { active: true, records: [], violations: [], indicatorValuesChecked: 0,
    previous: null, frameGaps: [], previousFrame: null, captureErrors: [], omittedCaptureErrors: 0,
    captureTimings: { samples: 0, totalMS: 0, maxMS: 0 }, cpuMarkerTimings: { samples: 0, totalMS: 0, maxMS: 0 } }
  const observations = [], snapshots = new WeakMap(), pendingFrames = new Set()
  const barCopies = new WeakMap(), barsCopies = new WeakMap(), snapshotCopies = new WeakMap()
  let previousRetained, observer, loopFrame, stopped, finished, cpuPrefix = fixture.cpuMarkerPrefix, cpuArmed = false, cpuIndex = 0
  const failCapture = (stage, error) => {
    if (state.captureErrors.length < 40) state.captureErrors.push({ stage, message: String(error?.message ?? error) })
    else state.omittedCaptureErrors++
  }
  const capture = (stage, operation) => {
    if (!state.active) return
    const started = performance.now()
    try { return operation(performance.timeOrigin + started) }
    catch (error) { failCapture(stage, error) }
    finally {
      const durationMS = performance.now() - started
      state.captureTimings.samples++; state.captureTimings.totalMS += durationMS
      state.captureTimings.maxMS = Math.max(state.captureTimings.maxMS, durationMS)
    }
  }
  const markCPU = (phase, frame) => {
    if (!cpuPrefix) return
    const started = performance.now()
    try { console.timeStamp(cpuPrefix + JSON.stringify({ at: started, timeOrigin: performance.timeOrigin, phase, index: cpuIndex++, ...frame })) }
    catch (error) { failCapture('cpu-marker', error) }
    finally {
      const durationMS = performance.now() - started
      state.cpuMarkerTimings.samples++; state.cpuMarkerTimings.totalMS += durationMS
      state.cpuMarkerTimings.maxMS = Math.max(state.cpuMarkerTimings.maxMS, durationMS)
    }
  }
  state.armCPU = prefix => {
    if (!state.active || cpuArmed || cpuPrefix && cpuPrefix !== prefix || typeof prefix !== 'string' || !prefix) throw new Error('A resource CPU marker stream can be armed once during active capture.')
    cpuArmed = true; cpuPrefix = prefix; markCPU('start')
  }
  const cadenceWindow = () => ({ timeOrigin: performance.timeOrigin, startedAt: performance.now(), endedAt: null,
    firstRAFMarkerIndex: null, lastRAFMarkerIndex: null, maxGapMarkerIndex: null, maxGapMS: null,
    frames: 0, unmarkedFrames: 0 })
  state.frameCadence = cadenceWindow()
  state.resetFrameCadence = () => {
    if (!state.active) throw new Error('Resource RAF cadence can only reset during active capture.')
    state.frameGaps = []; state.previousFrame = null; state.frameCadence = cadenceWindow()
  }
  const retainBar = value => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
    const previous = barCopies.get(value), keys = Object.keys(value)
    if (previous && keys.length === Object.keys(previous).length && keys.every(key => Object.is(value[key], previous[key]))) return previous
    const retained = Object.freeze({ ...value }); barCopies.set(value, retained); return retained
  }
  const retainBars = bars => {
    if (!Array.isArray(bars)) return bars
    const entry = barsCopies.get(bars)
    if (entry?.immutable) return entry.value
    if (!entry && Object.isFrozen(bars) && bars.every(value => !value || typeof value !== 'object' || Object.isFrozen(value))) {
      barsCopies.set(bars, { immutable: true, value: bars }); return bars
    }
    const previous = entry?.value
    let next = !previous || previous.length !== bars.length ? [] : null
    for (let index = 0; index < bars.length; index++) {
      const value = retainBar(bars[index])
      if (!next && previous[index] !== value) next = previous.slice(0, index)
      if (next) next.push(value)
    }
    if (!next) return previous
    const retained = Object.freeze(next); barsCopies.set(bars, { immutable: false, value: retained }); return retained
  }
  const retainSnapshot = snapshot => {
    if (!snapshot || typeof snapshot !== 'object') return snapshot
    const bars = retainBars(snapshot.bars), liveBar = retainBar(snapshot.liveBar)
    if (Object.isFrozen(snapshot) && bars === snapshot.bars && liveBar === snapshot.liveBar) return snapshot
    const keys = Object.keys(snapshot), valueAt = key => key === 'bars' ? bars : key === 'liveBar' ? liveBar : snapshot[key]
    const previous = snapshotCopies.get(snapshot)
    if (previous && keys.length === Object.keys(previous).length && keys.every(key => Object.is(valueAt(key), previous[key]))) return previous
    const retained = Object.freeze({ ...snapshot, bars, liveBar }); snapshotCopies.set(snapshot, retained); return retained
  }
  const displayed = (chart = document.querySelector('[data-chart-inst]')) => {
    const snapshot = chart?.__chartSnapshot, svg = chart?.querySelector('svg[data-rendered-inst]')
    const number = value => value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : null
    const renderedEnd = number(svg?.dataset.renderedEnd), liveHour = snapshot?.liveBar?.hour ?? null
    const liveVisible = liveHour !== null && renderedEnd === liveHour
    const instrument = Number(snapshot?.instId?.slice(5, 8)), step = fixture.intervals[snapshot?.timeframe]
    const baseline = 100 + instrument * 3 + ({ '5m': 0, '15m': 10, '1H': 20 })[snapshot?.timeframe]
    const sequence = liveVisible && Number.isFinite(baseline) && step ? Math.round((snapshot.liveBar.close - baseline - fixture.periods * .01) * 1000) : 0
    return { snapshot, frame: Object.freeze({ instId: snapshot?.instId ?? null, timeframe: snapshot?.timeframe ?? null,
      chartInst: chart?.dataset.chartInst ?? null, chartEnd: number(chart?.dataset.chartEnd),
      requestedEnd: number(chart?.dataset.chartRequestedEnd), visualStale: chart?.dataset.chartVisualStale ?? null,
      loading: chart?.dataset.chartLoading ?? null, endHour: snapshot?.endHour ?? null,
      renderedInst: svg?.dataset.renderedInst ?? null, renderedTimeframe: svg?.dataset.renderedTimeframe ?? null,
      renderedEnd, visible: Boolean(svg?.isConnected && svg.getAttribute('aria-hidden') !== 'true' && svg.style.visibility !== 'hidden'),
      liveHour, livePrice: snapshot?.liveBar?.close ?? null, priceObservedAt: snapshot?.priceObservedAt ?? null,
      sequence, expectedLivePrice: liveVisible ? baseline + fixture.periods * .01 + sequence * .001 : null,
      label: svg?.querySelector('[data-chart-price-label-value]')?.textContent ?? '',
      bars: snapshot?.bars?.length ?? 0, renderedBars: number(chart?.dataset.chartRenderedBars), indicatorState: snapshot?.indicatorState ?? null,
      oiState: snapshot?.oiState ?? null, takerState: snapshot?.takerState ?? null }) }
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
  const observeFrame = (record, snapshot, retained) => {
    snapshots.set(record, { snapshot, retained })
    const id = requestAnimationFrame(() => {
      pendingFrames.delete(id)
      capture('raf', at => {
        const observed = displayed(), observedSnapshot = retainSnapshot(observed.snapshot)
        record.nextFrameAt = at
        record.frame = Object.freeze({ ...observed.frame, sameSnapshot: observed.snapshot === snapshot && observedSnapshot === retained })
        observations.push({ kind: 'raf', at, snapshot: observedSnapshot, frame: record.frame })
      })
    })
    pendingFrames.add(id)
  }
  const sample = () => capture('snapshot', at => {
    const chart = document.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
    if (!snapshot?.instId?.startsWith('SCALE')) return
    const retained = retainSnapshot(snapshot)
    if (snapshot === state.previous && retained === previousRetained) return
    const observed = displayed(chart), frame = observed.frame
    if (!frame.renderedInst) return
    state.previous = snapshot; previousRetained = retained
    observations.push({ kind: 'commit', at, snapshot: retained, frame })
    const record = { instId: retained.instId, timeframe: retained.timeframe, endHour: retained.endHour,
      livePrice: retained.liveBar?.close ?? null, priceObservedAt: retained.priceObservedAt,
      sequence: frame.sequence, kind: 'commit', committedAt: at, nextFrameAt: null, frame: null, label: frame.label, bars: retained.bars?.length ?? 0,
      indicatorState: retained.indicatorState, oiState: retained.oiState, takerState: retained.takerState }
    state.records.push(record); state.current = record; state.latestWitness = record
    observeFrame(record, snapshot, retained)
  })
  // A cached frame still owes a fresh RAF observation after viewport input.
  state.recheck = () => {
    sample()
    capture('recheck', at => {
      if (!state.current) return
      const record = { ...state.current, kind: 'recheck', sampledAt: at, nextFrameAt: null, frame: null }
      state.records.push(record); state.latestWitness = record
      observeFrame(record, state.previous, previousRetained)
    })
  }
  state.readyForLatest = input => capture('readiness', () => {
    const { instId, timeframe, sequence, afterAt } = input, observed = displayed(), record = state.latestWitness, source = snapshots.get(record)
    if (!record || observed.snapshot !== state.previous || source?.snapshot !== observed.snapshot
      || source.retained !== retainSnapshot(observed.snapshot) || !state.isFrame(record)
      || record.instId !== instId || record.timeframe !== timeframe || record.sequence !== sequence || record.nextFrameAt < afterAt) return false
    const frame = observed.frame, current = { ...record, frame: { ...frame, sameSnapshot: true } }
    return state.isFrame(current) && frame.sequence === sequence && frame.liveHour === frame.renderedEnd
      && Number.isFinite(frame.expectedLivePrice) && Number.isFinite(frame.livePrice)
      && Math.abs(frame.livePrice - frame.expectedLivePrice) <= Math.max(1, Math.abs(frame.expectedLivePrice)) * 1e-10
  })
  state.stop = () => {
    if (stopped) return stopped
    sample()
    state.active = false
    const endedAt = performance.timeOrigin + performance.now(), pendingFrameObservations = pendingFrames.size
    state.frameCadence.endedAt = endedAt - performance.timeOrigin
    try { observer?.disconnect() } catch (error) { failCapture('disconnect', error) }
    for (const id of [loopFrame, ...pendingFrames]) if (id !== undefined) {
      try { cancelAnimationFrame(id) } catch (error) { failCapture('cancel-raf', error) }
    }
    pendingFrames.clear()
    markCPU('stop')
    for (const record of state.records) Object.freeze(record)
    Object.freeze(state.records); Object.freeze(state.frameGaps)
    return stopped = Object.freeze({ endedAt, pendingFrameObservations, frameCadence: Object.freeze({ ...state.frameCadence }) })
  }
  state.finish = () => {
    if (finished) return finished
    const stop = state.stop(), started = performance.now(), validated = new WeakMap()
    let omittedViolations = 0, reusedBarChecks = 0
    const violate = message => { if (state.violations.length < 40) state.violations.push(message); else omittedViolations++ }
    const near = (actual, expected, description) => {
      if (expected === null ? actual !== null : typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual - expected) > Math.max(1, Math.abs(expected)) * 1e-10) {
        violate(`${description}: ${actual} != ${expected}`)
      }
    }
    for (const { kind, snapshot, frame } of observations) {
      if (!snapshot?.instId?.startsWith('SCALE')) continue
      try {
        if (frame.renderedInst !== snapshot.instId || frame.renderedTimeframe !== snapshot.timeframe) violate('SVG mixed native series identities.')
        const instrument = Number(snapshot.instId.slice(5, 8)), step = fixture.intervals[snapshot.timeframe]
        const first = Math.floor(fixture.asOf / step) * step - fixture.periods * step
        const baseline = 100 + instrument * 3 + ({ '5m': 0, '15m': 10, '1H': 20 })[snapshot.timeframe]
        if (!Array.isArray(snapshot.bars)) { violate('A resource observation lacks its persisted bars.'); continue }
        if (frame.visible && frame.visualStale === 'false' && frame.loading === 'false' && snapshot.indicatorState === 'ready'
          && (snapshot.bars.length !== 96 || frame.bars !== 96 || frame.renderedBars !== 96)) {
          violate(`A ready resource paint is incomplete: ${snapshot.bars.length} retained, ${frame.bars} snapshot and ${frame.renderedBars} rendered bars.`)
        }
        const key = `${snapshot.instId}:${snapshot.timeframe}`, known = validated.get(snapshot.bars)
        if (known?.has(key)) reusedBarChecks++
        else {
          for (const value of snapshot.bars) {
            const index = (value.hour - first) / step, close = baseline + index * .01
            if (!Number.isInteger(index) || index < 0 || index >= fixture.periods) { violate('A persisted candle fell outside its seeded native range.'); continue }
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
              for (const [field, expectedValue] of Object.entries(expected)) { near(value[field], expectedValue, `${snapshot.instId}/${snapshot.timeframe}/${index}/${field}`); state.indicatorValuesChecked++ }
            }
          }
          if (known) known.add(key); else validated.set(snapshot.bars, new Set([key]))
        }
        if (snapshot.liveBar && frame.renderedEnd === snapshot.liveBar.hour) {
          near(snapshot.liveBar.close, frame.expectedLivePrice, `${kind === 'raf' ? 'RAF' : 'Visible'} synthetic quote`)
          near(Number(frame.label.split(/\s/)[0].replaceAll(',', '')), snapshot.liveBar.close, `${kind === 'raf' ? 'RAF' : 'Visible'} SVG live-price label`)
        }
      } catch (error) { violate(`Deferred resource validation failed: ${String(error?.message ?? error)}`) }
    }
    if (!observations.length) failCapture('observations', 'No resource paint observations were captured.')
    const deferredValidation = Object.freeze({ observations: observations.length, reusedBarChecks, durationMS: performance.now() - started })
    Object.freeze(state.violations)
    return finished = Object.freeze({ complete: state.captureErrors.length === 0 && state.omittedCaptureErrors === 0 && state.violations.length === 0,
      violations: state.violations, omittedViolations, indicatorValuesChecked: state.indicatorValuesChecked, rendererCommits: state.records.length,
      captureErrors: Object.freeze(state.captureErrors.map(error => Object.freeze({ ...error }))), omittedCaptureErrors: state.omittedCaptureErrors,
      captureTimings: Object.freeze({ ...state.captureTimings }), cpuMarkerTimings: Object.freeze({ ...state.cpuMarkerTimings }),
      deferredValidation, stopped: stop })
  }
  observer = new MutationObserver(sample)
  observer.observe(document, { subtree: true, attributes: true, childList: true })
  const frame = timestamp => {
    const callbackAt = performance.now()
    if (!state.active) return
    const previousRafTimestamp = state.previousFrame
    const cadence = state.frameCadence, markerIndex = cpuPrefix ? cpuIndex : null
    cadence.frames++
    if (markerIndex === null) cadence.unmarkedFrames++
    else { cadence.firstRAFMarkerIndex ??= markerIndex; cadence.lastRAFMarkerIndex = markerIndex }
    if (previousRafTimestamp !== null && (cadence.maxGapMS === null || timestamp - previousRafTimestamp > cadence.maxGapMS)) {
      cadence.maxGapMS = timestamp - previousRafTimestamp; cadence.maxGapMarkerIndex = markerIndex
    }
    if (state.previousFrame !== null) state.frameGaps.push(timestamp - state.previousFrame)
    state.previousFrame = timestamp
    sample()
    // DOM-only corruption must not disappear behind an unchanged data snapshot
    // or be repaired before the next explicit commit/recheck observation.
    capture('displayed-raf', at => {
      const observed = displayed()
      if (observed.snapshot?.instId?.startsWith('SCALE')) observations.push({ kind: 'raf', at,
        snapshot: retainSnapshot(observed.snapshot), frame: observed.frame })
    })
    markCPU('raf', { rafTimestamp: timestamp, previousRafTimestamp, callbackAt }); loopFrame = requestAnimationFrame(frame)
  }
  if (cpuPrefix) markCPU('capture-start')
  loopFrame = requestAnimationFrame(frame)
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
