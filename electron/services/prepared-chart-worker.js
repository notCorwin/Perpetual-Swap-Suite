import { parentPort } from 'node:worker_threads'
import { appendIndicatorCandle, createIndicatorState } from './indicators.js'

const bandwidth = bar => bar && Number.isFinite(bar.bollMiddle) && bar.bollMiddle > 0
  && Number.isFinite(bar.bollUpper) && Number.isFinite(bar.bollLower)
  ? (bar.bollUpper - bar.bollLower) / bar.bollMiddle * 100 : null

// One bounded chunk is a scheduling unit. Recursive state is passed explicitly,
// so yielding to another series cannot change any formula or initialization.
parentPort.on('message', ({ id, candles, intervalMS, checkpoint }) => {
  try {
    const state = checkpoint ? structuredClone(checkpoint) : createIndicatorState(intervalMS)
    const bars = []
    for (const candle of candles) {
      const previousHour = state.lastTimestamp, previousWidth = state.previousBandWidth ?? null
      const bar = appendIndicatorCandle(state, candle)
      if (!bar) continue
      const width = bandwidth(bar)
      state.bollExpansion = width === null ? null : previousWidth === null || previousHour + intervalMS !== candle.timestamp
        ? { hours: 0, complete: false } : width <= previousWidth ? { hours: 0, complete: true }
          : { hours: (state.bollExpansion?.hours ?? 0) + 1, complete: state.bollExpansion?.complete ?? false }
      state.previousBandWidth = width
      bars.push({ ...bar, indicatorsObserved: true })
    }
    parentPort.postMessage({ id, state, bars })
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
