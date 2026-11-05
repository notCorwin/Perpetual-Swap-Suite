// Diagnostic-only script: inject before the app, never in the primary baseline.
(() => {
  'use strict'
  if (window.__comparisonCosts) return

  const now = performance.now.bind(performance)
  const availability = {}, observerAvailability = {}, observers = []
  const limitations = [
    'Times are inclusive elapsed wall milliseconds, not CPU time; nested calls can overlap.',
    'Character counts are UTF-16 code units for already-string arguments and returned strings; other input sizes are unknown and are never coerced for measurement.',
    'Only returned TextEncoder bytes and encodeInto written bytes are counted; structuredClone and engine-internal copies are not sized.',
    'setAttribute wall time is an explicit API call cost, not layout, paint, rendering CPU, GPU, or compositor time; use native or Chrome tracing for those costs.',
    'Only explicit calls in this window are wrapped. Browser internals, other realms, workers, and calls through references captured before installation are not counted.',
    'Observer entries are browser-reported wall-time summaries, not per-frame tracing. Entries starting before reset are excluded; supported types may still produce no entries.',
    'Instrumentation itself adds overhead; compare a separate probe-on/probe-off baseline and do not use these values as the primary baseline.',
  ]
  const timing = () => ({ calls: 0, errors: 0, wallMS: 0, maxWallMS: 0 })
  const input = () => ({ ...timing(), inputChars: 0, maxInputChars: 0, unknownInputChars: 0 })
  const outputChars = () => ({ ...timing(), outputChars: 0, maxOutputChars: 0, nonStringResults: 0 })
  const encoding = () => ({ ...input(), outputBytes: 0, maxOutputBytes: 0 })
  const observation = () => ({ count: 0, durationMS: 0, maxDurationMS: 0, blockingDurationMS: 0,
    maxBlockingDurationMS: 0, entriesWithoutBlockingDuration: 0, excludedBeforeReset: 0 })
  const fresh = () => ({ jsonParse: input(), jsonStringify: outputChars(), textEncoderEncode: encoding(),
    textEncoderEncodeInto: { ...encoding(), consumedChars: 0, maxConsumedChars: 0 }, structuredClone: timing(),
    setAttribute: input(), svgDAttribute: input(), getBoundingClientRect: timing(), getBBox: timing(), getComputedStyle: timing(),
    longtask: observation(), 'long-animation-frame': observation() })
  let stats = fresh(), phaseStartMS = now()
  function finish(metric, start, ok) {
    const elapsed = Math.max(0, now() - start)
    metric.calls++
    if (!ok) metric.errors++
    metric.wallMS += elapsed
    if (elapsed > metric.maxWallMS) metric.maxWallMS = elapsed
    return elapsed
  }
  function countInput(metric, value) {
    if (typeof value !== 'string') { metric.unknownInputChars++; return }
    const length = value.length
    metric.inputChars += length
    if (length > metric.maxInputChars) metric.maxInputChars = length
  }
  function countOutputBytes(metric, length) {
    metric.outputBytes += length
    if (length > metric.maxOutputBytes) metric.maxOutputBytes = length
  }
  function install(owner, method, category, makeWrapper) {
    if (!owner || typeof owner[method] !== 'function') { availability[category] = { available: false, reason: 'API unavailable' }; return }
    try {
      const original = owner[method], descriptor = Object.getOwnPropertyDescriptor(owner, method)
      const wrapper = makeWrapper(original)
      Object.defineProperty(owner, method, descriptor
        ? { ...descriptor, value: wrapper }
        : { value: wrapper, writable: true, configurable: true, enumerable: false })
      availability[category] = { available: true }
    } catch (error) {
      availability[category] = { available: false, reason: `Cannot wrap API: ${error && error.message || 'unknown error'}` }
    }
  }
  install(JSON, 'parse', 'jsonParse', original => function () {
    const metric = stats.jsonParse, start = now(); let ok = false
    try { const result = original.apply(this, arguments); ok = true; return result }
    finally { finish(metric, start, ok); countInput(metric, arguments[0]) }
  })
  install(JSON, 'stringify', 'jsonStringify', original => function () {
    const metric = stats.jsonStringify, start = now(); let ok = false, result
    try { result = original.apply(this, arguments); ok = true; return result }
    finally {
      finish(metric, start, ok)
      if (ok && typeof result === 'string') {
        metric.outputChars += result.length
        if (result.length > metric.maxOutputChars) metric.maxOutputChars = result.length
      } else if (ok) metric.nonStringResults++
    }
  })
  install(window.TextEncoder && window.TextEncoder.prototype, 'encode', 'textEncoderEncode', original => function () {
    const metric = stats.textEncoderEncode, start = now(); let ok = false, result
    try { result = original.apply(this, arguments); ok = true; return result }
    finally { finish(metric, start, ok); countInput(metric, arguments.length ? arguments[0] : ''); if (ok) countOutputBytes(metric, result.byteLength) }
  })
  install(window.TextEncoder && window.TextEncoder.prototype, 'encodeInto', 'textEncoderEncodeInto', original => function () {
    const metric = stats.textEncoderEncodeInto, start = now(); let ok = false, result
    try { result = original.apply(this, arguments); ok = true; return result }
    finally {
      finish(metric, start, ok); countInput(metric, arguments[0])
      if (ok) {
        countOutputBytes(metric, result.written)
        metric.consumedChars += result.read
        if (result.read > metric.maxConsumedChars) metric.maxConsumedChars = result.read
      }
    }
  })
  install(window, 'structuredClone', 'structuredClone', original => function () {
    const metric = stats.structuredClone, start = now(); let ok = false
    try { const result = original.apply(this, arguments); ok = true; return result }
    finally { finish(metric, start, ok) }
  })
  install(window.Element && window.Element.prototype, 'setAttribute', 'setAttribute', original => function () {
    const metric = stats.setAttribute, svgMetric = stats.svgDAttribute, start = now(); let ok = false
    try { const result = original.apply(this, arguments); ok = true; return result }
    finally {
      const elapsed = finish(metric, start, ok)
      countInput(metric, arguments[1])
      if (window.SVGElement && this instanceof window.SVGElement && arguments[0] === 'd') {
        svgMetric.calls++; if (!ok) svgMetric.errors++
        svgMetric.wallMS += elapsed; if (elapsed > svgMetric.maxWallMS) svgMetric.maxWallMS = elapsed
        countInput(svgMetric, arguments[1])
      }
    }
  })
  availability.svgDAttribute = availability.setAttribute.available && window.SVGElement
    ? { available: true } : { available: false, reason: 'setAttribute or SVGElement unavailable' }
  for (const [owner, method, category] of [
    [window.Element && window.Element.prototype, 'getBoundingClientRect', 'getBoundingClientRect'],
    [window.SVGGraphicsElement && window.SVGGraphicsElement.prototype, 'getBBox', 'getBBox'],
    [window, 'getComputedStyle', 'getComputedStyle'],
  ]) {
    install(owner, method, category, original => function () {
      const metric = stats[category], start = now(); let ok = false
      try { const result = original.apply(this, arguments); ok = true; return result }
      finally { finish(metric, start, ok) }
    })
  }

  function recordEntries(type, entries) {
    const summary = stats[type]
    for (const entry of entries) {
      if (entry.startTime < phaseStartMS) { summary.excludedBeforeReset++; continue }
      const duration = Number.isFinite(entry.duration) ? Math.max(0, entry.duration) : 0
      summary.count++; summary.durationMS += duration
      if (duration > summary.maxDurationMS) summary.maxDurationMS = duration
      if (Number.isFinite(entry.blockingDuration)) {
        const blocking = Math.max(0, entry.blockingDuration)
        summary.blockingDurationMS += blocking
        if (blocking > summary.maxBlockingDurationMS) summary.maxBlockingDurationMS = blocking
      } else summary.entriesWithoutBlockingDuration++
    }
  }
  for (const type of ['longtask', 'long-animation-frame']) {
    const Observer = window.PerformanceObserver
    if (!Observer) { observerAvailability[type] = { available: false, reason: 'PerformanceObserver unavailable' }; continue }
    if (Array.isArray(Observer.supportedEntryTypes) && !Observer.supportedEntryTypes.includes(type)) {
      observerAvailability[type] = { available: false, reason: 'Entry type unsupported' }; continue
    }
    try {
      const observer = new Observer(list => recordEntries(type, list.getEntries()))
      observer.observe({ type, buffered: false })
      observers.push({ type, observer }); observerAvailability[type] = { available: true }
    } catch (error) {
      observerAvailability[type] = { available: false, reason: `Cannot observe entry type: ${error && error.message || 'unknown error'}` }
    }
  }
  const api = Object.freeze({
    reset() {
      // Discard queued entries before the new boundary; later-delivered entries
      // that started before the boundary are filtered in recordEntries.
      for (const { observer } of observers) observer.takeRecords()
      phaseStartMS = now(); stats = fresh()
    },
    snapshot() {
      for (const { type, observer } of observers) recordEntries(type, observer.takeRecords())
      const result = {}
      for (const key of Object.keys(stats)) result[key] = { ...stats[key] }
      const apiAvailability = {}, entries = {}
      for (const key of Object.keys(availability)) apiAvailability[key] = { ...availability[key] }
      for (const key of Object.keys(observerAvailability)) entries[key] = { ...observerAvailability[key] }
      return { schemaVersion: 1, phaseStartMS, snapshotMS: now(), timeOriginMS: performance.timeOrigin,
        measurements: result, availability: { apis: apiAvailability, performanceEntries: entries }, limitations: [...limitations] }
    },
  })
  Object.defineProperty(window, '__comparisonCosts', { value: api, configurable: false })
})()
