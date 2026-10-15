import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, HistogramSeries, LineSeries, type UTCTimestamp } from 'lightweight-charts'
import { useEffect, useMemo, useRef } from 'react'
import { ema, rsi } from '../lib/indicators'
import { formatPercent, formatPrice } from '../lib/format'
import type { BacktestMarker, Candle, MarketSummary, Timeframe } from '../types'

type Props = {
  market?: MarketSummary
  candles: Candle[]
  forming: Candle | null
  timeframe: Timeframe
  markers: BacktestMarker[]
}

function css(name: string) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() }

export function MarketChart({ market, candles, forming, timeframe, markers }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const data = useMemo(() => forming ? [...candles.filter(candle => candle.timestamp !== forming.timestamp), forming] : candles, [candles, forming])
  const latest = data.at(-1)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const chart = createChart(element, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: css('--muted-text'), fontFamily: 'SF Mono, ui-monospace, monospace', fontSize: 10, panes: { separatorColor: css('--border'), separatorHoverColor: css('--accent') } },
      grid: { vertLines: { color: css('--chart-grid') }, horzLines: { color: css('--chart-grid') } },
      rightPriceScale: { borderColor: css('--border'), scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: css('--border'), timeVisible: true, secondsVisible: false, rightOffset: 5, barSpacing: 8 },
      crosshair: { vertLine: { color: css('--crosshair') }, horzLine: { color: css('--crosshair') } },
    })
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: css('--positive'), downColor: css('--negative'), borderVisible: false,
      wickUpColor: css('--positive'), wickDownColor: css('--negative'), priceLineVisible: true,
    })
    candleSeries.setData(data.map(candle => ({
      time: Math.floor(candle.timestamp / 1000) as UTCTimestamp,
      open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    })))
    createSeriesMarkers(candleSeries, markers.map(marker => ({
      time: Math.floor(marker.timestamp / 1000) as UTCTimestamp,
      position: marker.kind === 'long' ? 'belowBar' as const : marker.kind === 'short' ? 'aboveBar' as const : 'inBar' as const,
      shape: marker.kind === 'long' ? 'arrowUp' as const : marker.kind === 'short' ? 'arrowDown' as const : 'circle' as const,
      color: marker.kind === 'liquidation' || marker.kind === 'short' ? css('--negative') : css('--positive'),
      text: marker.label,
    })))
    const ema20 = ema(data, 20)
    const ema50 = ema(data, 50)
    const ema200 = ema(data, 200)
    for (const [values, color, width] of [[ema20, css('--ema-fast'), 1], [ema50, css('--ema-mid'), 1], [ema200, css('--ema-slow'), 2]] as const) {
      const series = chart.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false })
      series.setData(values.map((value, index) => ({ time: Math.floor(data[index].timestamp / 1000) as UTCTimestamp, value })))
    }
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 1)
    volume.setData(data.map(candle => ({
      time: Math.floor(candle.timestamp / 1000) as UTCTimestamp, value: candle.volumeQuote ?? candle.volumeContracts,
      color: candle.close >= candle.open ? css('--positive-soft') : css('--negative-soft'),
    })))
    const rsiValues = rsi(data)
    const rsiSeries = chart.addSeries(LineSeries, { color: css('--rsi'), lineWidth: 1, priceLineVisible: false, lastValueVisible: true }, 2)
    rsiSeries.setData(rsiValues.flatMap((value, index) => value === null ? [] : [{ time: Math.floor(data[index].timestamp / 1000) as UTCTimestamp, value }]))
    const panes = chart.panes()
    panes[1]?.setHeight(92)
    panes[2]?.setHeight(108)
    chart.timeScale().fitContent()
    const observer = new ResizeObserver(() => chart.timeScale().applyOptions({ barSpacing: Math.max(3, Math.min(9, element.clientWidth / Math.max(80, data.length))) }))
    observer.observe(element)
    return () => { observer.disconnect(); chart.remove() }
  }, [data, markers])

  return <section className="chart-workspace">
    <div className="instrument-strip">
      <div>
        <span className="instrument-title">{market?.instrument.id ?? 'Select a contract'}</span>
        <span className="instrument-meta">OKX · PERPETUAL · {timeframe}</span>
      </div>
      <div className="quote-strip">
        <div><span>LAST</span><strong>{formatPrice(latest?.close ?? market?.last ?? null)}</strong></div>
        <div><span>24H</span><strong className={(market?.change24hPercent ?? 0) >= 0 ? 'positive' : 'negative'}>{formatPercent(market?.change24hPercent ?? null)}</strong></div>
        <div><span>HIGH</span><strong>{formatPrice(latest?.high ?? null)}</strong></div>
        <div><span>LOW</span><strong>{formatPrice(latest?.low ?? null)}</strong></div>
      </div>
      <div className="indicator-legend"><span className="ema-fast">EMA 20</span><span className="ema-mid">EMA 50</span><span className="ema-slow">EMA 200</span><span className="rsi-color">RSI 14</span></div>
    </div>
    <div ref={container} className="chart-canvas" aria-label={`${market?.instrument.id ?? 'Market'} candlestick and indicator chart`} />
  </section>
}
