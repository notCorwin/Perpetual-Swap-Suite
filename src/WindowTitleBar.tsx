import { useState, type ReactNode } from 'react'
import { Maximize2, Minus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DesktopCommands } from '@/desktop-contract'

export function WindowTitleBar({ children }: { children: ReactNode }) {
  const [error, setError] = useState('')
  const control = async (action: DesktopCommands['windowControl']['input']['action']) => {
    setError('')
    try { await window.radarDesktop.request({ windowControl: { action } }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The window action could not be completed.') }
  }
  return <>
    <header data-window-titlebar className="grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-b bg-background px-2 select-none" aria-label="Window title bar">
      <div role="group" aria-label="Window controls" className="flex items-center gap-1">
        <Button variant="ghost" size="icon" aria-label="Close window" title="Close window" onClick={() => void control('close')}><X aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon" aria-label="Minimize window" title="Minimize window" onClick={() => void control('minimize')}><Minus aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon" aria-label="Zoom window" title="Zoom window" onClick={() => void control('toggleMaximize')}><Maximize2 aria-hidden="true" /></Button>
      </div>
      <h1 className="truncate font-mono text-sm font-medium">Perpetual Swap Suite</h1>
      <div className="flex min-w-0 justify-end">{children}</div>
    </header>
    {error && <p role="alert" className="shrink-0 border-b px-4 py-2 text-sm text-destructive">{error}</p>}
  </>
}
