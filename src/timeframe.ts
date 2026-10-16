export type RadarTimeframe = '5m' | '15m' | '1H'

export const RADAR_TIMEFRAMES: { value: RadarTimeframe; label: string }[] = [
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1H', label: '1h' },
]

export const timeframeMilliseconds = (timeframe: RadarTimeframe): number =>
  timeframe === '5m' ? 5 * 60_000 : timeframe === '15m' ? 15 * 60_000 : 3_600_000

export const timeframeLabel = (timeframe: RadarTimeframe): string =>
  RADAR_TIMEFRAMES.find(item => item.value === timeframe)?.label ?? timeframe
