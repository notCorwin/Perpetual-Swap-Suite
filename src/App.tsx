import { Button } from '@base-ui/react/button'
import { Select } from '@base-ui/react/select'
import { ChevronDown, RefreshCw, Settings2 } from 'lucide-react'
import { useLayoutEffect, useState } from 'react'
import { InspectorPanel } from './components/InspectorPanel'
import { MarketChart } from './components/MarketChart'
import { MarketSidebar } from './components/MarketSidebar'
import { SettingsDialog } from './components/SettingsDialog'
import type { Timeframe } from './types'
import { useWorkspace } from './use-workspace'

const timeframes: Timeframe[] = ['5m', '15m', '30m', '1H', '4H', '1D']

export default function App() {
  const workspace = useWorkspace()
  const { snapshot } = workspace
  const [settingsOpen, setSettingsOpen] = useState(false)
  const market = snapshot.markets.find(item => item.instrument.id === snapshot.selectedInstrument)

  useLayoutEffect(() => {
    const resize = () => {
      const scale = Math.min(1, window.innerWidth / 1440, window.innerHeight / 900)
      document.documentElement.style.setProperty('--workspace-scale', String(scale))
      document.documentElement.style.setProperty('--workspace-width', `${scale < 1 ? 1440 : window.innerWidth}px`)
      document.documentElement.style.setProperty('--workspace-height', `${scale < 1 ? 900 : window.innerHeight}px`)
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  const setTimeframe = (value: Timeframe | null) => {
    if (!value) return
    void workspace.saveSettings({ ...snapshot.settings, selectedTimeframe: value })
  }

  return <div className="viewport-shell">
    <div className="workspace-shell">
      <header className="titlebar">
        <div className="traffic-light-inset" />
        <div className="brand"><span className="brand-mark">PS</span><div><strong>Perpetual Swap Suite</strong><small>OKX MARKET LAB</small></div></div>
        <div className="titlebar-center">
          <span className={`status-dot ${snapshot.status === 'Live' ? 'live' : ''}`} />
          <span>{snapshot.status}</span>
          {snapshot.updatedAt > 0 && <span className="updated-time">Updated {new Date(snapshot.updatedAt).toLocaleTimeString('en-US', { hour12: false })}</span>}
        </div>
        <div className="titlebar-actions">
          <Select.Root value={snapshot.settings.selectedTimeframe} onValueChange={setTimeframe}>
            <Select.Trigger className="select-trigger" aria-label="Chart timeframe"><Select.Value /><Select.Icon><ChevronDown size={12} /></Select.Icon></Select.Trigger>
            <Select.Portal><Select.Positioner sideOffset={5} className="select-positioner"><Select.Popup className="select-popup"><Select.List>{timeframes.map(value => <Select.Item key={value} value={value} className="select-item"><Select.ItemText>{value}</Select.ItemText><Select.ItemIndicator>✓</Select.ItemIndicator></Select.Item>)}</Select.List></Select.Popup></Select.Positioner></Select.Portal>
          </Select.Root>
          <Button className="icon-button" aria-label="Refresh market data" disabled={workspace.pending} onClick={() => void workspace.refresh()}><RefreshCw size={14} className={workspace.pending ? 'spin' : ''} /></Button>
          <Button className="icon-button" aria-label="Open settings" onClick={() => setSettingsOpen(true)}><Settings2 size={15} /></Button>
        </div>
      </header>
      {workspace.error && <div className="error-banner">{workspace.error}</div>}
      <main className="three-column-workspace">
        <MarketSidebar markets={snapshot.markets} selected={snapshot.selectedInstrument} onSelect={instrument => void workspace.select(instrument)} />
        <MarketChart market={market} candles={snapshot.candles} forming={snapshot.formingCandle} timeframe={snapshot.settings.selectedTimeframe} />
        <InspectorPanel snapshot={snapshot} onValidate={workspace.validate} />
      </main>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} settings={snapshot.settings} onSave={workspace.saveSettings} />
    </div>
  </div>
}
