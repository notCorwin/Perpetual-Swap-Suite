// A constant offset aligns replay candle boundaries across sequential trials.
// Rates are unchanged: performance.now(), native timers and OS counters remain
// real-time. The exact same offset is inherited by every backend worker.
const offset = Number(process.env.RADAR_COMPARE_CLOCK_OFFSET_MS ?? 0)
if (!Number.isSafeInteger(offset) || Math.abs(offset) > 86_400_000) throw new Error('Comparison clock offset must be an integer within one day.')
if (offset) {
  const nativeNow = Date.now.bind(Date)
  Date.now = () => nativeNow() + offset
  Object.defineProperty(performance, 'timeOrigin', { value: performance.timeOrigin + offset, configurable: true })
}
