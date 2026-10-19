import { useEffect, useRef, useState, type RefObject } from 'react'

export const SETTINGS_SECTIONS = [
  { id: 'workspace', label: 'Workspace', description: 'Chart defaults and contract ranking.' },
  { id: 'liquidity', label: 'Liquidity filters', description: 'Choose which contracts qualify for the market list.' },
  { id: 'data', label: 'Market data', description: 'Download history and verify your local data.' },
  { id: 'analysis', label: 'AI analysis', description: 'Configure chart analysis and your Gateway connection.' },
] as const
export type SettingsSection = typeof SETTINGS_SECTIONS[number]['id']
export type SettingsNavigationState = { dirty: boolean; busy: boolean }
export const settingsHref = (section: SettingsSection) => `#/settings/${section}`
const readSection = (): SettingsSection | null => {
  const hash = window.location.hash
  if (hash === '#/settings' || hash === '#/settings/') return 'workspace'
  return SETTINGS_SECTIONS.find(section => settingsHref(section.id) === hash)?.id ?? null
}

export function useSettingsSection(guard: RefObject<SettingsNavigationState>) {
  const [section, setSection] = useState(readSection)
  const accepted = useRef({ section, hash: window.location.hash })
  useEffect(() => {
    const navigate = () => {
      const next = readSection()
      if (accepted.current.section !== null && next === null
        && (guard.current.busy || guard.current.dirty && !window.confirm('Discard your unsaved settings changes?'))) {
        history.replaceState(null, '', accepted.current.hash)
        return
      }
      accepted.current = { section: next, hash: window.location.hash }
      setSection(next)
    }
    const openAnalysis = () => { window.location.hash = settingsHref('analysis') }
    window.addEventListener('hashchange', navigate)
    window.addEventListener('radar-analysis-settings', openAnalysis)
    return () => {
      window.removeEventListener('hashchange', navigate)
      window.removeEventListener('radar-analysis-settings', openAnalysis)
    }
  }, [guard])
  useEffect(() => { document.title = section ? 'Settings — Perpetual Swap Suite' : 'Perpetual Swap Suite' }, [section])
  return section
}
