import { Tabs } from '@base-ui/react/tabs'
import { CheckCircle2, ShieldAlert } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { formatCompact, formatPercent } from '../lib/format'
import type { AppSettings, BacktestReport, ValidationReport, WorkspaceSnapshot } from '../types'
import { DataPanel } from './DataPanel'

const StrategyLab = lazy(() => import('./StrategyLab').then(module => ({ default: module.StrategyLab })))
const AIAnalysis = lazy(() => import('./AIAnalysis').then(module => ({ default: module.AIAnalysis })))

type Props = {
  snapshot: WorkspaceSnapshot
  report: BacktestReport | null
  onReport(report: BacktestReport): void
  onValidate(): Promise<ValidationReport>
  onSaveSettings(settings: AppSettings): Promise<unknown>
}

export function InspectorPanel({ snapshot, report, onReport, onValidate, onSaveSettings }: Props) {
  const market = snapshot.markets.find(item => item.instrument.id === snapshot.selectedInstrument)
  return <aside className="inspector panel-edge">
    <Tabs.Root defaultValue="overview" className="inspector-tabs">
      <Tabs.List className="tab-list">
        <Tabs.Tab value="overview" className="tab">Overview</Tabs.Tab>
        <Tabs.Tab value="strategy" className="tab">Strategy</Tabs.Tab>
        <Tabs.Tab value="backtest" className="tab">Backtest</Tabs.Tab>
        <Tabs.Tab value="ai" className="tab">AI</Tabs.Tab>
        <Tabs.Tab value="data" className="tab">Data</Tabs.Tab>
        <Tabs.Indicator className="tab-indicator" />
      </Tabs.List>
      <Tabs.Panel value="overview" className="tab-panel">
        <div className="panel-title"><div><span className="section-kicker">CONTRACT</span><h2>{market?.instrument.baseCurrency ?? '—'} Perpetual</h2></div>{market?.eligible && <CheckCircle2 className="positive" size={17} />}</div>
        <section className="metric-section">
          <h3>Liquidity</h3>
          <Metric label="Bid–Ask spread" value={formatPercent(market?.liquidity.spreadPercent ?? null, false)} target={`< ${snapshot.settings.spreadLimitPercent}%`} />
          <Metric label="Bid depth" value={`${formatCompact(market?.liquidity.bidDepthUSDT ?? null)} USDT`} target={`> ${formatCompact(snapshot.settings.minimumSideDepthUSDT)}`} />
          <Metric label="Ask depth" value={`${formatCompact(market?.liquidity.askDepthUSDT ?? null)} USDT`} target={`> ${formatCompact(snapshot.settings.minimumSideDepthUSDT)}`} />
          <Metric label="Buy slippage" value={formatPercent(market?.liquidity.buySlippagePercent ?? null, false)} target={`< ${snapshot.settings.slippageLimitPercent}%`} />
          <Metric label="Sell slippage" value={formatPercent(market?.liquidity.sellSlippagePercent ?? null, false)} target={`< ${snapshot.settings.slippageLimitPercent}%`} />
        </section>
        <section className="metric-section">
          <h3>Market activity</h3>
          <Metric label="24h volume" value={`${formatCompact(market?.volume24hUSDT ?? null)} USDT`} />
          <Metric label="Open interest" value={`${formatCompact(market?.openInterestUSDT ?? null)} USDT`} />
          <Metric label="Funding" value={formatPercent(market?.fundingRatePercent ?? null)} />
          <Metric label="24h volume max / min" value={market?.hourlyVolumeRatio?.toFixed(2) ?? '—'} target={snapshot.settings.volumeStabilityEnabled ? `< ${snapshot.settings.maximumHourlyVolumeRatio}` : 'Optional'} />
        </section>
        {!!market?.missingRequirements.length && <div className="warning-card"><ShieldAlert size={16} /><span>Missing: {market.missingRequirements.join(', ')}</span></div>}
      </Tabs.Panel>
      <Tabs.Panel value="strategy" className="tab-panel strategy-tab"><Suspense fallback={<PanelLoading />}><StrategyLab mode="strategy" snapshot={snapshot} report={report} onReport={onReport} /></Suspense></Tabs.Panel>
      <Tabs.Panel value="backtest" className="tab-panel"><Suspense fallback={<PanelLoading />}><StrategyLab mode="backtest" snapshot={snapshot} report={report} onReport={onReport} /></Suspense></Tabs.Panel>
      <Tabs.Panel value="ai" className="tab-panel"><Suspense fallback={<PanelLoading />}><AIAnalysis snapshot={snapshot} report={report} onSaveSettings={onSaveSettings} /></Suspense></Tabs.Panel>
      <Tabs.Panel value="data" className="tab-panel"><DataPanel snapshot={snapshot} onValidate={onValidate} /></Tabs.Panel>
    </Tabs.Root>
  </aside>
}

function Metric({ label, value, target }: { label: string; value: string; target?: string }) {
  return <div className="metric-row"><span>{label}{target && <small>{target}</small>}</span><strong>{value}</strong></div>
}

function PanelLoading() { return <div className="placeholder-panel"><span>Loading strategy tools…</span></div> }
