import type { Candle } from '../types'

export function ema(candles: Candle[], period: number) {
  const alpha = 2 / (period + 1)
  let value: number | null = null
  return candles.map(candle => {
    value = value === null ? candle.close : candle.close * alpha + value * (1 - alpha)
    return value
  })
}

export function rsi(candles: Candle[], period = 14) {
  let gain = 0
  let loss = 0
  return candles.map((candle, index) => {
    if (index === 0) return null
    const change = candle.close - candles[index - 1].close
    const up = Math.max(change, 0)
    const down = Math.max(-change, 0)
    if (index <= period) {
      gain += up
      loss += down
      if (index < period) return null
      gain /= period
      loss /= period
    } else {
      gain = (gain * (period - 1) + up) / period
      loss = (loss * (period - 1) + down) / period
    }
    if (loss === 0) return 100
    return 100 - 100 / (1 + gain / loss)
  })
}
