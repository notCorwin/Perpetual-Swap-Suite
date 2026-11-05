type Price = number | null | undefined

// Every finite JS number has at most 17 significant decimal digits. Keeping
// 21 preserves its source representation, including prices smaller than 1e-100.
const historicalFormatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 21 })
const indicatorFormatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 })
const currentFormatters = new Map<number, Intl.NumberFormat>()

function priceDecimals(tickSz: string | null | undefined): number | null {
  if (typeof tickSz !== 'string') return null
  const tick = tickSz.trim()
  const match = /^\+?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(tick)
  if (!match || !Number.isFinite(Number(tick)) || Number(tick) <= 0) return null
  const fraction = match[2] ?? '', coefficient = match[1] + fraction
  const exponent = Number(match[3] ?? 0)
  if (!coefficient || !Number.isSafeInteger(exponent)) return null
  const trailingZeros = coefficient.length - coefficient.replace(/0+$/, '').length
  const decimals = Math.max(0, fraction.length - exponent - trailingZeros)
  // Intl supports at most 100 fraction digits. Unknown precision must not
  // invent padding or round a source price to an unrelated decimal limit.
  return decimals <= 100 ? decimals : null
}

function formatted(value: Price, formatter: Intl.NumberFormat): string {
  return value == null || !Number.isFinite(value) ? '—' : formatter.format(value === 0 ? 0 : value)
}

/** Current traded prices follow the contract's normalized tick precision. */
export function formatCurrentPrice(value: Price, tickSz?: string | null): string {
  const decimals = priceDecimals(tickSz)
  if (decimals === null) return formatHistoricalPrice(value)
  let formatter = currentFormatters.get(decimals)
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    currentFormatters.set(decimals, formatter)
  }
  return formatted(value, formatter)
}

/** Historical prices can predate a tick-size change; retain their source digits. */
export function formatHistoricalPrice(value: Price): string {
  return formatted(value, historicalFormatter)
}

/** Derived values keep their own significant-digit display, never tick rounding. */
export function formatIndicatorPrice(value: Price): string {
  return formatted(value, indicatorFormatter)
}
