import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, ChevronLeft, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Plot, chartGutter } from '@/MarketChart'
import { chartHourX, chartLayout } from '@/chart-layout'
import { requestResearch, researchTime, RESEARCH_HOUR, type ResearchChartData, type ResearchEvent } from '@/research-types'

export function ResearchChart({ event, onNavigate }: { event: ResearchEvent; onNavigate: (step: number) => void }) {
  const [data, setData] = useState<ResearchChartData | null>(null)
  const [end, setEnd] = useState<number | undefined>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [inspection, setInspection] = useState<number | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const section = useRef<HTMLElement>(null), viewport = useRef<HTMLDivElement>(null)
  const wheel = useRef(0)
  const move = useCallback((hours: number) => {
    if (!data) return
    const minimum = Math.min(data.latestHour ?? data.endHour, (data.oldestHour ?? data.endHour) + 95 * RESEARCH_HOUR)
    setEnd(Math.max(minimum, Math.min(data.latestHour ?? data.endHour, data.endHour + hours * RESEARCH_HOUR)))
  }, [data])
  useEffect(() => {
    let stopped = false
    const frame = window.requestAnimationFrame(() => { if (!stopped) { setLoading(true); setError('') } })
    void requestResearch({ action: 'chart', eventID: event.id, endHour: end }).then(response => {
      if (!stopped && response.chart) { setData(response.chart); setInspection(null) }
    }).catch(cause => { if (!stopped) setError(cause instanceof Error ? cause.message : 'Cannot read this frozen chart.') })
      .finally(() => { if (!stopped) setLoading(false) })
    return () => { stopped = true; window.cancelAnimationFrame(frame) }
  }, [event.id, end])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  const capture = async () => {
    const rect = section.current?.getBoundingClientRect()
    if (!rect) return
    setCopying(true); setError('')
    try {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Cannot resolve the chart background.')
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-snapshot-background')
      context.fillRect(0, 0, 1, 1)
      const backgroundRGB = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(value => value / 255)
      await window.webkit.messageHandlers.radar.postMessage({ captureChart: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, backgroundRGB } })
      setCopied(true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Cannot copy the chart.') }
    finally { setCopying(false) }
  }
  const bars = data?.bars ?? [], active = bars[inspection ?? bars.length - 1]
  const layout = bars.length ? chartLayout(size.width, size.height, chartGutter(bars, size.height).gutter) : null
  const inspect = (x: number, rect: DOMRect) => {
    if (!layout || !data) return
    const local = (x - rect.left) / rect.width * size.width
    let nearest = 0, distance = Infinity
    bars.forEach((bar, index) => { const d = Math.abs(chartHourX(bar.hour, data.endHour, ...layout.columns.price) - local); if (d < distance) { nearest = index; distance = d } })
    setInspection(nearest)
  }
  return <section aria-label="Frozen event chart" className="flex flex-col gap-2">
    <div className="flex items-center gap-2">
      <Badge variant="secondary">Frozen · 1h</Badge>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{active ? researchTime(active.hour) : 'Loading frozen data…'}</span>
      <Button variant="ghost" size="sm" aria-label="Earlier chart hours" disabled={!data || loading} onClick={() => move(-24)}><ChevronLeft data-icon="inline-start" aria-hidden="true" />24h</Button>
      <Button variant="ghost" size="sm" aria-label="Later chart hours" disabled={!data || loading} onClick={() => move(24)}>24h<ChevronRight data-icon="inline-end" aria-hidden="true" /></Button>
      <Button variant="outline" size="sm" disabled={!bars.length || copying} onClick={() => void capture()}>{copying ? <Spinner data-icon="inline-start" /> : <Camera data-icon="inline-start" aria-hidden="true" />}{copied ? 'Copied' : 'Copy chart'}</Button>
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <section ref={section} data-surface="panel" className="relative rounded-lg border bg-chart-surface" aria-label={event.instrument + ' research chart'}>
      {active && <div className="flex items-center gap-4 border-b px-3 py-2 text-xs">
        <span className="font-medium">{event.instrument}</span>
        {(['open', 'high', 'low', 'close'] as const).map(key => <span key={key}><span className="text-muted-foreground capitalize">{key} </span>{new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 }).format(active[key])}</span>)}
      </div>}
      <div ref={viewport} className="h-(--research-chart-height) overflow-hidden" onWheel={e => {
        e.preventDefault(); wheel.current += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : -e.deltaY
        if (Math.abs(wheel.current) >= 96 && !loading) { move(wheel.current > 0 ? 8 : -8); wheel.current = 0 }
      }}>
        {bars.length > 0 && size.width > 0 && data ? <svg viewBox={'0 0 ' + size.width + ' ' + size.height} className="size-full select-none focus-visible:outline-2 focus-visible:outline-ring" role="img" tabIndex={0} aria-label="Frozen 96-hour event chart. Hold to inspect. Left and right review hours; up and down select events." onKeyDown={e => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); move(e.key === 'ArrowLeft' ? -8 : 8) }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); onNavigate(e.key === 'ArrowUp' ? -1 : 1) }
        }} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); inspect(e.clientX, e.currentTarget.getBoundingClientRect()) }} onPointerMove={e => {
          if (e.buttons & 1) { inspect(e.clientX, e.currentTarget.getBoundingClientRect()) }
        }} onPointerUp={() => setInspection(null)} onPointerCancel={() => setInspection(null)}>
          <Plot bars={bars} liveBar={bars[bars.length - 1]} inspected={inspection} width={size.width} height={size.height} now={0} endHour={data.endHour} />
          {data.signalHour >= data.endHour - 95 * RESEARCH_HOUR && data.signalHour <= data.endHour && (() => {
            const layout = chartLayout(size.width, size.height, chartGutter(bars, size.height).gutter)
            const x = chartHourX(data.signalHour, data.endHour, ...layout.columns.price)
            return <g aria-label="Signal candle"><line x1={x} x2={x} y1={layout.panels.price[0]} y2={layout.panels.price[1]} stroke="var(--chart-4)" strokeDasharray="4 3" /><text x={x + 4} y={layout.panels.price[0] + 14} fill="var(--chart-4)" className="text-xs">Signal</text></g>
          })()}
        </svg> : <p role="status" className="flex h-full items-center justify-center gap-2 text-muted-foreground">{loading && <Spinner />}{loading ? 'Loading frozen chart…' : 'No candles in this frozen range.'}</p>}
      </div>
    </section>
    <p className="text-xs text-muted-foreground">Signal close: {researchTime(event.timestamp)} · Reference entry: next-hour open · No live updates</p>
  </section>
}
