import { parentPort } from 'node:worker_threads'
import { barsWithIndicators } from './indicators.js'

// Recursive indicators always share the complete persisted native series.
// A viewport or a statistics observation never chooses a new EMA/RSI seed.
parentPort.on('message', ({ id, candles, intervalMS }) => {
  try {
    parentPort.postMessage({ id, bars: barsWithIndicators(candles, intervalMS).map(bar => ({ ...bar, indicatorsObserved: true })) })
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
