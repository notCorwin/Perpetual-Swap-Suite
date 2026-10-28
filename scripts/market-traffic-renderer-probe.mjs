// Self-contained so Playwright can install the same probe in the renderer world.
export function installMarketTrafficRendererProbe({ requireForeground, passingIDs }, host = globalThis) {
  const { performance, document, window, PerformanceObserver } = host
  const state = { gaps: [], frames: [], interactions: [], interactionSamples: [], lastFrame: null,
    startedAt: performance.now(), active: true,
    presentation: { requiredForeground: requireForeground, samples: 0, totalViolations: 0, violations: [] } }
  const pendingFrames = new Set(), longAnimationFrames = { supported: false, samples: [] }
  let observer, captured
  const scheduleFrame = callback => {
    const id = host.requestAnimationFrame(now => { pendingFrames.delete(id); if (state.active) callback(now) })
    pendingFrames.add(id)
  }
  const checkPresentation = () => {
    if (!state.active) return
    state.presentation.samples++
    if (requireForeground && (document.visibilityState !== 'visible' || !document.hasFocus())) {
      state.presentation.totalViolations++
      if (state.presentation.violations.length < 10) state.presentation.violations.push({
        at: performance.now(), visibility: document.visibilityState, focused: document.hasFocus() })
    }
  }
  const frame = timestampMS => {
    const callbackAtMS = performance.now()
    checkPresentation()
    if (state.lastFrame !== null) state.gaps.push(timestampMS - state.lastFrame)
    state.frames.push({ timestampMS, callbackAtMS })
    state.lastFrame = timestampMS
    scheduleFrame(frame)
  }
  const input = event => {
    if (event.target?.getAttribute?.('aria-label') !== 'Search contracts') return
    checkPresentation()
    const started = performance.now(), term = event.target.value
    scheduleFrame(() => scheduleFrame(() => {
      const completed = performance.now(), durationMS = completed - started
      const expectedResultCount = passingIDs.filter(id => id.toLowerCase().includes(term.trim().toLowerCase())).length
      const actualResultCount = Number(document.querySelector('[data-market-count]')?.getAttribute('data-market-count'))
      state.interactions.push(durationMS)
      state.interactionSamples.push({ term, startedMS: started - state.startedAt, completedMS: completed - state.startedAt, durationMS,
        expectedResultCount, actualResultCount, correct: actualResultCount === expectedResultCount })
    }))
  }
  const timingFields = (entry, names) => Object.fromEntries(names.filter(name => Number.isFinite(entry[name]))
    .map(name => [`${name}MS`, entry[name]]))
  const recordLongFrames = entries => {
    for (const entry of entries) {
      if (entry.startTime + entry.duration < state.startedAt || entry.startTime > (state.stoppedAt ?? Infinity)) continue
      longAnimationFrames.samples.push({
        ...timingFields(entry, ['startTime', 'duration', 'blockingDuration', 'renderStart', 'styleAndLayoutStart',
          'firstUIEventTimestamp', 'paintTime', 'presentationTime']),
        scripts: Array.from(entry.scripts ?? [], script => ({
          ...timingFields(script, ['startTime', 'duration', 'executionStart', 'forcedStyleAndLayoutDuration', 'pauseDuration']),
          ...Object.fromEntries(['invoker', 'invokerType', 'sourceURL', 'sourceFunctionName', 'sourceCharPosition', 'windowAttribution']
            .filter(name => typeof script[name] === 'string' || Number.isFinite(script[name])).map(name => [name, script[name]])),
        })),
      })
    }
  }
  if (PerformanceObserver?.supportedEntryTypes.includes('long-animation-frame')) {
    try {
      observer = new PerformanceObserver(list => recordLongFrames(list.getEntries()))
      observer.observe({ type: 'long-animation-frame' })
      longAnimationFrames.supported = true
    } catch (error) {
      observer?.disconnect(); observer = undefined
      longAnimationFrames.captureError = error.message
    }
  }
  const percentile = (values, fraction) => {
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0
  }
  state.stop = () => {
    if (captured) return captured
    state.stoppedAt = performance.now()
    state.active = false
    if (observer) recordLongFrames(observer.takeRecords())
    // Capture the measured interval before cleanup, which is outside the sample.
    captured = { elapsedMS: state.stoppedAt - state.startedAt, frameCount: state.gaps.length, presentation: state.presentation,
      clock: { timeOriginMS: performance.timeOrigin, startedAtMS: state.startedAt, stoppedAtMS: state.stoppedAt },
      rafTimeline: { measurement: 'RAF timestamp and callback performance.now(), both relative to performance.timeOrigin.', samples: state.frames },
      longAnimationFrames,
      rafOpportunityGapMS: { sampleCount: state.gaps.length, p50: percentile(state.gaps, .5), p95: percentile(state.gaps, .95),
        max: Math.max(0, ...state.gaps), samples: state.gaps },
      searchInputToSecondRAFMS: { sampleCount: state.interactions.length, p50: percentile(state.interactions, .5),
        p95: percentile(state.interactions, .95), p95Interpretation: 'Empirical nearest-rank summary; descriptive at this sample count, not a tail guarantee.',
        max: Math.max(0, ...state.interactions), samples: state.interactionSamples } }
    observer?.disconnect()
    for (const id of pendingFrames) host.cancelAnimationFrame(id)
    pendingFrames.clear()
    document.removeEventListener('visibilitychange', checkPresentation)
    window.removeEventListener('blur', checkPresentation)
    document.removeEventListener('input', input, true)
    return captured
  }
  host.__marketTrafficResponsiveness = state
  document.addEventListener('visibilitychange', checkPresentation)
  window.addEventListener('blur', checkPresentation)
  document.addEventListener('input', input, true)
  checkPresentation()
  scheduleFrame(frame)
}
