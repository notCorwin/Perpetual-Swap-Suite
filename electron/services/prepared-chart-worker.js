import { parentPort } from 'node:worker_threads'
import { appendIndicatorCandle, createIndicatorState } from './indicators.js'
import { measureOperation } from './operations.js'
import { closeOperationRecording } from './operation-runtime.js'

// One bounded chunk is a scheduling unit. Recursive state is passed explicitly,
// so yielding to another series cannot change any formula or initialization.
parentPort.on('message', async ({ type, id, candles, intervalMS, checkpoint }) => {
  if (type === 'closeOperations') {
    try { await closeOperationRecording(); parentPort.postMessage({ type: 'operationsClosed' }) }
    catch { parentPort.postMessage({ type: 'operationsClosed', error: true }) }
    return
  }
  try {
    const { state, bars } = measureOperation({ category: 'cpu', name: 'indicators.replay', resource: candles[0]?.instrument,
      attributes: { candles: candles.length, intervalMS, checkpoint: Boolean(checkpoint), execution: 'worker' } }, () => {
    const state = checkpoint ? structuredClone(checkpoint) : createIndicatorState(intervalMS)
    const bars = []
    for (const candle of candles) {
      const previousHour = state.lastTimestamp, previousWidth = state.previousBandWidth ?? null
      const bar = appendIndicatorCandle(state, candle)
      if (!bar) continue
      const width = bar.bbw
      state.bollExpansion = width === null ? null : previousWidth === null || previousHour + intervalMS !== candle.timestamp
        ? { hours: 0, complete: false } : width <= previousWidth ? { hours: 0, complete: true }
          : { hours: (state.bollExpansion?.hours ?? 0) + 1, complete: state.bollExpansion?.complete ?? false }
      state.previousBandWidth = width
      bars.push({ ...bar, indicatorsObserved: true })
    }
    return { state, bars }
    })
    parentPort.postMessage({ id, state, bars })
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
