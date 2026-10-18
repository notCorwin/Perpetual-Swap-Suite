import { useCallback, useEffect, useRef, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { Progress } from '@/components/ui/progress'
import { AnalysisSettingsButton } from '@/AnalysisSettingsDialog'
import { LIQUIDITY_FIELDS, preferencesDraft, validatePreferencesDraft, type Preferences } from '@/renderer-preferences'
import type { DataAudit } from '@/desktop-contract'
import { RADAR_TIMEFRAMES, type RadarTimeframe } from '@/timeframe'
import { SnapshotOrder } from '@/snapshot-order'

const emptyAudit: DataAudit = { phase: 'idle', progress: { completed: 0, total: 0 }, issues: [], error: '', revision: 0, serviceSession: '' }
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'The desktop service could not complete this request.'

export function WorkspaceSettings({ preferences, loadError, onSave }: { preferences: Preferences; loadError: string; onSave: (values: Preferences) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(() => preferencesDraft(preferences))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [audit, setAudit] = useState<DataAudit>(emptyAudit)
  const [auditError, setAuditError] = useState('')
  const [auditStatusError, setAuditStatusError] = useState('')
  const [auditBusy, setAuditBusy] = useState(false)
  const auditSequence = useRef(0)
  const auditLifecycle = useRef(0)
  const auditAccepted = useRef(0)
  const auditOrder = useRef(new SnapshotOrder())
  const acceptAudit = useCallback((value: DataAudit) => {
    if (!auditOrder.current.accept(value)) return
    auditAccepted.current += 1
    setAudit(value); setAuditStatusError('')
  }, [])
  useEffect(() => {
    if (!open) return
    const lifecycle = ++auditLifecycle.current
    const accepted = auditAccepted.current
    setAuditBusy(false); setAuditError(''); setAuditStatusError('')
    const published = (event: Event) => acceptAudit((event as CustomEvent<DataAudit>).detail)
    window.addEventListener('radar-audit-changed', published)
    const status = async () => {
      try {
        const value = await window.radarDesktop.request({ dataAudit: { action: 'status' } })
        if (lifecycle === auditLifecycle.current) acceptAudit(value)
      } catch (cause) {
        if (lifecycle === auditLifecycle.current && accepted === auditAccepted.current) setAuditStatusError(errorMessage(cause))
      }
    }
    void status()
    return () => { window.removeEventListener('radar-audit-changed', published); auditLifecycle.current++ }
  }, [open, acceptAudit])
  const auditAction = async (action: 'start' | 'cancel' | 'repair') => {
    const lifecycle = auditLifecycle.current
    const sequence = ++auditSequence.current
    setAuditBusy(true); setAuditError('')
    try {
      const value = await window.radarDesktop.request({ dataAudit: { action } })
      if (lifecycle === auditLifecycle.current && sequence === auditSequence.current) acceptAudit(value)
    } catch (cause) { if (lifecycle === auditLifecycle.current && sequence === auditSequence.current) setAuditError(errorMessage(cause)) }
    finally { if (lifecycle === auditLifecycle.current && sequence === auditSequence.current) setAuditBusy(false) }
  }
  const changeNumber = (key: 'rankingLookback' | 'historyDays' | 'slippageNotional', value: string) => {
    setDraft(current => ({ ...current, [key]: value })); setErrors(current => ({ ...current, [key]: '' })); setSaveError('')
  }
  const save = async () => {
    const checked = validatePreferencesDraft(draft)
    setErrors(checked.errors); setSaveError('')
    if (!checked.values) {
      const key = Object.keys(checked.errors)[0]
      document.getElementById(LIQUIDITY_FIELDS.some(field => field.key === key) ? `threshold-${key}` : key)?.focus()
      return
    }
    setSaving(true)
    try { await onSave(checked.values); setOpen(false) }
    catch (cause) { setSaveError(errorMessage(cause)) }
    finally { setSaving(false) }
  }
  const numericField = (key: 'rankingLookback' | 'historyDays' | 'slippageNotional', label: string, description?: string) => <Field data-invalid={Boolean(errors[key])}>
    <FieldLabel htmlFor={key}>{label}</FieldLabel>
    <Input id={key} name={key} autoComplete="off" type="number" step={key === 'slippageNotional' ? 'any' : 1} inputMode="decimal" value={draft[key]} onChange={event => changeNumber(key, event.target.value)} aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `${key}-error` : undefined} disabled={saving} />
    {description && <FieldDescription>{description}</FieldDescription>}
    {errors[key] && <FieldError id={`${key}-error`}>{errors[key]}</FieldError>}
  </Field>
  return <Dialog open={open} onOpenChange={value => {
    if (saving) return
    if (value) { setDraft(preferencesDraft(preferences)); setErrors({}); setSaveError('') }
    setOpen(value)
  }}>
    <DialogTrigger render={<Button variant="outline" size="sm" />}><Settings2 data-icon="inline-start" />Settings</DialogTrigger>
    <DialogContent className="flex max-h-[calc(var(--workspace-height)*0.85)] flex-col overflow-hidden sm:max-w-2xl">
      <DialogHeader><DialogTitle>Settings</DialogTitle><DialogDescription>Screen USDT perpetual swaps and manage local market data.</DialogDescription></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); void save() }} className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto pr-6 [scrollbar-gutter:stable]">
        {(loadError || saveError) && <p role="alert" className="text-sm text-destructive">{saveError || loadError}</p>}
        <FieldSet disabled={saving}>
          <FieldLegend>Market workspace</FieldLegend>
          <FieldGroup>
            <Field><FieldLabel htmlFor="default-chart-timeframe">Chart timeframe</FieldLabel>
              <Select value={draft.chartTimeframe} onValueChange={value => { if (value) setDraft(current => ({ ...current, chartTimeframe: value as RadarTimeframe })) }}>
                <SelectTrigger id="default-chart-timeframe"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>{RADAR_TIMEFRAMES.map(frame => <SelectItem value={frame.value} key={frame.value}>{frame.label}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
            {numericField('rankingLookback', 'Ranking lookback (minutes)', 'Uses completed 5m candle closes. This window is independent of the chart timeframe.')}
            {numericField('historyDays', 'History to retain (days)')}
          </FieldGroup>
        </FieldSet>
        <FieldSet disabled={saving}>
          <FieldLegend>Liquidity conditions</FieldLegend>
          <FieldDescription>Only contracts meeting every enabled condition appear in the list.</FieldDescription>
          <FieldGroup>
            {LIQUIDITY_FIELDS.map(field => <FieldSet key={field.key}>
              <Field orientation="horizontal"><FieldLabel htmlFor={`condition-${field.key}`}>{field.label}</FieldLabel>
                <Switch id={`condition-${field.key}`} checked={draft.liquidity[field.key].enabled} onCheckedChange={enabled => setDraft(current => ({ ...current, liquidity: { ...current.liquidity, [field.key]: { ...current.liquidity[field.key], enabled } } }))} />
              </Field>
              <Field data-invalid={Boolean(errors[field.key])}>
                <FieldLabel htmlFor={`threshold-${field.key}`}>{field.parameterLabel}</FieldLabel>
                <Input id={`threshold-${field.key}`} name={`threshold-${field.key}`} autoComplete="off" type="number" inputMode="decimal" step="any" value={draft.liquidity[field.key].threshold} aria-invalid={Boolean(errors[field.key])} aria-describedby={`description-${field.key}${errors[field.key] ? ` error-${field.key}` : ''}`} onChange={event => {
                  const threshold = event.target.value
                  setDraft(current => ({ ...current, liquidity: { ...current.liquidity, [field.key]: { ...current.liquidity[field.key], threshold } } })); setErrors(current => ({ ...current, [field.key]: '' }))
                }} />
                <FieldDescription id={`description-${field.key}`}>{field.description}</FieldDescription>
                {errors[field.key] && <FieldError id={`error-${field.key}`}>{errors[field.key]}</FieldError>}
              </Field>
              {field.key === 'slippage' && numericField('slippageNotional', 'Slippage trade size (USDT)')}
            </FieldSet>)}
          </FieldGroup>
        </FieldSet>
        <FieldSet>
          <FieldLegend>Data integrity</FieldLegend>
          <FieldDescription>Check persisted history for gaps and invalid data. Repair downloads missing intervals in the background.</FieldDescription>
          <p role="status" className="text-sm capitalize">{audit.phase} · {audit.progress.completed} / {audit.progress.total}</p>
          <Progress aria-label="Data audit progress" value={audit.progress.total ? audit.progress.completed / audit.progress.total * 100 : 0} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void auditAction('start')} disabled={auditBusy || audit.phase === 'running'}>Start audit</Button>
            <Button type="button" variant="outline" onClick={() => void auditAction('cancel')} disabled={auditBusy || audit.phase !== 'running'}>Cancel audit</Button>
            <Button type="button" variant="outline" onClick={() => void auditAction('repair')} disabled={auditBusy || audit.phase === 'running' || !audit.issues.some(issue => issue.repairable)}>Repair issues</Button>
          </div>
          {(auditError || auditStatusError || audit.error) && <p role="alert" className="text-sm text-destructive">{auditError || auditStatusError || audit.error}</p>}
          {audit.issues.length > 0 && <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto text-sm" aria-label="Data audit issues">{audit.issues.map((issue, index) => <li key={`${issue.instrument}-${issue.timeframe}-${issue.from}-${index}`}>
            <strong>{issue.instrument} · {issue.timeframe}</strong><p>{new Date(issue.from).toLocaleString('en-US')} – {new Date(issue.through).toLocaleString('en-US')}</p><p>{issue.reason} · {issue.repairable ? 'Repairable' : 'Review required'}</p>
          </li>)}</ul>}
        </FieldSet>
        <FieldSet><FieldLegend>Optional AI analysis</FieldLegend><FieldDescription>Configure a model to analyze chart images.</FieldDescription><AnalysisSettingsButton /></FieldSet>
        <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button><Button type="submit" disabled={saving}>{saving && <Spinner data-icon="inline-start" />}Save settings</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
