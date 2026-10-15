export function signedRelativeChange(current: number, baseline: number) {
  return baseline === 0 ? 0 : (current - baseline) / baseline * 100
}

export function formatPercent(value: number | null, digits = 2) {
  if (value === null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}%`
}
