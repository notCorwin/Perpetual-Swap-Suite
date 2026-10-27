export type PercentageValue = number | null

export function finitePercentage(value: PercentageValue): number | null {
  if (value === null) return null
  return Number.isFinite(value) ? value : null
}

export function formatPercent(value: PercentageValue, decimals = 2): string {
  const number = finitePercentage(value)
  if (number === null) return "—"
  return `${number > 0 ? "+" : ""}${number.toFixed(decimals)}%`
}
