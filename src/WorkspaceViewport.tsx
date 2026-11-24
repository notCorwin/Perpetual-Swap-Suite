import { useLayoutEffect, useState, type ReactNode } from 'react'
import { WORKSPACE_DESIGN_WIDTH, windowToolbarLayout } from '../electron/window-layout.js'
import { getPresentation, subscribePresentationTransition } from '@/presentation-store'

// Workspace and body-mounted portals share unscaled CSS-pixel coordinates.
export function WorkspaceViewport({ children }: { children: ReactNode }) {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const { scale, height: toolbarHeight, controlsInset } = windowToolbarLayout(viewport.width, window.radarDesktop.nativeWindowControls)
  useLayoutEffect(() => {
    const sync = () => {
      if (!getPresentation().active) return
      setViewport(current => current.width === window.innerWidth && current.height === window.innerHeight ? current : { width: window.innerWidth, height: window.innerHeight })
    }
    window.addEventListener('resize', sync)
    const stop = subscribePresentationTransition(update => { if (update.active) sync() })
    return () => { window.removeEventListener('resize', sync); stop() }
  }, [])
  useLayoutEffect(() => {
    document.body.style.removeProperty('zoom')
    document.body.style.setProperty("--workspace-height", `${viewport.height}px`)
    document.body.style.setProperty('--native-window-controls-width', `${controlsInset}px`)
    document.body.style.setProperty('--window-toolbar-height', `${toolbarHeight}px`)
    return () => {
      document.body.style.removeProperty('zoom')
      for (const property of ['--workspace-height', '--native-window-controls-width', '--window-toolbar-height']) document.body.style.removeProperty(property)
    }
  }, [viewport.height, controlsInset, toolbarHeight])
  return <div data-layout="market-workspace" data-design-width={WORKSPACE_DESIGN_WIDTH} data-ui-scale={scale} className="flex overflow-hidden" style={{ width: viewport.width, height: viewport.height }}>{children}</div>
}
