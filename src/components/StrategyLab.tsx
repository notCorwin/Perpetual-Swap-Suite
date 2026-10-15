import { Button } from '@base-ui/react/button'
import { Input } from '@base-ui/react/input'
import { Select } from '@base-ui/react/select'
import { Switch } from '@base-ui/react/switch'
import { ChevronDown, Play, Save } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { listStrategies, readStrategy, runBacktest, saveStrategy } from '../lib/bridge'
import { formatDate, formatPercent } from '../lib/format'
import type { BacktestReport, BacktestRequest, StrategyDocument, StrategyExecutionOptions, StrategySummary, WorkspaceSnapshot } from '../types'

const CodeEditor = lazy(() => import('./CodeEditor').then(module => ({ default: module.CodeEditor })))

type Props = {
  mode: 'strategy' | 'backtest'
  snapshot: WorkspaceSnapshot
  report: BacktestReport | null
  onReport(report: BacktestReport): void
}

export function StrategyLab({ mode, snapshot, report, onReport }: Props) {
  const [strategies, setStrategies] = useState<StrategySummary[]>([])
  const [document, setDocument] = useState<StrategyDocument | null>(null)
  const [source, setSource] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [execution, setExecution] = useState<StrategyExecutionOptions>({ onHistoryTick: false, onOrderFill: false, processOrdersOnClose: false, verifyLimitTicks: 0 })

  useEffect(() => {
    let active = true
    void listStrategies().then(async values => {
      if (!active) return
      setStrategies(values)
      if (values[0]) {
        const loaded = await readStrategy(values[0].id)
        if (active) { setDocument(loaded); setSource(loaded.source) }
      }
    }).catch(cause => active && setError(String(cause)))
    return () => { active = false }
  }, [])

  const select = async (id: string | null) => {
    if (!id) return
    setPending(true)
    try { const loaded = await readStrategy(id); setDocument(loaded); setSource(loaded.source); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  const save = async () => {
    if (!document) return
    setPending(true)
    try { const saved = await saveStrategy({ ...document, source }); setDocument(saved); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  const run = async () => {
    if (!document || !snapshot.selectedInstrument) return
    setPending(true)
    try {
      if (source !== document.source) await save()
      const request: BacktestRequest = {
        strategyID: document.id, instrument: snapshot.selectedInstrument,
        timeframe: snapshot.settings.selectedTimeframe,
        from: snapshot.coverage?.from ?? null, through: snapshot.coverage?.through ?? null, execution,
      }
      onReport(await runBacktest(request)); setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }

  if (mode === 'strategy') return <div className="strategy-lab">
    <div className="strategy-toolbar">
      <Select.Root value={document?.id ?? null} onValueChange={select}>
        <Select.Trigger className="select-trigger strategy-select"><Select.Value placeholder="Select strategy" /><Select.Icon><ChevronDown size={12} /></Select.Icon></Select.Trigger>
        <Select.Portal><Select.Positioner sideOffset={4} className="select-positioner"><Select.Popup className="select-popup"><Select.List>{strategies.map(item => <Select.Item key={item.id} value={item.id} className="select-item"><Select.ItemText>{item.name}</Select.ItemText><Select.ItemIndicator>✓</Select.ItemIndicator></Select.Item>)}</Select.List></Select.Popup></Select.Positioner></Select.Portal>
      </Select.Root>
      <Button className="icon-button" aria-label="Save strategy" disabled={!document || pending} onClick={() => void save()}><Save size={13} /></Button>
    </div>
    <div className="strategy-file">{document ? `~/Library/Application Support/Perpetual Swap Suite/Strategies/${document.id}.mjs` : 'Loading strategy…'}</div>
    <Suspense fallback={<div className="editor-loading">Loading editor…</div>}><CodeEditor value={source} onChange={setSource} /></Suspense>
    {error && <div className="inline-error">{error}</div>}
  </div>

  return <div className="backtest-lab">
    <div className="panel-title"><div><span className="section-kicker">BROKER EMULATOR</span><h2>{document?.name ?? 'Strategy'}</h2></div><span className="detail-badge">5m OHLC</span></div>
    <section className="execution-options">
      <ExecutionSwitch label="On history bar tick" description="Run on each available OHLC tick" checked={execution.onHistoryTick} onChange={value => setExecution(current => ({ ...current, onHistoryTick: value }))} />
      <ExecutionSwitch label="After order fill" description="Recalculate immediately after fills" checked={execution.onOrderFill} onChange={value => setExecution(current => ({ ...current, onOrderFill: value }))} />
      <ExecutionSwitch label="Fill on bar close" description="Remove the default one-tick delay" checked={execution.processOrdersOnClose} onChange={value => setExecution(current => ({ ...current, processOrdersOnClose: value }))} />
      <label className="verify-field"><span>Limit verification<small>Ticks beyond limit price</small></span><Input type="number" min="0" value={execution.verifyLimitTicks} onChange={event => setExecution(current => ({ ...current, verifyLimitTicks: Number(event.target.value) }))} /></label>
    </section>
    <Button className="primary-button wide run-button" disabled={!document || pending || !snapshot.coverage?.candleCount} onClick={() => void run()}><Play size={12} />{pending ? 'Running…' : 'Run backtest'}</Button>
    {error && <div className="inline-error">{error}</div>}
    {report ? <BacktestResults report={report} /> : <div className="empty-report"><p>Run the current strategy against locally completed 5m candles.</p><small>{formatDate(snapshot.coverage?.from ?? null)} → {formatDate(snapshot.coverage?.through ?? null)}</small></div>}
  </div>
}

function ExecutionSwitch({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange(value: boolean): void }) {
  return <label className="execution-switch"><span><strong>{label}</strong><small>{description}</small></span><Switch.Root className="switch-root" checked={checked} onCheckedChange={onChange}><Switch.Thumb className="switch-thumb" /></Switch.Root></label>
}

function BacktestResults({ report }: { report: BacktestReport }) {
  return <div className="backtest-results">
    <div className="result-grid">
      <Result label="Return" value={formatPercent(report.returnPercent)} tone={report.returnPercent >= 0 ? 'positive' : 'negative'} />
      <Result label="Win rate" value={formatPercent(report.winRatePercent, false)} />
      <Result label="Max drawdown" value={formatPercent(-report.maximumDrawdownPercent, false)} tone="negative" />
      <Result label="Trades" value={String(report.totalTrades)} />
      <Result label="Liquidations" value={String(report.liquidations)} tone={report.liquidations ? 'negative' : undefined} />
      <Result label="Elapsed" value={`${report.elapsedMS} ms`} />
    </div>
    {report.warnings.map(warning => <div className="report-warning" key={warning}>{warning}</div>)}
    <h3 className="trade-heading">Trades · longest first</h3>
    <div className="trade-list">{report.trades.map((trade, index) => <div className="trade-row" key={`${trade.entryAt}-${index}`}>
      <span className={`trade-direction ${trade.direction}`}>{trade.direction === 'long' ? 'LONG' : 'SHORT'}</span>
      <span><strong className={trade.netPnLUSDT >= 0 ? 'positive' : 'negative'}>{trade.netPnLUSDT >= 0 ? '+' : ''}{trade.netPnLUSDT.toFixed(2)} USDT</strong><small>{formatPercent(trade.returnOnMarginPercent)}</small></span>
      <span><strong>{formatDuration(trade.durationMS)}</strong><small>{trade.exitReason}</small></span>
    </div>)}</div>
  </div>
}

function Result({ label, value, tone }: { label: string; value: string; tone?: string }) { return <div className="result-card"><span>{label}</span><strong className={tone}>{value}</strong></div> }
function formatDuration(milliseconds: number) { const hours = milliseconds / 3_600_000; return hours < 24 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(1)}d` }
