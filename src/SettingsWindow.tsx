import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { WorkspaceSettings, type SettingsStatusValue } from '@/WorkspaceSettings'
import { WorkspaceViewport } from '@/WorkspaceViewport'
import { DEFAULT_PREFERENCES, type Preferences } from '@/renderer-preferences'
import { settingsHref, useSettingsSection, type SettingsNavigationState } from '@/settings-navigation'
import { getPresentation, subscribePresentationTransition, waitForPresentation } from '@/presentation-store'

// Settings is a separate renderer: it never starts the market/chart workspace.
if (!window.location.hash.startsWith('#/settings')) history.replaceState(null, '', settingsHref('workspace'))

export default function SettingsWindow() {
  const guard = useRef<SettingsNavigationState>({ dirty: false, busy: false })
  const section = useSettingsSection(guard) ?? 'workspace'
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [statuses, setStatuses] = useState<SettingsStatusValue[]>([])
  const version = useRef(0)
  const loadedEpoch = useRef<number | null>(null)
  const updateGuard = useCallback((value: SettingsNavigationState) => {
    guard.current = value
    window.radarDesktop.setSettingsCloseGuard(value)
  }, [])

  const reloadPreferences = useCallback(() => {
    const before = version.current
    const epoch = getPresentation().epoch
    loadedEpoch.current = epoch
    setLoadError('')
    void window.radarDesktop.request({ preferences: { action: 'read' } }).then(value => {
      if (before === version.current && getPresentation().active && getPresentation().epoch === epoch) {
        setPreferences(value); setLoaded(true); setLoadError('')
      }
    }).catch(() => {
      if (before === version.current && getPresentation().active && getPresentation().epoch === epoch) {
        setLoadError('Settings could not be loaded. Check the local data service.')
        setLoaded(true)
      }
    })
  }, [])

  useLayoutEffect(() => subscribePresentationTransition(update => {
    if (!update.active || update.epoch === 0 || loadedEpoch.current === update.epoch) return
    reloadPreferences()
  }), [reloadPreferences])

  useEffect(() => {
    let stopped = false
    const receive = (event: Event) => {
      version.current++
      setPreferences((event as CustomEvent<Preferences>).detail)
      setLoaded(true); setLoadError('')
    }
    window.addEventListener('radar-preferences-changed', receive)
    if (getPresentation().active && loadedEpoch.current !== getPresentation().epoch) {
      const before = version.current
      const epoch = getPresentation().epoch
      loadedEpoch.current = epoch
      void window.radarDesktop.request({ preferences: { action: 'read' } }).then(value => {
        if (!stopped && before === version.current && getPresentation().active && getPresentation().epoch === epoch) { setPreferences(value); setLoadError('') }
      }).catch(() => {
        if (!stopped && before === version.current && getPresentation().active && getPresentation().epoch === epoch) setLoadError('Settings could not be loaded. Check the local data service.')
      }).finally(() => { if (!stopped) setLoaded(true) })
    }
    return () => { stopped = true; window.removeEventListener('radar-preferences-changed', receive) }
  }, [])

  const save = useCallback(async (values: Preferences) => {
    const before = version.current
    const epoch = getPresentation().epoch
    try {
      const saved = await window.radarDesktop.request({ preferences: { action: 'update', values } })
      await waitForPresentation()
      let authoritative = saved
      if (epoch !== getPresentation().epoch) {
        // A write can finish after the activation snapshot was collected.
        const beforeRead = version.current
        const actual = await window.radarDesktop.request({ preferences: { action: 'read' } })
        await waitForPresentation()
        if (beforeRead === version.current) { setPreferences(actual); authoritative = actual }
      } else if (version.current === before) {
        // A later broadcast is authoritative over an older response.
        setPreferences(saved)
      }
      setLoadError('')
      return authoritative
    } catch (error) {
      await waitForPresentation()
      // A failed response does not prove that the backend did not commit.
      const beforeRead = version.current
      try {
        const actual = await window.radarDesktop.request({ preferences: { action: 'read' } })
        await waitForPresentation()
        if (version.current === beforeRead) setPreferences(actual)
      } catch { /* Keep the last confirmed preferences when reconciliation is unavailable. */ }
      throw error
    }
  }, [])
  const updateStatuses = useCallback((items: SettingsStatusValue[]) => setStatuses(current => JSON.stringify(current) === JSON.stringify(items) ? current : items), [])

  return <WorkspaceViewport>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkspaceSettings section={section} active preferences={preferences} loaded={loaded} loadError={loadError} onRetryLoad={reloadPreferences} onSave={save} onNavigationStateChange={updateGuard} onStatusChange={updateStatuses} />
      {(loadError || statuses.length > 0) && <footer aria-label="Settings status" className="max-h-24 shrink-0 overflow-y-auto border-t px-4 py-1 text-xs text-muted-foreground" role="status">
        {loadError && <p>{loadError}</p>}
        {statuses.map(item => <p key={item.id} className={item.severity === 'error' ? 'text-destructive' : undefined}><span className="font-medium">{item.label}: </span>{item.detail}</p>)}
      </footer>}
    </div>
  </WorkspaceViewport>
}
