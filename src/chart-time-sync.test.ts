import assert from 'node:assert/strict'
import test from 'node:test'
import { sharedChartEnd, sharedChartGesture, sharedChartViewport } from './chart-time-sync.ts'

test('different candle intervals have the same width and right edge but different time spans', () => {
  const end = Date.UTC(2026, 10, 20, 13, 24), spacing = 19.2, width = 1200
  for (const interval of [300_000, 900_000, 3_600_000]) {
    const last = Math.floor(end / interval) * interval
    const viewport = sharedChartViewport(end, spacing, interval, last)
    const domainEnd = last + viewport.offset * interval
    const x = (time: number) => width - spacing * 0.34 + (time - domainEnd) / interval * spacing
    assert.equal(viewport.spacing, spacing)
    assert.ok(Math.abs(x(end) - width) < 1e-9)
    assert.ok(Math.abs(x(end - width / spacing * interval) - 0) < 1e-9)
  }
})

test('pan uses the active interval and zoom preserves its anchor while sharing the right edge', () => {
  const now = Date.UTC(2026, 10, 20, 12), interval = 900_000, width = 1000, spacing = 20
  const original = { end: now, spacing, liveEnd: now, observedAt: now, follow: true, advancing: true, oldest: now - 72 * 3_600_000 }
  const past = sharedChartGesture(original, 'pan', -200, width, interval, 0.5, now)
  assert.equal(past.end, now - 10 * interval)
  assert.equal(past.follow, false)
  const anchor = 0.3
  const zoom = sharedChartGesture(past, 'zoom', -20, width, interval, anchor, now)
  assert.ok(zoom.spacing > past.spacing)
  assert.ok(Math.abs((zoom.end - width / zoom.spacing * interval * (1 - anchor)) - (past.end - width / spacing * interval * (1 - anchor))) < 1)
  assert.equal(sharedChartGesture(zoom, 'pan', 100_000, width, interval, 0.5, now).follow, true)
  assert.equal(sharedChartEnd(original, now + 5000), now + 5000)
  const wide = sharedChartGesture(past, 'zoom', 1000, width, interval, anchor, now)
  assert.ok(wide.spacing >= 4)
  assert.equal(sharedChartGesture(past, 'pan', -100_000, width, interval, 0.5, now).end, original.oldest)
  const anotherInterval = sharedChartGesture(original, 'pan', -200, width, 300_000, 0.5, now)
  assert.equal(anotherInterval.end, now - 10 * 300_000)
})
