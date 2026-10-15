import { Button } from '@base-ui/react/button'
import { Checkbox } from '@base-ui/react/checkbox'
import { Check, CheckCircle2, Database, Download, ShieldAlert, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cancelDataSync, dataSyncStatus, startDataSync } from '../lib/bridge'
import { formatDate } from '../lib/format'
import type { DataSyncStatus, ValidationReport, WorkspaceSnapshot } from '../types'

type Props = { snapshot: WorkspaceSnapshot; onValidate(): Promise<ValidationReport> }

const emptyStatus: DataSyncStatus = { active: false, instruments: [], completedInstruments: 0, currentInstrument: null, downloadedCandles: 0, downloadedFundingRates: 0, startedAt: null, finishedAt: null, error: null }

export function DataPanel({ snapshot, onValidate }: Props) {
  const [selected, setSelected] = useState(() => new Set(snapshot.selectedInstrument ? [snapshot.selectedInstrument] : []))
  const [status, setStatus] = useState(emptyStatus)
  const [validation, setValidation] = useState<ValidationReport | null>(null)
  const [validating, setValidating] = useState(false)
  const ids = useMemo(() => snapshot.markets.map(market => market.instrument.id), [snapshot.markets])

  useEffect(() => {
    let stopped = false
    let timer = 0
    const poll = async () => {
      const next = await dataSyncStatus()
      if (stopped) return
      setStatus(next)
      if (next.active) timer = window.setTimeout(poll, 1_000)
    }
    void poll()
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [status.active])

  const toggle = (id: string, checked: boolean) => setSelected(current => {
    const next = new Set(current)
    if (checked) next.add(id); else next.delete(id)
    return next
  })
  const validate = async () => {
    setValidating(true)
    try { setValidation(await onValidate()) } finally { setValidating(false) }
  }

  return <div className="data-panel">
    <div className="panel-title"><div><span className="section-kicker">PARQUET</span><h2>Data coverage</h2></div><Database size={17} /></div>
    <section className="metric-section">
      <Metric label="Completed candles" value={snapshot.coverage?.candleCount.toLocaleString() ?? '—'} />
      <Metric label="From" value={formatDate(snapshot.coverage?.from ?? null)} />
      <Metric label="Through" value={formatDate(snapshot.coverage?.through ?? null)} />
      <Metric label="Detected gaps" value={String(snapshot.coverage?.gaps ?? 0)} />
    </section>
    <div className="data-actions">
      <Button className="secondary-button" disabled={validating} onClick={() => void validate()}>{validating ? 'Validating…' : 'Validate'}</Button>
      {status.active
        ? <Button className="secondary-button" onClick={() => void cancelDataSync().then(setStatus)}><X size={11} />Cancel</Button>
        : <Button className="primary-button" disabled={!selected.size} onClick={() => void startDataSync([...selected]).then(setStatus)}><Download size={11} />Sync full history</Button>}
    </div>
    {validation && <div className={validation.invalidFiles.length || validation.duplicateCandles ? 'warning-card' : 'success-card'}>
      {validation.invalidFiles.length || validation.duplicateCandles ? <ShieldAlert size={16} /> : <CheckCircle2 size={16} />}
      <span>{validation.checkedFiles} files checked · {validation.invalidFiles.length} invalid · {validation.duplicateCandles} duplicate candles</span>
    </div>}
    {(status.active || status.finishedAt || status.error) && <div className="sync-progress">
      <div><span>{status.active ? `Syncing ${status.currentInstrument}` : status.error ? 'Sync failed' : 'Sync complete'}</span><strong>{status.completedInstruments} / {status.instruments.length}</strong></div>
      <div className="progress-track"><span style={{ width: `${status.instruments.length ? status.completedInstruments / status.instruments.length * 100 : 0}%` }} /></div>
      <small>{status.downloadedCandles.toLocaleString()} candles · {status.downloadedFundingRates.toLocaleString()} funding rates</small>
      {status.error && <p>{status.error}</p>}
    </div>}
    <h3 className="contract-selection-title">Contracts to synchronize</h3>
    <div className="sync-contracts">{ids.map(id => <label key={id}>
      <Checkbox.Root className="checkbox-root" checked={selected.has(id)} onCheckedChange={checked => toggle(id, checked)}><Checkbox.Indicator><Check size={10} /></Checkbox.Indicator></Checkbox.Root>
      <span>{id}</span>
    </label>)}</div>
  </div>
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric-row"><span>{label}</span><strong>{value}</strong></div> }
