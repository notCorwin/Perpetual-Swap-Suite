export const monoNumber = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 })
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })

export function formatPrice(value: number | null) {
  return value === null ? '—' : monoNumber.format(value)
}

export function formatPercent(value: number | null, sign = true) {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${sign && value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

export function formatCompact(value: number | null) {
  return value === null ? '—' : compact.format(value)
}

export function formatDate(value: number | null) {
  return value === null ? '—' : new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', hour12: false })
}
