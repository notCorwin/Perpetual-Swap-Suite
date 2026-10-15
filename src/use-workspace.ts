import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { mockSnapshot } from './mock-data'
import { requestSnapshot, validateData } from './lib/bridge'
import type { AppSettings, ValidationReport, WorkspaceSnapshot } from './types'

export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(() => window.webkit ? { ...mockSnapshot, markets: [], candles: [], formingCandle: null, status: 'Starting' } : mockSnapshot)
  const [pending, setPending] = useState(Boolean(window.webkit))
  const [actionError, setActionError] = useState('')
  const stopped = useRef(false)

  const perform = useCallback(async (request: Record<string, unknown>) => {
    setPending(true)
    try {
      const next = await requestSnapshot(request)
      setActionError('')
      startTransition(() => setSnapshot(next))
      return next
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    } finally {
      setPending(false)
    }
  }, [])

  useEffect(() => {
    if (!window.webkit) return
    stopped.current = false
    let timer = 0
    const poll = async () => {
      try {
        const next = await requestSnapshot({ method: 'snapshot' })
        if (!stopped.current) startTransition(() => setSnapshot(next))
      } catch (cause) {
        if (!stopped.current) setActionError(cause instanceof Error ? cause.message : String(cause))
      }
      if (!stopped.current) timer = window.setTimeout(poll, 5_000)
    }
    void poll().finally(() => setPending(false))
    return () => { stopped.current = true; window.clearTimeout(timer) }
  }, [])

  return {
    snapshot, pending, error: actionError || snapshot.error || '',
    refresh: () => perform({ method: 'refresh', instrument: snapshot.selectedInstrument }),
    select: (instrument: string) => perform({ method: 'select', instrument }),
    saveSettings: (settings: AppSettings) => perform({ method: 'settings', settings }),
    validate: (): Promise<ValidationReport> => validateData(),
  }
}
