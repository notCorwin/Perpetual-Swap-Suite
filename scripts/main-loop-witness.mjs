// Self-contained: Playwright serializes this function into Electron's main world.
export function installMainLoopWitness(_, { intervalMS = 20, capacity = 1_024, runtime, role = 'electron-main', ownerId } = {}) {
  if (!Number.isSafeInteger(intervalMS) || intervalMS < 1 || !Number.isSafeInteger(capacity) || capacity < 2) {
    throw new TypeError('Main-loop witness requires a positive interval and room for its start and stop samples.')
  }
  const target = runtime?.target ?? globalThis
  if (target.__mainLoopWitness) throw new Error('A main-loop witness is already installed.')
  const now = runtime?.now ?? (() => performance.now())
  const timeOriginMS = runtime?.timeOriginMS ?? performance.timeOrigin
  const readCPU = runtime?.readCPU ?? (() => process.threadCpuUsage())
  const readEventLoop = runtime?.readEventLoop ?? (() => performance.eventLoopUtilization())
  const schedule = runtime?.schedule ?? setInterval
  const cancel = runtime?.cancel ?? clearInterval
  const thread = runtime?.thread ?? process.getBuiltinModule('worker_threads')
  const identity = { role, pid: runtime?.pid ?? process.pid, threadId: thread.threadId, isMainThread: thread.isMainThread }
  const samples = [], captureErrors = []
  let active = true, timer, omittedSamples = 0, totalSamples = 0, droppedCaptureErrors = 0, captureCostMS = 0, maxCaptureCostMS = 0, result
  let eventLoopSamples = 0, nonzeroEventLoopSamples = 0, invalidEventLoopSamples = 0
  const failed = (stage, error) => {
    if (captureErrors.length < 32) captureErrors.push({ stage, message: String(error?.message ?? error) })
    else droppedCaptureErrors++
  }
  const capture = kind => {
    const callbackAtMS = now()
    totalSamples++
    try {
      const cpu = readCPU()
      if (![callbackAtMS, cpu.user, cpu.system].every(value => Number.isFinite(value) && value >= 0)) {
        throw new Error('Main-loop witness has invalid wall-clock or cumulative thread CPU evidence.')
      }
      let eventLoop
      try {
        const value = readEventLoop()
        if (![value.idle, value.active, value.utilization].every(value => Number.isFinite(value) && value >= 0)
          || value.utilization > 1) throw new Error('Main-loop witness has invalid cumulative event-loop evidence.')
        eventLoop = { idleMS: value.idle, activeMS: value.active, utilization: value.utilization }
        eventLoopSamples++
        if (value.idle + value.active > 0) nonzeroEventLoopSamples++
      } catch (error) { invalidEventLoopSamples++; failed(`${kind}-event-loop`, error) }
      const capturedAtMS = now()
      if (!Number.isFinite(capturedAtMS) || capturedAtMS < callbackAtMS) throw new Error('Main-loop witness capture clock reversed.')
      // Reserve the final slot for the stop witness, and report any truncation.
      if (kind !== 'stop' && samples.length >= capacity - 1) omittedSamples++
      else samples.push({ kind, callbackAtMS, capturedAtMS, threadCPUUS: { user: cpu.user, system: cpu.system }, eventLoop })
    } catch (error) { failed(kind, error) }
    finally {
      const costMS = now() - callbackAtMS
      captureCostMS += costMS; maxCaptureCostMS = Math.max(maxCaptureCostMS, costMS)
    }
  }
  const stop = () => {
    if (result) return result
    active = false
    try { if (timer !== undefined) cancel(timer) } catch (error) { failed('cancel', error) }
    try { capture('stop') }
    finally { if (target.__mainLoopWitness?.ownerId === ownerId) delete target.__mainLoopWitness }
    result = { schemaVersion: 3, ownerId, ...identity, timeOriginMS, intervalMS, capacity,
      clock: 'Epoch milliseconds = timeOriginMS + callbackAtMS; monotonic performance.now() with cumulative thread CPU in microseconds.',
      sampleRetention: 'first samples plus reserved final stop', totalSamples, sampleCount: samples.length, omittedSamples,
      complete: omittedSamples === 0 && captureErrors.length === 0 && droppedCaptureErrors === 0,
      captureErrors, droppedCaptureErrors, captureCostMS, maxCaptureCostMS,
      measurement: 'Main-thread timer callback timestamps and cumulative thread CPU. Timer gaps witness main-loop unavailability; they do not identify its cause or measure compositor paint.',
      eventLoopMeasurement: 'Cumulative Node/libuv idle and active wall milliseconds, not CPU. Delta active includes synchronous waiting; delta idle measures event-loop polling. An all-zero stream, possible with the Electron integrated loop, does not establish either idle or active time. Correlate the independent Node driver with thread CPU.',
      eventLoopEvidence: { readableSamples: eventLoopSamples, nonzeroSamples: nonzeroEventLoopSamples,
        invalidSamples: invalidEventLoopSamples, state: invalidEventLoopSamples ? 'invalid' : nonzeroEventLoopSamples ? 'observed' : 'all-zero' },
      samples }
    return result
  }
  target.__mainLoopWitness = { ownerId, stop }
  capture('start')
  try {
    timer = schedule(() => { if (active) capture('timer') }, intervalMS)
    timer?.unref?.()
  } catch (error) {
    stop()
    error.mainLoopWitness = result
    throw error
  }
  return { ownerId, ...identity, timeOriginMS, intervalMS, capacity }
}

// Own a private target so a driver witness never replaces another caller's timer.
export function startNodeDriverLoopWitness(options = {}) {
  const target = {}
  const metadata = installMainLoopWitness(null, { ...options, role: 'node-driver', runtime: { ...options.runtime, target } })
  return { ...metadata, stop: target.__mainLoopWitness.stop }
}
