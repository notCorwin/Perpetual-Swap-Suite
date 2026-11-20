import assert from 'node:assert/strict'
import test from 'node:test'
import { sharedChartEnd, sharedChartGesture, sharedChartViewport } from './chart-time-sync.ts'

test('each candle interval maps the same absolute times to the same pixels', () => {
  const end = Date.UTC(2026, 10, 20, 13, 24), span = 48 * 3_600_000, width = 1200
  for (const interval of [300_000, 900_000, 3_600_000]) {
    const last = Math.floor(end / interval) * interval
    const { spacing, offset } = sharedChartViewport(end, span, width, interval, last)
    const domainEnd = last + offset * interval
    const x = (time: number) => width - spacing * 0.34 + (time - domainEnd) / interval * spacing
    assert.ok(Math.abs(x(end) - width) < 1e-9)
    assert.ok(Math.abs(x(end - span / 2) - width / 2) < 1e-9)
    assert.ok(Math.abs(x(end - span)) < 1e-9)
  }
})

test('pan and zoom share time coordinates, preserve the zoom anchor and respect the live edge', () => {
  const now = Date.UTC(2026, 10, 20, 12), span = 48 * 3_600_000
  const original = { end: now, span, liveEnd: now, observedAt: now, follow: true, advancing: true, oldest: now - 72 * 3_600_000 }
  const past = sharedChartGesture(original, 'pan', -200, 1000, 0.5, now)
  assert.equal(past.end, now - span / 5)
  assert.equal(past.follow, false)
  const anchor = 0.3
  const zoom = sharedChartGesture(past, 'zoom', -20, 1000, anchor, now)
  assert.ok(Math.abs((zoom.end - zoom.span * (1 - anchor)) - (past.end - span * (1 - anchor))) < 1)
  assert.equal(sharedChartGesture(zoom, 'pan', 100_000, 1000, 0.5, now).follow, true)
  assert.equal(sharedChartEnd(original, now + 5000), now + 5000)
  const wide = sharedChartGesture(past, 'zoom', 1000, 1000, anchor, now)
  assert.ok(wide.span <= (1536 - 96) * 300_000)
  assert.equal(sharedChartGesture(past, 'pan', -100_000, 1000, 0.5, now).end, original.oldest)
})
