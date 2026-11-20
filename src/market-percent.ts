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
  const rounded = Math.abs(change) < 0.005 ? 0 : change
  return `${formatPercent(rounded)} ${close >= open ? '↑' : '↓'}`
}
