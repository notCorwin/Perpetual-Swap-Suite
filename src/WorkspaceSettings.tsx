import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Database, Settings2, SlidersHorizontal } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { SETTINGS_SECTIONS, settingsHref, type SettingsNavigationState, type SettingsSection } from '@/settings-navigation'
import { LIQUIDITY_FIELDS, preferencesDraft, validatePreferencesDraft, type Preferences } from '@/renderer-preferences'
import type { DataAudit, HistoryDownload } from '@/desktop-contract'
import { SnapshotOrder } from '@/snapshot-order'
import { getPresentation, subscribePresentationTransition, waitForPresentation } from '@/presentation-store'

const emptyAudit: DataAudit = { phase: 'idle', progress: { completed: 0, total: 0 }, issues: [], error: '', revision: 0, serviceSession: '' }
export type SettingsStatusValue = { id: string; label: string; detail: string; severity: 'error' | 'warning' | 'info'; transient?: boolean }
const emptyDownload: HistoryDownload = {
  schemaVersion: 2, revision: 0, serviceSession: '', phase: 'idle', startedAt: null, updatedAt: null, finishedAt: null,
  contracts: { completed: 0, total: 0 }, streams: { completed: 0, total: 0 },
  progress: { checked: 0, total: 0, available: 0, empty: 0, unavailable: 0, failed: 0, reused: 0, pending: 0 },
  active: [], failures: [], error: '',
}
const count = (value: number) => value.toLocaleString('en-US')
const downloadTime = (value: number) => `${new Date(value).toLocaleString('en-US', { timeZone: 'UTC', hour12: false })} UTC`

