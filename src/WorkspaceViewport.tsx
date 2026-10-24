import { useLayoutEffect, useState, type ReactNode } from 'react'

export const WORKSPACE_DESIGN_WIDTH = 1600

// Zoom the common ancestor of the workspace and all body-mounted portals.
// DOM rectangles remain screen CSS pixels, which capture and SVG pointers use.
export function WorkspaceViewport({ children }: { children: ReactNode }) {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const scale = viewport.width / WORKSPACE_DESIGN_WIDTH
  useLayoutEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useLayoutEffect(() => {
    document.body.style.zoom = String(scale)
    document.body.style.setProperty("--workspace-height", `${viewport.height / scale}px`)
    const native = window.radarDesktop.nativeWindowControls
    document.body.style.setProperty('--native-window-controls-width', `${native ? 72 / scale : 0}px`)
    document.body.style.setProperty('--native-window-controls-row-height', `${native ? 28 / scale : 0}px`)
    document.body.style.setProperty('--native-window-controls-header-height', `${native ? 44 / scale : 0}px`)
    return () => {
      document.body.style.removeProperty('zoom')
      for (const property of ['--workspace-height', '--native-window-controls-width', '--native-window-controls-row-height', '--native-window-controls-header-height']) document.body.style.removeProperty(property)
    }
  }, [scale, viewport.height])
  return <div data-layout="market-workspace" data-design-width={WORKSPACE_DESIGN_WIDTH} data-ui-scale={scale} className="flex overflow-hidden" style={{ width: WORKSPACE_DESIGN_WIDTH, height: viewport.height / scale }}>{children}</div>
}
