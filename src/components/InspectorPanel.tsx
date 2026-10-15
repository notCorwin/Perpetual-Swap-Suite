import { Button } from '@base-ui/react/button'
import { Tabs } from '@base-ui/react/tabs'
import { CheckCircle2, Database, Play, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { formatCompact, formatDate, formatPercent } from '../lib/format'
import type { ValidationReport, WorkspaceSnapshot } from '../types'

type Props = { snapshot: WorkspaceSnapshot; onValidate(): Promise<ValidationReport> }

export function InspectorPanel({ snapshot, onValidate }: Props) {
  const market = snapshot.markets.find(item => item.instrument.id === snapshot.selectedInstrument)
  const [validation, setValidation] = useState<ValidationReport | null>(null)
  const [validating, setValidating] = useState(false)

  const validate = async () => {
    setValidating(true)
    try { setValidation(await onValidate()) } finally { setValidating(false) }
  }

  return <aside className="inspector panel-edge">
    <Tabs.Root defaultValue="overview" className="inspector-tabs">
      <Tabs.List className="tab-list">
        <Tabs.Tab value="overview" className="tab">Overview</Tabs.Tab>
        <Tabs.Tab value="strategy" className="tab">Strategy</Tabs.Tab>
        <Tabs.Tab value="backtest" className="tab">Backtest</Tabs.Tab>
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
        </section>
        {!!market?.missingRequirements.length && <div className="warning-card"><ShieldAlert size={16} /><span>Missing: {market.missingRequirements.join(', ')}</span></div>}
      </Tabs.Panel>
      <Tabs.Panel value="strategy" className="tab-panel placeholder-panel">
        <div className="placeholder-icon">JS</div><h3>JavaScript strategy</h3><p>The code editor and dual order API are installed in the next stage.</p>
      </Tabs.Panel>
      <Tabs.Panel value="backtest" className="tab-panel placeholder-panel">
        <Play size={24} /><h3>Broker emulator</h3><p>TradingView-style 5m execution will run here without synthetic interpolation.</p>
      </Tabs.Panel>
      <Tabs.Panel value="data" className="tab-panel">
        <div className="panel-title"><div><span className="section-kicker">PARQUET</span><h2>Data coverage</h2></div><Database size={17} /></div>
        <section className="metric-section">
          <Metric label="Completed candles" value={snapshot.coverage?.candleCount.toLocaleString() ?? '—'} />
          <Metric label="From" value={formatDate(snapshot.coverage?.from ?? null)} />
          <Metric label="Through" value={formatDate(snapshot.coverage?.through ?? null)} />
          <Metric label="Detected gaps" value={String(snapshot.coverage?.gaps ?? 0)} />
        </section>
        <Button className="primary-button wide" disabled={validating} onClick={() => void validate()}>{validating ? 'Validating…' : 'Validate local data'}</Button>
        {validation && <div className={validation.invalidFiles.length || validation.duplicateCandles ? 'warning-card' : 'success-card'}>
          {validation.invalidFiles.length || validation.duplicateCandles ? <ShieldAlert size={16} /> : <CheckCircle2 size={16} />}
          <span>{validation.checkedFiles} files checked · {validation.invalidFiles.length} invalid · {validation.duplicateCandles} duplicate candles</span>
        </div>}
      </Tabs.Panel>
    </Tabs.Root>
  </aside>
}

function Metric({ label, value, target }: { label: string; value: string; target?: string }) {
  return <div className="metric-row"><span>{label}{target && <small>{target}</small>}</span><strong>{value}</strong></div>
}
