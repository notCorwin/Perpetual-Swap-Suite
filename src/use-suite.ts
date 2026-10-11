import { useCallback, useEffect, useRef, useState } from 'react'
import { keepSnapshotValue } from '@/market-snapshot'
import { requestSuite, type SuiteMode, type SuiteRequest, type SuiteResponse } from '@/suite-types'

export function useSuite(mode: SuiteMode, active: boolean) {
  const [snapshot, setSnapshot] = useState<SuiteResponse>({ profiles: [], selectedID: '' })
  const [error, setError] = useState(''), [pending, setPending] = useState(false), [ready,setReady] = useState(false)
  const generation = useRef(0), mutating = useRef(false)
  const accept = useCallback((value: SuiteResponse) => setSnapshot(previous => { const same = previous.selectedID === value.selectedID && previous.profiles.find(p => p.id===previous.selectedID)?.revision === value.profiles.find(p => p.id===value.selectedID)?.revision; return keepSnapshotValue(previous, { ...previous, ...value,
    confirmed: same ? value.confirmed ?? previous.confirmed : value.confirmed,
    provisional: same ? value.provisional ?? previous.provisional : value.provisional }) }), [])
  useEffect(() => {
    if (!active) return
    let stopped = false, timer: number
    const refresh = async () => {
      try {
        if (!mutating.current) {
          const epoch = generation.current
          const value = await requestSuite({ mode, action: mode === 'radar' ? 'evaluate' : 'inventory' })
          if (!stopped && epoch === generation.current) { accept(value); setError(''); setReady(true) }
        }
      } catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : 'Cannot read strategies.') }
      if (!stopped) timer = window.setTimeout(refresh, 2000)
    }
    void refresh(); return () => { stopped = true; window.clearTimeout(timer) }
  }, [active, mode, accept])
  const perform = useCallback(async (request: Omit<SuiteRequest, 'mode'>) => {
    generation.current += 1; mutating.current = true; setPending(true); setError('')
    try { const value = await requestSuite({ ...request, mode }); accept(value); return value }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Cannot save this change.'); throw cause }
    finally { mutating.current = false; setPending(false) }
  }, [accept, mode])
  return { snapshot, error, pending, ready, perform }
}
