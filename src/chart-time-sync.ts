import { CHART_MAX_WINDOW_BARS } from '../electron/chart-viewport.js'

export type SharedChartTime = { end: number; span: number; follow: boolean; liveEnd: number; observedAt: number; advancing: boolean; oldest: number }
const FIVE_MINUTES = 300_000
const ONE_HOUR = 3_600_000

export function sharedChartEnd(value: SharedChartTime, now: number) {
  return value.follow && value.advancing ? value.liveEnd + Math.max(0, now - value.observedAt) : value.end
}

export function sharedChartGesture(value: SharedChartTime, kind: 'pan' | 'zoom', pixels: number, width: number, anchor: number, now: number): SharedChartTime {
  if (!(width > 0) || !Number.isFinite(pixels)) return value
  const end = sharedChartEnd(value, now)
  const liveEnd = value.liveEnd + (value.advancing ? Math.max(0, now - value.observedAt) : 0)
  const minSpan = width / 100 * ONE_HOUR
  const maxSpan = (CHART_MAX_WINDOW_BARS - 96) * FIVE_MINUTES
  const span = kind === 'zoom' ? Math.max(minSpan, Math.min(maxSpan, value.span * Math.exp(Math.max(-20, Math.min(20, pixels * 0.01))))) : value.span
  const target = kind === 'pan' ? end + pixels / width * span : end + (span - value.span) * (1 - Math.max(0, Math.min(1, anchor)))
  const nextEnd = Math.max(value.oldest, Math.min(liveEnd, target))
  return { end: nextEnd, span, follow: nextEnd >= liveEnd, liveEnd, observedAt: now, advancing: value.advancing, oldest: value.oldest }
}

/** Match the existing candle-center geometry to a common plot-edge time. */
export function sharedChartViewport(end: number, span: number, width: number, interval: number, lastBar: number) {
  return { spacing: width * interval / span, offset: (end - interval * 0.34 - lastBar) / interval }
}
