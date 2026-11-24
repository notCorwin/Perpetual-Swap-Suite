import { CHART_MAX_WINDOW_BARS } from '../electron/chart-viewport.js'
import { CHART_MAX_SPACING, CHART_MIN_SPACING, chartPitchBodyWidth } from './chart-layout.ts'

export type SharedChartTime = {
  end: number
  spacing: number
  follow: boolean
  liveEnd: number
  observedAt: number
  advancing: boolean
  oldest: number
  liveAnchor?: { lastBar: number; interval: number; observed: number }
}

export function sharedChartEnd(value: SharedChartTime, now: number) {
  return value.follow && value.advancing ? value.liveEnd + Math.max(0, now - value.observedAt) : value.end
}

/** Keep the latest candle's entire body inside the shared live viewport. */
export function sharedChartLiveEnd(lastBar: number, interval: number, observed: number, spacing: number) {
  // One pixel also keeps the 1px candle outline inside the plot clip.
  return Math.max(observed, lastBar + interval * (chartPitchBodyWidth(1) / 2 + 1 / spacing))
}

export function sharedChartGesture(value: SharedChartTime, kind: 'pan' | 'zoom', pixels: number, width: number, interval: number, anchor: number, now: number): SharedChartTime {
  if (!(width > 0) || !(interval > 0) || !Number.isFinite(pixels)) return value
  const end = sharedChartEnd(value, now)
  const minSpacing = Math.min(CHART_MAX_SPACING, Math.max(CHART_MIN_SPACING, width / (CHART_MAX_WINDOW_BARS - 96)))
  const spacing = kind === 'zoom' ? Math.max(minSpacing, Math.min(CHART_MAX_SPACING, value.spacing * Math.exp(Math.max(-20, Math.min(20, -pixels * 0.01))))) : value.spacing
  const baseLiveEnd = kind === 'zoom' && value.liveAnchor
    ? sharedChartLiveEnd(value.liveAnchor.lastBar, value.liveAnchor.interval, value.liveAnchor.observed, spacing)
    : value.liveEnd
  const liveEnd = baseLiveEnd + (value.advancing ? Math.max(0, now - value.observedAt) : 0)
  const oldSpan = width / value.spacing * interval
  const newSpan = width / spacing * interval
  const target = kind === 'pan' ? end + pixels / value.spacing * interval : end + (newSpan - oldSpan) * (1 - Math.max(0, Math.min(1, anchor)))
  const nextEnd = Math.max(value.oldest, Math.min(liveEnd, target))
  return { end: nextEnd, spacing, follow: nextEnd >= liveEnd, liveEnd, observedAt: now, advancing: value.advancing, oldest: value.oldest, ...(value.liveAnchor ? { liveAnchor: value.liveAnchor } : {}) }
}

/** Match the existing candle-center geometry to a common plot-edge time. */
export function sharedChartViewport(end: number, spacing: number, interval: number, lastBar: number) {
  return { spacing, offset: (end - interval * chartPitchBodyWidth(1) / 2 - lastBar) / interval }
}