function HistoryDownloadSettings({ open, onStatusChange, onJobSnapshot }: { open: boolean; onStatusChange: (value: SettingsStatusValue | null) => void; onJobSnapshot?: (kind: 'audit' | 'download', value: DataAudit | HistoryDownload) => void }) {
  const [download, setDownload] = useState<HistoryDownload>(emptyDownload)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState<'start' | 'cancel' | 'status' | null>(null)
  const [requestError, setRequestError] = useState('')
  const [statusError, setStatusError] = useState('')
  const lifecycle = useRef(0)
  const sequence = useRef(0)
  const accepted = useRef(0)
  const order = useRef(new SnapshotOrder())
  const accept = useCallback((value: HistoryDownload) => {
    if (!order.current.accept(value)) return
    accepted.current += 1
    setDownload(value); setReady(true); setStatusError('')
    onJobSnapshot?.('download', value)
  }, [onJobSnapshot])
  const request = useCallback(async (action: 'start' | 'cancel' | 'status') => {
    const currentLifecycle = lifecycle.current
    const currentSequence = ++sequence.current
    const before = accepted.current
    const epoch = getPresentation().epoch
    setBusy(action); setRequestError(''); setStatusError('')
    try {
      const value = await window.radarDesktop.request({ historyDownload: { action } })
      await waitForPresentation()
      const superseded = before !== accepted.current && (action === 'status' || value.serviceSession !== order.current.serviceSession)
      if (currentLifecycle === lifecycle.current && currentSequence === sequence.current && !superseded && (action !== 'status' || epoch === getPresentation().epoch)) accept(value)
    } catch {
      await waitForPresentation()
      if (currentLifecycle !== lifecycle.current || currentSequence !== sequence.current) return
      if (action === 'status') {
        if (epoch === getPresentation().epoch && before === accepted.current) setStatusError('Download status unavailable. Retry status in Data settings.')
      } else setRequestError(`Could not ${action === 'start' ? 'start' : 'cancel'} the history download. Check the data service and retry.`)
    } finally {
      if (currentLifecycle === lifecycle.current && currentSequence === sequence.current) setBusy(null)
    }
  }, [accept])
  useEffect(() => {
    if (!open) return
    lifecycle.current++
    setReady(false)
    const published = (event: Event) => accept((event as CustomEvent<HistoryDownload>).detail)
    window.addEventListener('radar-history-download-changed', published)
    const stop = subscribePresentationTransition(update => {
      if (update.active && update.snapshot) accept(update.snapshot.download)
      else if (update.active && update.epoch > 0) void request('status')
    })
    if (getPresentation().active && getPresentation().epoch === 0) void request('status')
    return () => { stop(); window.removeEventListener('radar-history-download-changed', published); lifecycle.current++ }
  }, [open, accept, request])
  const { progress, contracts, streams } = download
  const percent = progress.total ? Math.min(100, progress.checked / progress.total * 100) : 0
  const percentLabel = (Math.floor(percent * 10) / 10).toFixed(1)
  const numericPercent = progress.total ? Math.min(100, progress.available / progress.total * 100) : 0
  const numericLabel = (Math.floor(numericPercent * 10) / 10).toFixed(1)
  const phase = download.phase === 'completed'
    ? progress.failed > 0 ? 'Completed with failed requests' : progress.empty > 0 ? 'Completed with temporarily missing data' : progress.unavailable > 0 ? 'Completed with verified unavailable data' : 'Download complete'
    : { idle: 'Ready to download', running: 'Downloading history', cancelled: 'Download cancelled', failed: 'Download failed' }[download.phase]
  useEffect(() => {
    let value: SettingsStatusValue | null = null
    if (requestError || statusError || download.error || download.phase === 'failed') value = { id: 'history-download', label: 'History download', detail: requestError || statusError || 'Download failed. Check the data service and retry.', severity: 'error', transient: Boolean(requestError || statusError) }
    else if (busy === 'start' || busy === 'cancel') value = { id: 'history-download', label: 'History download', detail: busy === 'start' ? 'Starting download…' : 'Cancelling download…', severity: 'info', transient: true }
    else if (open && !ready) value = { id: 'history-download', label: 'History download', detail: 'Waiting for download status…', severity: 'info' }
    else if (download.phase === 'running') value = { id: 'history-download', label: 'History download', detail: `${phase} · ${percentLabel}%`, severity: 'info' }
    else if (download.phase === 'completed' && (progress.empty > 0 || progress.unavailable > 0 || progress.failed > 0)) value = { id: 'history-download', label: 'History download', detail: `${phase}. Review coverage in Data settings.`, severity: 'warning' }
    else if (download.phase === 'completed' || download.phase === 'cancelled') value = { id: 'history-download', label: 'History download', detail: phase, severity: 'info' }
    onStatusChange(value)
  }, [busy, download.error, download.phase, onStatusChange, open, percentLabel, phase, progress.empty, progress.failed, progress.unavailable, ready, requestError, statusError])
  useEffect(() => () => onStatusChange(null), [onStatusChange])
  return <FieldSet>
    <FieldLegend>Qualified contract history</FieldLegend>
    <FieldDescription>Uses saved filters at the start. Save filter changes first. Continues in the background.</FieldDescription>
    <Progress aria-label="History download progress" aria-valuetext={`${count(progress.checked)} of ${count(progress.total)} source timestamps checked; ${count(progress.available)} available; ${count(progress.empty)} temporarily missing; ${count(progress.unavailable)} verified unavailable; ${count(progress.failed)} failed; ${count(progress.pending)} pending`} value={download.phase === 'running' && progress.total === 0 ? null : percent} />
    {ready && progress.total > 0 && <p className="text-sm text-muted-foreground">{count(progress.checked)} / {count(progress.total)} source timestamps checked</p>}
    {ready && (progress.empty > 0 || progress.unavailable > 0 || progress.failed > 0) && <p className="text-sm text-muted-foreground">{[
      progress.empty > 0 && `${count(progress.empty)} temporarily missing`,
      progress.unavailable > 0 && `${count(progress.unavailable)} verified unavailable`,
      progress.failed > 0 && `${count(progress.failed)} failed`,
    ].filter(Boolean).join(' · ')}</p>}
    <div className="flex flex-wrap gap-2">
      {(busy === 'start' || (busy !== 'cancel' && download.phase !== 'running')) && <Button type="button" variant="outline" onClick={() => void request('start')} disabled={!ready || Boolean(busy)}>{busy === 'start' && <Spinner data-icon="inline-start" />}Download all qualified history</Button>}
      {(busy === 'cancel' || (busy !== 'start' && download.phase === 'running')) && <Button type="button" variant="outline" onClick={() => void request('cancel')} disabled={!ready || Boolean(busy)}>{busy === 'cancel' && <Spinner data-icon="inline-start" />}Cancel download</Button>}
      {statusError && <Button type="button" variant="outline" onClick={() => void request('status')} disabled={Boolean(busy)}>Retry status</Button>}
    </div>
    <details className="text-sm">
      <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">Download details and coverage</summary>
      <div className="flex flex-col gap-3 pt-3">
        <FieldDescription>5m, 15m and 1H candles, open interest and taker buy/sell data, from listing through the latest completed interval. Contracts and end time stay fixed. The audit lookback does not limit downloads. Existing valid data is reused; sources may not provide full listing history.</FieldDescription>
        <FieldDescription>Checked coverage includes temporary gaps and verified unavailability. Numeric completeness counts available records only; failed requests do not establish source absence.</FieldDescription>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm tabular-nums [&>dd]:text-right" aria-label="History download details">
          <dt>Checked source timestamps</dt><dd>{count(progress.checked)} / {count(progress.total)}</dd>
          <dt>Numeric data completeness</dt><dd>{numericLabel}%</dd>
          <dt>Available</dt><dd>{count(progress.available)}</dd>
          <dt>Temporarily missing</dt><dd>{count(progress.empty)}</dd>
          <dt>Verified unavailable</dt><dd>{count(progress.unavailable)}</dd>
          <dt>Failed source timestamps</dt><dd>{count(progress.failed)}</dd>
          <dt>Reused from local data</dt><dd>{count(progress.reused)}</dd>
          <dt>Pending source timestamps</dt><dd>{count(progress.pending)}</dd>
          <dt>Contracts finished</dt><dd>{count(contracts.completed)} / {count(contracts.total)}</dd>
          <dt>Data streams finished</dt><dd>{count(streams.completed)} / {count(streams.total)}</dd>
        </dl>
        {download.startedAt !== null && <p className="text-sm text-muted-foreground">Started {downloadTime(download.startedAt)}{download.updatedAt !== null && ` · Updated ${downloadTime(download.updatedAt)}`}{download.finishedAt !== null && ` · Finished ${downloadTime(download.finishedAt)}`}</p>}
      </div>
    </details>
    {download.active.length > 0 && <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto text-sm" aria-label="Active history downloads">{download.active.map(task => <li key={`${task.instrument}-${task.timeframe}-${task.source}-${task.from}-${task.through}`}>
      <strong>{task.instrument} · {task.timeframe} · {task.source}</strong>
      <p>{downloadTime(task.from)} – {downloadTime(task.through)}</p>
      <p>{task.status} · Consecutive failures: {count(task.attempts)}{task.nextAttemptAt !== null && ` · Next retry: ${downloadTime(task.nextAttemptAt)}`}</p>
      {task.error && <p>{task.status === 'retry' && task.nextAttemptAt !== null ? 'Request failed. A retry is scheduled.' : 'Request failed. Check the data service.'}</p>}
    </li>)}</ul>}
    {download.failures.length > 0 && <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto text-sm" aria-label="History download failures">{download.failures.map((failure, index) => <li key={`${failure.instrument}-${failure.timeframe}-${failure.source}-${failure.from}-${index}`}>
      <strong>{failure.instrument} · {failure.timeframe} · {failure.source}</strong>
      <p>{downloadTime(failure.from)} – {downloadTime(failure.through)}</p><p>Data request failed. Retry the download.</p>
    </li>)}</ul>}
  </FieldSet>
}

