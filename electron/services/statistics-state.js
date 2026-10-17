export const STATISTICS_OI = 1
export const STATISTICS_TAKER = 2
const COMPLETE = STATISTICS_OI | STATISTICS_TAKER
// Version 8 records actual bounded begin/end observations. Version 4 could
// mark a range unavailable without asking its source; those null leases must
// be rechecked, while genuine numeric history remains reusable.
const FORMAT = 8
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function validTakerVolumes(candle, volumes = candle) {
  const buy = volumes?.buy, sell = volumes?.sell
  if (!nonnegative(buy) || !nonnegative(sell)) return null
  if (candle.confirmed && buy === 0 && sell === 0 && (candle.volume > 0 || candle.quoteVolume > 0)) return null
  return { buy, sell }
}

export function statisticsMask(row) {
  const version = row?.statisticsVersion ?? 0
  if (version & FORMAT) return version & COMPLETE
  const prior = version === 1 ? COMPLETE : version & 4 ? version & COMPLETE : 0
  return (prior & STATISTICS_OI && nonnegative(row.oi) ? STATISTICS_OI : 0)
    | (prior & STATISTICS_TAKER && validTakerVolumes(row) ? STATISTICS_TAKER : 0)
}

export function statisticsVersionFor(sources, values) {
  return sources === COMPLETE && nonnegative(values.oi) && validTakerVolumes(values)
    ? 1 : FORMAT | (sources & COMPLETE)
}
