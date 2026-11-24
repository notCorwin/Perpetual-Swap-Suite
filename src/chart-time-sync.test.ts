import assert from 'node:assert/strict'
import test from 'node:test'
import { sharedChartEnd, sharedChartGesture, sharedChartLiveEnd, sharedChartViewport } from './chart-time-sync.ts'
import { chartPitchBodyWidth } from './chart-layout.ts'

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

test('a shared live boundary contains forming candle bodies and outlines at each interval rollover', () => {
  const hour = 3_600_000, intervals = [hour, hour / 4, hour / 12], start = Date.UTC(2026, 10, 20, 12), spacing = 19.2
  for (const minutes of [0, 1, 5, 15, 21, 45, 59, 60]) {
    const observed = start + minutes * 60_000
    const bars = intervals.map(interval => ({ interval, open: Math.floor(observed / interval) * interval }))
    const end = Math.max(...bars.map(({ interval, open }) => sharedChartLiveEnd(open, interval, observed, spacing)))
    for (const { interval, open } of bars) {
      const viewport = sharedChartViewport(end, spacing, interval, open)
      const domainEnd = open + viewport.offset * interval
      const bodyRight = -chartPitchBodyWidth(spacing) / 2 + (open - domainEnd) / interval * spacing + chartPitchBodyWidth(spacing) / 2
      assert.ok(bodyRight <= -1 + 1e-8, `minute ${minutes}, interval ${interval}: candle outline must fit`)
    }
  }
})

test('a non-advancing live boundary stays put between quotes while its candle margin leads time', () => {
  const start = Date.UTC(2026, 10, 20, 12), interval = 3_600_000, spacing = 19.2
  const first = start + 60_000
  const initialEnd = sharedChartLiveEnd(start, interval, first, spacing)
  const current = { end: initialEnd, spacing, liveEnd: initialEnd, observedAt: first, follow: true, advancing: false, oldest: 0 }
  const nextQuote = first + 30_000
  assert.equal(sharedChartEnd(current, nextQuote), initialEnd, 'wall time alone must not advance the reserved boundary')
  assert.equal(sharedChartLiveEnd(start, interval, nextQuote, spacing), initialEnd, 'a later quote inside the reserved margin must not move it backward')
  const gesture = sharedChartGesture(current, 'pan', 0, 1000, interval, 0.5, nextQuote)
  assert.equal(gesture.advancing, false)
  assert.equal(gesture.end, initialEnd)
  const afterMargin = initialEnd + 60_000
  assert.equal(sharedChartLiveEnd(start, interval, afterMargin, spacing), afterMargin, 'observed time can advance the boundary after the margin')
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

test('zooming out and back in recomputes liveEnd from liveAnchor without permanent rightward drift', () => {
  const hour = 3_600_000, width = 1000, start = Date.UTC(2026, 10, 20, 12), observed = start + 60_000, spacing = 20
  const initialLiveEnd = sharedChartLiveEnd(start, hour, observed, spacing)
  const initial = { end: initialLiveEnd, spacing, liveEnd: initialLiveEnd, observedAt: observed, follow: true, advancing: false, oldest: 0, liveAnchor: { lastBar: start, interval: hour, observed } }
  const zoomedOut = sharedChartGesture(initial, 'zoom', 50, width, hour, 1, observed)
  assert.ok(zoomedOut.liveEnd > initialLiveEnd)
  const zoomedIn = sharedChartGesture(zoomedOut, 'zoom', -50, width, hour, 1, observed)
  assert.ok(Math.abs(zoomedIn.liveEnd - initialLiveEnd) < 1, 'zooming back in should restore the original liveEnd without drift')
})
