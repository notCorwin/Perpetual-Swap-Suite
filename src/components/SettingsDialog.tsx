import { Button } from '@base-ui/react/button'
import { Dialog } from '@base-ui/react/dialog'
import { Input } from '@base-ui/react/input'
import { Switch } from '@base-ui/react/switch'
import { X } from 'lucide-react'
import { useState } from 'react'
import type { AppSettings } from '../types'

type Props = { open: boolean; onOpenChange(open: boolean): void; settings: AppSettings; onSave(settings: AppSettings): Promise<unknown> }

export function SettingsDialog({ open, onOpenChange, settings, onSave }: Props) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    {open && <SettingsForm settings={settings} onSave={onSave} onClose={() => onOpenChange(false)} />}
  </Dialog.Root>
}

function SettingsForm({ settings, onSave, onClose }: { settings: AppSettings; onSave(settings: AppSettings): Promise<unknown>; onClose(): void }) {
  const [draft, setDraft] = useState(() => settings)
  const [saving, setSaving] = useState(false)
  const number = (key: keyof AppSettings) => ({
    value: String(draft[key]),
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(current => ({ ...current, [key]: Number(event.target.value) })),
  })
  const save = async () => {
    setSaving(true)
    try { await onSave(draft); onClose() } finally { setSaving(false) }
  }
  return <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Viewport className="dialog-viewport">
        <Dialog.Popup className="dialog-popup">
          <div className="dialog-header"><div><span className="section-kicker">PREFERENCES</span><Dialog.Title>Workspace settings</Dialog.Title></div><Dialog.Close className="icon-button"><X size={15} /></Dialog.Close></div>
          <Dialog.Description className="dialog-description">Liquidity, simulation, and application defaults are persisted outside the market database.</Dialog.Description>
          <div className="settings-grid">
            <SettingsGroup title="Liquidity">
              <label className="setting-field"><span>Settlement currencies</span><div className="wide-setting-input"><Input value={draft.settlementCurrencies.join(', ')} onChange={event => setDraft(current => ({ ...current, settlementCurrencies: event.target.value.split(',').map(value => value.trim().toUpperCase()).filter(Boolean) }))} /></div></label>
              <Setting label="Maximum spread" suffix="%"><Input type="number" step="0.01" {...number('spreadLimitPercent')} /></Setting>
              <Setting label="Depth range" suffix="%"><Input type="number" step="0.1" {...number('depthRangePercent')} /></Setting>
              <Setting label="Minimum side depth" suffix="USDT"><Input type="number" step="1000" {...number('minimumSideDepthUSDT')} /></Setting>
              <Setting label="Slippage order" suffix="USDT"><Input type="number" step="1000" {...number('slippageNotionalUSDT')} /></Setting>
              <Setting label="Maximum slippage" suffix="%"><Input type="number" step="0.01" {...number('slippageLimitPercent')} /></Setting>
              <Setting label="Minimum 24h volume" suffix="USDT"><Input type="number" step="1000000" {...number('minimumVolume24hUSDT')} /></Setting>
              <Setting label="Minimum open interest" suffix="USDT"><Input type="number" step="1000000" {...number('minimumOpenInterestUSDT')} /></Setting>
            </SettingsGroup>
            <SettingsGroup title="Simulation">
              <Setting label="Initial capital" suffix="USDT"><Input type="number" step="10" {...number('initialCapitalUSDT')} /></Setting>
              <Setting label="Leverage" suffix="×"><Input type="number" step="1" {...number('leverage')} /></Setting>
              <Setting label="Take profit on margin" suffix="%"><Input type="number" step="1" {...number('takeProfitMarginPercent')} /></Setting>
              <Setting label="Stop loss on margin" suffix="%"><Input type="number" step="1" {...number('stopLossMarginPercent')} /></Setting>
              <Setting label="Taker fee" suffix="%"><Input type="number" step="0.01" {...number('takerFeePercent')} /></Setting>
              <label className="setting-switch"><span><strong>Hourly volume stability</strong><small>Require max / min below {draft.maximumHourlyVolumeRatio}</small></span><Switch.Root className="switch-root" checked={draft.volumeStabilityEnabled} onCheckedChange={value => setDraft(current => ({ ...current, volumeStabilityEnabled: value }))}><Switch.Thumb className="switch-thumb" /></Switch.Root></label>
            </SettingsGroup>
            <SettingsGroup title="Application">
              <label className="setting-switch"><span><strong>Continue in background</strong><small>Closing the window keeps market collection active</small></span><Switch.Root className="switch-root" checked={draft.backgroundEnabled} onCheckedChange={value => setDraft(current => ({ ...current, backgroundEnabled: value }))}><Switch.Thumb className="switch-thumb" /></Switch.Root></label>
              <label className="setting-switch"><span><strong>Launch at login</strong><small>Start the main application after signing in</small></span><Switch.Root className="switch-root" checked={draft.launchAtLogin} onCheckedChange={value => setDraft(current => ({ ...current, launchAtLogin: value }))}><Switch.Thumb className="switch-thumb" /></Switch.Root></label>
              <label className="setting-switch"><span><strong>Automatic updates</strong><small>Install the newest main-branch build</small></span><Switch.Root className="switch-root" checked={draft.automaticUpdatesEnabled} onCheckedChange={value => setDraft(current => ({ ...current, automaticUpdatesEnabled: value }))}><Switch.Thumb className="switch-thumb" /></Switch.Root></label>
              <div className="appearance-setting"><span>Appearance</span><div>{(['system', 'light', 'dark'] as const).map(value => <Button key={value} className="appearance-choice" data-selected={draft.appearance === value || undefined} onClick={() => setDraft(current => ({ ...current, appearance: value }))}>{value[0].toUpperCase() + value.slice(1)}</Button>)}</div></div>
            </SettingsGroup>
          </div>
          <div className="dialog-actions"><Dialog.Close className="secondary-button">Cancel</Dialog.Close><Button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save settings'}</Button></div>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) { return <section className="settings-group"><h3>{title}</h3>{children}</section> }
function Setting({ label, suffix, children }: { label: string; suffix: string; children: React.ReactNode }) { return <label className="setting-field"><span>{label}</span><div>{children}<small>{suffix}</small></div></label> }
