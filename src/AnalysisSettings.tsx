import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { DEFAULT_ANALYSIS_MODEL } from '@/chart-analysis'
import { requestAnalysisSettings } from '@/analysis-service'

export function AnalysisSettingsButton() {
  return <a href="#/settings/analysis" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Configure analysis</a>
}

type AnalysisSettingsProps = {
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
}

type Operation = 'reading' | 'saving' | 'removing' | null

export function AnalysisSettings({ onDirtyChange, onBusyChange }: AnalysisSettingsProps) {
  const [model, setModel] = useState(DEFAULT_ANALYSIS_MODEL)
  const [savedModel, setSavedModel] = useState(DEFAULT_ANALYSIS_MODEL)
  const [key, setKey] = useState('')
  const [configured, setConfigured] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [operation, setOperation] = useState<Operation>('reading')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [modelInvalid, setModelInvalid] = useState(false)
  const modelInput = useRef<HTMLInputElement>(null)
  const requestEpoch = useRef<symbol | null>(null)
  const requestPending = useRef(false)
  const pendingRead = useRef<ReturnType<typeof requestAnalysisSettings> | null>(null)
  const busy = operation !== null
  const mutating = operation === 'saving' || operation === 'removing'
  const dirty = loaded && (model !== savedModel || key.length > 0)

  const read = useCallback(() => {
    if (requestPending.current) return
    requestPending.current = true
    const epoch = Symbol()
    requestEpoch.current = epoch
    const pending = pendingRead.current ?? Promise.resolve().then(() => requestAnalysisSettings({ action: 'read' }))
    pendingRead.current = pending
    return pending.then(value => {
      if (epoch !== requestEpoch.current) return
      setModel(value.model); setSavedModel(value.model); setConfigured(value.hasAPIKey); setLoaded(true)
    }).catch(cause => {
      if (epoch === requestEpoch.current) setError(cause instanceof Error ? cause.message : 'Cannot read analysis settings.')
    }).finally(() => {
      if (pendingRead.current === pending) pendingRead.current = null
      if (epoch === requestEpoch.current) { requestPending.current = false; setOperation(null) }
    })
  }, [])

  useEffect(() => {
    void read()
    return () => { requestEpoch.current = null; requestPending.current = false }
  }, [read])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange?.(mutating) }, [mutating, onBusyChange])
  useEffect(() => () => { onDirtyChange?.(false); onBusyChange?.(false) }, [onDirtyChange, onBusyChange])

  const save = async (remove = false) => {
    if (!loaded || requestPending.current) return
    if (!remove && !model.trim()) { setModelInvalid(true); setError('Enter a model ID.'); setSuccess(''); modelInput.current?.focus(); return }
    requestPending.current = true
    const epoch = Symbol()
    requestEpoch.current = epoch
    setOperation(remove ? 'removing' : 'saving'); setError(''); setSuccess('')
    try {
      const result = await requestAnalysisSettings(remove ? { action: 'removeKey' } : { action: 'save', model: model.trim(), apiKey: key })
      if (epoch !== requestEpoch.current) return
      setConfigured(result.hasAPIKey); setSavedModel(result.model); setKey('')
      if (remove) setModel(current => current === savedModel ? result.model : current)
      else { setModel(result.model); setModelInvalid(false) }
      setSuccess(remove ? 'Saved API key removed.' : 'Analysis settings saved.')
    } catch (cause) {
      if (epoch === requestEpoch.current) setError(cause instanceof Error ? cause.message : 'Cannot save analysis settings.')
    } finally {
      if (epoch === requestEpoch.current) { requestPending.current = false; setOperation(null) }
    }
  }

  return <form id="analysis-settings-form" noValidate onSubmit={event => { event.preventDefault(); void save() }} aria-busy={busy}>
    <FieldGroup>
      <Field data-disabled={busy || !loaded}>
        <FieldLabel htmlFor="gateway-api-key">Gateway API Key</FieldLabel>
        <Input id="gateway-api-key" name="gateway-api-key" type="password" autoComplete="off" spellCheck={false} disabled={busy || !loaded} value={key} placeholder={configured ? 'Leave blank to keep the saved key…' : 'Enter your Gateway API Key…'} onChange={event => { setKey(event.target.value); setSuccess('') }} />
        <FieldDescription>{loaded ? configured ? 'Configured. Enter a new key to replace it.' : 'Not configured.' : 'Loading saved configuration.'} Saved locally for your macOS user. App updates keep the saved key.</FieldDescription>
      </Field>
      <Field data-invalid={modelInvalid} data-disabled={busy || !loaded}>
        <FieldLabel htmlFor="analysis-model">Model</FieldLabel>
        <Input ref={modelInput} id="analysis-model" name="analysis-model" autoComplete="off" spellCheck={false} disabled={busy || !loaded} value={model} aria-invalid={modelInvalid} onChange={event => { setModel(event.target.value); setSuccess(''); if (event.target.value.trim()) setModelInvalid(false) }} />
        <FieldDescription>Use a Vercel AI Gateway model ID with image input support.</FieldDescription>
      </Field>
      {error && <FieldError>{error}</FieldError>}
      {success && <FieldDescription role="status">{success}</FieldDescription>}
      <Field orientation="horizontal">
        {operation === 'reading' && <FieldDescription role="status"><Spinner data-icon="inline-start" className="inline" /> Loading analysis settings…</FieldDescription>}
        {!loaded && !busy && <Button variant="outline" type="button" onClick={() => { setOperation('reading'); setError(''); void read() }}>Retry loading settings</Button>}
        {loaded && <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !loaded}>{operation === 'saving' && <Spinner data-icon="inline-start" />}Save analysis settings</Button>
          <Button variant="outline" type="button" disabled={busy || !configured} onClick={() => void save(true)}>{operation === 'removing' && <Spinner data-icon="inline-start" />}Remove key</Button>
        </div>}
      </Field>
    </FieldGroup>
  </form>
}
