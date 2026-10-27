import { useLayoutEffect, useState, type ReactNode } from 'react'
import { WORKSPACE_DESIGN_WIDTH, windowToolbarLayout } from '../electron/window-layout.js'

// Zoom the common ancestor of the workspace and all body-mounted portals.
// DOM rectangles remain screen CSS pixels, which capture and SVG pointers use.
export function WorkspaceViewport({ children }: { children: ReactNode }) {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const { scale, height: toolbarHeight, controlsInset } = windowToolbarLayout(viewport.width, window.radarDesktop.nativeWindowControls)
  useLayoutEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useLayoutEffect(() => {
    document.body.style.zoom = String(scale)
    document.body.style.setProperty("--workspace-height", `${viewport.height / scale}px`)
    document.body.style.setProperty('--native-window-controls-width', `${controlsInset / scale}px`)
    document.body.style.setProperty('--window-toolbar-height', `${toolbarHeight / scale}px`)
    return () => {
      document.body.style.removeProperty('zoom')
      for (const property of ['--workspace-height', '--native-window-controls-width', '--window-toolbar-height']) document.body.style.removeProperty(property)
    }
  }, [scale, viewport.height, controlsInset, toolbarHeight])
  return <div data-layout="market-workspace" data-design-width={WORKSPACE_DESIGN_WIDTH} data-ui-scale={scale} className="flex overflow-hidden" style={{ width: WORKSPACE_DESIGN_WIDTH, height: viewport.height / scale }}>{children}</div>
}
