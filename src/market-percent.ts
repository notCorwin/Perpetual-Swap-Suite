export type PercentageValue = number | null

import { signedRelativeChange } from '../electron/services/market-metrics.js'

export function finitePercentage(value: PercentageValue): number | null {
  if (value === null) return null
  return Number.isFinite(value) ? value : null
}

export function formatPercent(value: PercentageValue, decimals = 2): string {
  const number = finitePercentage(value)
  if (number === null) return "—"
  return `${number > 0 ? "+" : ""}${number.toFixed(decimals)}%`
}

/** The active candle's close compared with its own open, independent of the axis baseline. */
export function formatCandleChange(open: number, close: number): string {
  const change = signedRelativeChange(close, open)
  if (change === null) return '—'
  // Keep the direction visible even when a small change rounds to zero.
  if (change !== 0 && Math.abs(change) < 0.005) return `${change > 0 ? '+' : '-'}0.00%`
  return formatPercent(change)
}

/** Direction uses the unrounded change, so small moves remain distinguishable. */
export function candleChangeDirection(open: number, close: number): 'up' | 'down' | 'flat' | 'unavailable' {
  const change = signedRelativeChange(close, open)
  return change === null ? 'unavailable' : change > 0 ? 'up' : change < 0 ? 'down' : 'flat'
}
