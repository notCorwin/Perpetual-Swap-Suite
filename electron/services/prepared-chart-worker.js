import { parentPort } from 'node:worker_threads'
import { buildIndicatorSeries } from './indicators.js'

// Recursive indicators always share the complete persisted native series.
// A viewport or a statistics observation never chooses a new EMA/RSI seed.
parentPort.on('message', ({ id, candles, intervalMS }) => {
  try {
    const { bars, state } = buildIndicatorSeries(candles, intervalMS)
    parentPort.postMessage({ id, state, bars: bars.map(bar => ({ ...bar, indicatorsObserved: true })) })
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
