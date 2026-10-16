// Native snapshots encode infinities as strings because JSON has no infinite numbers.
export type PercentageValue = number | "Infinity" | "-Infinity" | null

export const PERCENT_CHANGE_DESCRIPTION = "Percentage change: (current − previous) / |previous| × 100%. A zero previous value gives 0.00% if current is zero, +∞% if positive, and −∞% if negative."

export function percentageNumber(value: PercentageValue): number | null {
  if (value === null) return null
  const number = Number(value)
  return Number.isNaN(number) ? null : number
}

export function finitePercentage(value: PercentageValue): number | null {
  const number = percentageNumber(value)
  return number !== null && Number.isFinite(number) ? number : null
}

export function formatPercent(value: PercentageValue, decimals = 2): string {
  const number = percentageNumber(value)
  if (number === null) return "—"
  if (number === Infinity) return "+∞%"
  if (number === -Infinity) return "−∞%"
  return `${number > 0 ? "+" : ""}${number.toFixed(decimals)}%`
}
