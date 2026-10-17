export type PercentageValue = number | null

export const PERCENT_CHANGE_DESCRIPTION = "Signed relative change: (current − previous) / |previous| × 100%. A zero or unavailable baseline is unavailable (—)."

export function percentageNumber(value: PercentageValue): number | null {
  if (value === null) return null
  return Number.isFinite(value) ? value : null
}

export function finitePercentage(value: PercentageValue): number | null {
  const number = percentageNumber(value)
  return number !== null && Number.isFinite(number) ? number : null
}

export function formatPercent(value: PercentageValue, decimals = 2): string {
  const number = percentageNumber(value)
  if (number === null) return "—"
  return `${number > 0 ? "+" : ""}${number.toFixed(decimals)}%`
}
