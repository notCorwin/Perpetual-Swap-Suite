// Choose a stable candle interval with room for a full label at the current zoom.
export function chartTimeTickStep(barPitch: number, labelWidth: number, gap: number) {
  const minimum = Math.max(1, Math.ceil((labelWidth + gap) / Math.max(barPitch, 0.001)))
  return [1, 2, 3, 4, 6, 12, 24].find(step => step >= minimum) ?? Math.ceil(minimum / 24) * 24
}

/** Regular ticks over a time viewport, independent of available candles. */
export function chartTimeTicks(start: number, end: number, intervalMS: number, step: number, offsetMinutes = new Date(start).getTimezoneOffset()) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !Number.isFinite(intervalMS) || intervalMS <= 0 || !Number.isFinite(offsetMinutes) || !Number.isInteger(step) || step < 1) return []
  const offsetBars = Math.round(-offsetMinutes * 60_000 / intervalMS)
  const firstBar = Math.ceil(start / intervalMS)
  const remainder = ((firstBar + offsetBars) % step + step) % step
  const first = (firstBar + (step - remainder) % step) * intervalMS
  const ticks: number[] = []
  for (let tick = first; tick <= end; tick += step * intervalMS) ticks.push(tick)
  return ticks
}

const axisDateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const axisTimeFormatter = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** Lay out labels within the plot. Dates are shown at the first label and on day changes. */
export function chartTimeLabels(ticks: readonly { hour: number; x: number }[], left: number, right: number, gap: number, measure: (label: string, major: boolean) => number) {
  const labels: { hour: number; x: number; label: string; major: boolean; anchor: 'start' | 'middle' | 'end'; left: number; right: number }[] = []
  let previousDay = '', previousRight = left - gap
  for (const tick of ticks) {
    const date = new Date(tick.hour)
    const day = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    const dateChanged = day !== previousDay
    // A date boundary is the meaningful anchor across all timeframes. Marking
    // every whole hour as major makes every 1h label bold.
    const major = dateChanged
    const clock = axisTimeFormatter.format(date)
    const label = dateChanged ? `${axisDateFormatter.format(date)}, ${clock}` : clock
    const width = measure(label, major)
    if (!Number.isFinite(width) || width > right - left) continue
    if (tick.x < left || tick.x > right) continue
    const anchor = tick.x - width / 2 >= left && tick.x + width / 2 <= right ? 'middle'
      : tick.x + width <= right ? 'start' : tick.x - width >= left ? 'end' : null
    if (!anchor) continue
    const labelLeft = anchor === 'start' ? tick.x : anchor === 'end' ? tick.x - width : tick.x - width / 2
    const labelRight = labelLeft + width
    if (labelLeft < previousRight + gap) continue
    labels.push({ hour: tick.hour, x: tick.x, label, major, anchor, left: labelLeft, right: labelRight })
    previousDay = day
    previousRight = labelRight
  }
  return labels
}
