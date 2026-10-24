export const STATISTICS_OI = 1
export const STATISTICS_TAKER = 2
const COMPLETE = STATISTICS_OI | STATISTICS_TAKER
// Source bits record actual bounded begin/end observations in one format.
// Legacy encodings are converted only by the archive importer.
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
  return (version & ~COMPLETE) === FORMAT ? version & COMPLETE : 0
}

export function statisticsVersionFor(sources) {
  return FORMAT | (sources & COMPLETE)
}