type WorkspaceSettingsProps = {
  section: SettingsSection
  active: boolean
  preferences: Preferences
  loaded: boolean
  loadError: string
  onSave: (values: Preferences) => Promise<void>
  onNavigationStateChange: (state: SettingsNavigationState) => void
  onStatusChange?: (items: SettingsStatusValue[]) => void
  onJobSnapshot?: (kind: 'audit' | 'download', value: DataAudit | HistoryDownload) => void
}
const sectionIcons = { workspace: Settings2, liquidity: SlidersHorizontal, data: Database }

export function WorkspaceSettings({ section, active, preferences, loaded, loadError, onSave, onNavigationStateChange, onStatusChange, onJobSnapshot }: WorkspaceSettingsProps) {
  const [draft, setDraft] = useState(() => preferencesDraft(preferences))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const [downloadStatus, setDownloadStatus] = useState<SettingsStatusValue | null>(null)
  const [visited, setVisited] = useState(() => new Set<SettingsSection>([section]))
  const scroll = useRef<HTMLDivElement>(null)
  const scrollPositions = useRef(new Map<SettingsSection, number>())
  const focusAfterValidation = useRef<string | null>(null)
  const previousPreferences = useRef(preferences)
  const dirty = JSON.stringify(draft) !== JSON.stringify(preferencesDraft(preferences))
  const dataMounted = visited.has('data') || section === 'data'
  const preferenceDisabled = saving || !loaded || Boolean(loadError)
  useEffect(() => {
    const previous = previousPreferences.current
    previousPreferences.current = preferences
    setDraft(current => JSON.stringify(current) === JSON.stringify(preferencesDraft(previous)) ? preferencesDraft(preferences) : current)
  }, [preferences])
  useLayoutEffect(() => {
    if (!active) {
      setDraft(preferencesDraft(preferences))
      setErrors({}); setSaveError(''); setSavedMessage('')
      focusAfterValidation.current = null
      return
    }
    setVisited(current => current.has(section) ? current : new Set([...current, section]))
    scroll.current?.scrollTo(0, scrollPositions.current.get(section) ?? 0)
    if (focusAfterValidation.current) {
      document.getElementById(focusAfterValidation.current)?.focus()
      focusAfterValidation.current = null
    }
  }, [active, section])
  useLayoutEffect(() => { onNavigationStateChange({ dirty: active && dirty, busy: saving }) }, [active, dirty, saving, onNavigationStateChange])
  useEffect(() => () => onNavigationStateChange({ dirty: false, busy: false }), [onNavigationStateChange])
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
    onJobSnapshot?.('audit', value)
  }, [onJobSnapshot])
  useEffect(() => {
    if (!dataMounted) return
    const lifecycle = ++auditLifecycle.current
    setAuditBusy(false); setAuditError(''); setAuditStatusError('')
    const published = (event: Event) => acceptAudit((event as CustomEvent<DataAudit>).detail)
    window.addEventListener('radar-audit-changed', published)
    const status = async () => {
      const accepted = auditAccepted.current
      const epoch = getPresentation().epoch
      try {
        const value = await window.radarDesktop.request({ dataAudit: { action: 'status' } })
        if (lifecycle === auditLifecycle.current && getPresentation().active && epoch === getPresentation().epoch && accepted === auditAccepted.current) acceptAudit(value)
      } catch {
        if (lifecycle === auditLifecycle.current && getPresentation().active && epoch === getPresentation().epoch && accepted === auditAccepted.current) setAuditStatusError('Audit status unavailable. Check the data service and reopen Data settings.')
      }
    }
    const stop = subscribePresentationTransition(update => {
      if (update.active && update.snapshot) acceptAudit(update.snapshot.audit)
      else if (update.active && update.epoch > 0) void status()
    })
    if (getPresentation().active && getPresentation().epoch === 0) void status()
    return () => { stop(); window.removeEventListener('radar-audit-changed', published); auditLifecycle.current++ }
  }, [dataMounted, acceptAudit])
  const auditAction = async (action: 'start' | 'cancel' | 'repair') => {
    const lifecycle = auditLifecycle.current
    const sequence = ++auditSequence.current
    const before = auditAccepted.current
    setAuditBusy(true); setAuditError('')
    try {
      const value = await window.radarDesktop.request({ dataAudit: { action } })
      await waitForPresentation()
      if (lifecycle === auditLifecycle.current && sequence === auditSequence.current && (before === auditAccepted.current || value.serviceSession === auditOrder.current.serviceSession)) acceptAudit(value)
    } catch { await waitForPresentation(); if (lifecycle === auditLifecycle.current && sequence === auditSequence.current) setAuditError(`Could not ${action === 'repair' ? 'repair the audit issues' : `${action} the audit`}. Check the data service and retry.`) }
    finally { if (lifecycle === auditLifecycle.current && sequence === auditSequence.current) setAuditBusy(false) }
  }
  const changeNumber = (key: 'rankingLookback' | 'historyDays' | 'slippageNotional', value: string) => {
    setDraft(current => ({ ...current, [key]: value })); setErrors(current => ({ ...current, [key]: '' })); setSaveError(''); setSavedMessage('')
  }
  const save = async () => {
    const checked = validatePreferencesDraft(draft)
    setErrors(checked.errors); setSaveError(''); setSavedMessage('')
    if (!checked.values) {
      const key = Object.keys(checked.errors)[0]
      const invalidSection: SettingsSection = key === 'historyDays' ? 'data' : key === 'slippageNotional' || LIQUIDITY_FIELDS.some(field => field.key === key) ? 'liquidity' : 'workspace'
      const target = LIQUIDITY_FIELDS.some(field => field.key === key) ? `threshold-${key}` : key
      if (invalidSection === section) document.getElementById(target)?.focus()
      else { focusAfterValidation.current = target; window.location.hash = settingsHref(invalidSection) }
      return
    }
    setSaving(true)
    try { await onSave(checked.values); setDraft(preferencesDraft(checked.values)); setSavedMessage('Settings saved.') }
    catch { setSaveError('Could not save settings. Check the data service and retry.') }
    finally { setSaving(false) }
  }
  useEffect(() => {
    const items: SettingsStatusValue[] = []
    if (saveError) items.push({ id: 'settings-save', label: 'Settings', detail: saveError, severity: 'error' })
    else if (saving) items.push({ id: 'settings-save', label: 'Settings', detail: 'Saving settings…', severity: 'info' })
    else if (savedMessage) items.push({ id: 'settings-save', label: 'Settings', detail: savedMessage, severity: 'info' })
    else if (dirty) items.push({ id: 'settings-save', label: 'Settings', detail: 'Unsaved changes', severity: 'info' })
    if (downloadStatus) items.push(downloadStatus)
    if (auditError || auditStatusError || audit.error || audit.phase === 'failed') items.push({ id: 'data-audit', label: 'Data audit', detail: auditError || auditStatusError || 'Audit failed. Check the data service and retry.', severity: 'error', transient: Boolean(auditError || auditStatusError) })
    else if (auditBusy || audit.phase === 'running' || audit.phase === 'validating') items.push({ id: 'data-audit', label: 'Data audit', detail: audit.phase === 'validating' ? 'Validating recent changes. Results are provisional.' : `Audit running · ${audit.progress.completed} / ${audit.progress.total}`, severity: 'info', transient: auditBusy })
    else if (audit.issues.length) items.push({ id: 'data-audit', label: 'Data audit', detail: `${audit.issues.length} issues found. Review them in Data settings.`, severity: 'warning' })
    else if (audit.phase === 'completed' || audit.phase === 'cancelled') items.push({ id: 'data-audit', label: 'Data audit', detail: audit.phase === 'completed' ? 'Audit complete.' : 'Audit cancelled.', severity: 'info' })
    onStatusChange?.(items)
  }, [audit.error, audit.issues.length, audit.phase, audit.progress.completed, audit.progress.total, auditBusy, auditError, auditStatusError, dirty, downloadStatus, onStatusChange, saveError, savedMessage, saving])
  useEffect(() => () => onStatusChange?.([]), [onStatusChange])
  const numericField = (key: 'rankingLookback' | 'historyDays' | 'slippageNotional', label: string, description?: string) => <Field orientation="horizontal" data-invalid={Boolean(errors[key])} data-disabled={preferenceDisabled} className="justify-between gap-6">
    <FieldContent className="self-center">
      <FieldLabel htmlFor={key}>{label}</FieldLabel>
      {description && <FieldDescription id={`${key}-description`}>{description}</FieldDescription>}
      {errors[key] && <FieldError id={`${key}-error`}>{errors[key]}</FieldError>}
    </FieldContent>
    <Input id={key} name={key} autoComplete="off" type="number" step={key === 'slippageNotional' ? 'any' : 1} inputMode="decimal" value={draft[key]} onChange={event => changeNumber(key, event.target.value)} aria-invalid={Boolean(errors[key])} aria-describedby={[description && `${key}-description`, errors[key] && `${key}-error`].filter(Boolean).join(' ') || undefined} disabled={preferenceDisabled} className="w-52 shrink-0 self-center" />
  </Field>
  const currentSection = SETTINGS_SECTIONS.find(value => value.id === section)!
  return <main aria-label="Settings" data-layout="settings-workspace" className="flex h-full min-w-0 flex-1 flex-col bg-background">
    <header data-window-toolbar data-window-drag-region className="flex border-b">
      <div data-native-window-controls-row className="flex h-full w-72 shrink-0 items-center border-r px-4">
        <h1 data-settings-title className="font-medium">Settings</h1>
      </div>
    </header>
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Settings categories" className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto border-r p-6">
        {SETTINGS_SECTIONS.map(item => {
          const Icon = sectionIcons[item.id]
          return <a key={item.id} href={settingsHref(item.id)} aria-current={item.id === section ? 'page' : undefined} className={buttonVariants({ variant: item.id === section ? 'secondary' : 'ghost', className: 'min-h-10 justify-start gap-3 px-3' })}><Icon aria-hidden="true" data-icon="inline-start" />{item.label}{item.id === section && <ChevronRight aria-hidden="true" data-icon="inline-end" className="ml-auto" />}</a>
        })}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={scroll} onScroll={event => scrollPositions.current.set(section, event.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-y-auto px-12 py-8 [scrollbar-gutter:stable]">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
            <h2 id="settings-section-title" className="font-medium">{currentSection.label}</h2>
            <form id="workspace-settings-form" noValidate onSubmit={event => { event.preventDefault(); void save() }}>
              <div hidden={section !== 'workspace'} className="flex flex-col gap-8">
        <FieldSet disabled={preferenceDisabled} aria-labelledby="settings-section-title">
          <FieldGroup>
            <Field orientation="horizontal" data-disabled={preferenceDisabled} className="justify-between gap-6">
              <FieldContent className="self-center"><FieldLabel htmlFor="show-bollinger-price-labels">Bollinger price labels</FieldLabel></FieldContent>
              <Switch id="show-bollinger-price-labels" className="self-center" checked={draft.showBollingerPriceLabels} disabled={preferenceDisabled} onCheckedChange={checked => { setDraft(current => ({ ...current, showBollingerPriceLabels: checked })); setSavedMessage('') }} />
            </Field>
          </FieldGroup>
        </FieldSet>
              </div>
              <div hidden={section !== 'liquidity'} className="flex flex-col gap-8">
        <FieldSet disabled={preferenceDisabled} aria-labelledby="settings-section-title">
          <FieldGroup>
            {LIQUIDITY_FIELDS.map(field => <FieldGroup key={field.key} data-settings-liquidity-field className="gap-3">
              <Field orientation="horizontal" data-invalid={Boolean(errors[field.key])} data-disabled={preferenceDisabled} className="justify-between gap-6">
                <FieldContent className="self-center">
                  <FieldLabel id={`condition-label-${field.key}`} htmlFor={`condition-${field.key}`}>{field.label}</FieldLabel>
                  {field.description && <FieldDescription id={`description-${field.key}`}>{field.description}</FieldDescription>}
                  {errors[field.key] && <FieldError id={`error-${field.key}`}>{errors[field.key]}</FieldError>}
                </FieldContent>
                <InputGroup className="w-52 shrink-0 self-center">
                <InputGroupInput id={`threshold-${field.key}`} name={`threshold-${field.key}`} aria-label={field.parameterLabel} autoComplete="off" type="number" inputMode="decimal" step="any" value={draft.liquidity[field.key].threshold} aria-invalid={Boolean(errors[field.key])} aria-describedby={[field.description && `description-${field.key}`, errors[field.key] && `error-${field.key}`].filter(Boolean).join(' ') || undefined} onChange={event => {
                  const threshold = event.target.value
                  setDraft(current => ({ ...current, liquidity: { ...current.liquidity, [field.key]: { ...current.liquidity[field.key], threshold } } })); setErrors(current => ({ ...current, [field.key]: '' })); setSavedMessage('')
                }} />
                <InputGroupAddon align="inline-start" aria-hidden="true">{field.parameter === 'minUSDT' ? '>' : '<'}</InputGroupAddon>
                {field.parameter !== 'maxRatio' && <InputGroupAddon align="inline-end" aria-hidden="true">{field.parameter === 'minUSDT' ? 'USDT' : '%'}</InputGroupAddon>}
                </InputGroup>
                <Switch id={`condition-${field.key}`} aria-labelledby={`condition-label-${field.key}`} className="self-center" checked={draft.liquidity[field.key].enabled} onCheckedChange={enabled => setDraft(current => ({ ...current, liquidity: { ...current.liquidity, [field.key]: { ...current.liquidity[field.key], enabled } } }))} />
              </Field>
              {field.key === 'slippage' && <FieldGroup>{numericField('slippageNotional', 'Slippage trade size (USDT)')}</FieldGroup>}
            </FieldGroup>)}
          </FieldGroup>
        </FieldSet>
              </div>
              <div hidden={section !== 'data'} className="flex flex-col gap-8">
        <HistoryDownloadSettings open={dataMounted} onStatusChange={setDownloadStatus} onJobSnapshot={onJobSnapshot} />
        <Separator />
        <FieldSet>
          <FieldLegend>Data integrity</FieldLegend>
          <FieldSet disabled={preferenceDisabled} aria-label="Audit range"><FieldGroup>
            {numericField('historyDays', 'Data audit lookback (days)')}
          </FieldGroup></FieldSet>
          {audit.phase !== 'validating' && <Progress aria-label="Data audit progress" value={audit.progress.total ? audit.progress.completed / audit.progress.total * 100 : 0} />}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void auditAction('start')} disabled={auditBusy || audit.phase === 'running' || audit.phase === 'validating'}>Start audit</Button>
            <Button type="button" variant="outline" onClick={() => void auditAction('cancel')} disabled={auditBusy || (audit.phase !== 'running' && audit.phase !== 'validating')}>Cancel audit</Button>
            <Button type="button" variant="outline" onClick={() => void auditAction('repair')} disabled={auditBusy || audit.phase === 'running' || audit.phase === 'validating' || !audit.issues.some(issue => issue.repairable)}>Repair issues</Button>
          </div>
          {audit.issues.length > 0 && <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto text-sm" aria-label="Data audit issues">{audit.issues.map((issue, index) => <li key={`${issue.instrument}-${issue.timeframe}-${issue.from}-${index}`}>
            <strong>{issue.instrument} · {issue.timeframe}</strong><p>{new Date(issue.from).toLocaleString('en-US')} – {new Date(issue.through).toLocaleString('en-US')}</p><p>{issue.reason} · {issue.repairable ? 'Repairable' : 'Review required'}</p>
          </li>)}</ul>}
        </FieldSet>
              </div>
            </form>
          </div>
        </div>
        <footer className="shrink-0 border-t px-12 py-4"><div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4">
          <span />
          <div className="flex gap-2"><Button type="button" variant="outline" disabled={preferenceDisabled || !dirty} onClick={() => { setDraft(preferencesDraft(preferences)); setErrors({}); setSaveError(''); setSavedMessage('') }}>Discard changes</Button><Button type="submit" form="workspace-settings-form" disabled={preferenceDisabled}>{saving && <Spinner data-icon="inline-start" />}Save settings</Button></div>
        </div></footer>
      </div>
    </div>
  </main>
}
