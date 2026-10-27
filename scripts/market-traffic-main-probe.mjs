// Self-contained: Playwright serializes this function into Electron's main world.
export function installMarketTrafficMainProbe(_, { intervalMS = 20, capacity = 1_024, runtime } = {}) {
  if (!Number.isSafeInteger(intervalMS) || intervalMS < 1 || !Number.isSafeInteger(capacity) || capacity < 2) {
    throw new TypeError('Main-loop witness requires a positive interval and room for its start and stop samples.')
  }
  const target = runtime?.target ?? globalThis
  if (target.__marketTrafficMainLoop) throw new Error('A market traffic main-loop witness is already installed.')
  const now = runtime?.now ?? (() => performance.now())
  const timeOriginMS = runtime?.timeOriginMS ?? performance.timeOrigin
  const readCPU = runtime?.readCPU ?? (() => process.threadCpuUsage())
  const schedule = runtime?.schedule ?? setInterval
  const cancel = runtime?.cancel ?? clearInterval
  const samples = []
  let active = true, omittedSamples = 0, captureCostMS = 0, maxCaptureCostMS = 0, result
  const capture = kind => {
    const callbackAtMS = now(), cpu = readCPU(), capturedAtMS = now()
    // Reserve the final slot for the stop witness, and report any truncation.
    if (kind !== 'stop' && samples.length >= capacity - 1) omittedSamples++
    else samples.push({ kind, callbackAtMS, capturedAtMS, threadCPUUS: { user: cpu.user, system: cpu.system } })
    const costMS = now() - callbackAtMS
    captureCostMS += costMS; maxCaptureCostMS = Math.max(maxCaptureCostMS, costMS)
  }
  capture('start')
  const timer = schedule(() => { if (active) capture('timer') }, intervalMS)
  timer?.unref?.()
  const stop = () => {
    if (result) return result
    active = false; cancel(timer); capture('stop')
    result = { timeOriginMS, intervalMS, capacity, omittedSamples, captureCostMS, maxCaptureCostMS,
      measurement: 'Main-thread timer callback timestamps and cumulative thread CPU. Timer gaps witness main-loop unavailability; they do not identify its cause or measure compositor paint.',
      samples }
    delete target.__marketTrafficMainLoop
    return result
  }
  target.__marketTrafficMainLoop = { stop }
  return { timeOriginMS, intervalMS, capacity }
}
