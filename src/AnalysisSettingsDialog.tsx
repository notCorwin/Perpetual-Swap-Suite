import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { DEFAULT_ANALYSIS_MODEL } from '@/chart-analysis'
import { requestAnalysisSettings } from '@/analysis-service'

export function AnalysisSettingsButton() {
  return <Button variant="outline" size="sm" onClick={() => window.dispatchEvent(new Event('radar-analysis-settings'))}>Configure analysis</Button>
}

// Mounted outside Settings' popover so dismissing that popover cannot destroy
// the dialog or leave its password draft attached to an unmounted trigger.
export function AnalysisSettingsDialog() {
  const [open, setOpen] = useState(false)
  const [model, setModel] = useState(DEFAULT_ANALYSIS_MODEL)
  const [key, setKey] = useState('')
  const [configured, setConfigured] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let epoch = 0, active = true
    const show = () => {
      const requestEpoch = ++epoch
      setOpen(true); setBusy(true); setError(''); setKey('')
      void requestAnalysisSettings({ action: 'read' }).then(value => {
        if (active && requestEpoch === epoch) { setModel(value.model); setConfigured(value.hasAPIKey) }
      }).catch(cause => { if (active && requestEpoch === epoch) setError(cause instanceof Error ? cause.message : 'Cannot read analysis settings.') })
        .finally(() => { if (active && requestEpoch === epoch) setBusy(false) })
    }
    window.addEventListener('radar-analysis-settings', show)
    return () => { active = false; window.removeEventListener('radar-analysis-settings', show) }
  }, [])
  const save = async (remove = false) => {
    if (busy) return
    if (!remove && !model.trim()) { setError('Enter a model ID.'); return }
    setBusy(true); setError('')
    try {
      const result = await requestAnalysisSettings(remove ? { action: 'removeKey' } : { action: 'save', model: model.trim(), apiKey: key })
      setConfigured(result.hasAPIKey); setModel(result.model); setKey('')
      if (!remove) setOpen(false)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Cannot save analysis settings.') }
    finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); if (!value) setKey('') } }}>
    <DialogContent aria-label="AI analysis settings" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>AI analysis</DialogTitle><DialogDescription>Connect chart analysis to Vercel AI Gateway.</DialogDescription></DialogHeader>
      <form id="analysis-settings-form" onSubmit={event => { event.preventDefault(); void save() }}>
        <FieldGroup>
          <Field><FieldLabel htmlFor="gateway-api-key">Gateway API Key</FieldLabel><Input id="gateway-api-key" type="password" autoComplete="off" spellCheck={false} disabled={busy} value={key} placeholder={configured ? 'Leave blank to keep the saved key' : 'Enter your Gateway API Key'} onChange={event => setKey(event.target.value)} /><FieldDescription>{configured ? 'Configured. Enter a new key to replace it.' : 'Not configured.'} Stored in macOS Keychain.</FieldDescription></Field>
          <Field data-invalid={!model.trim()}><FieldLabel htmlFor="analysis-model">Model</FieldLabel><Input id="analysis-model" autoComplete="off" spellCheck={false} disabled={busy} value={model} aria-invalid={!model.trim()} onChange={event => setModel(event.target.value)} /><FieldDescription>Use a Gateway model ID with image input support.</FieldDescription></Field>
          {error && <FieldError role="alert">{error}</FieldError>}
        </FieldGroup>
      </form>
      <DialogFooter>
        <Button variant="ghost" disabled={busy || !configured} onClick={() => void save(true)}>Remove key</Button>
        <Button variant="outline" disabled={busy} onClick={() => { setOpen(false); setKey('') }}>Cancel</Button>
        <Button type="submit" form="analysis-settings-form" disabled={busy || !model.trim()}>{busy && <Spinner data-icon="inline-start" />}Save</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
