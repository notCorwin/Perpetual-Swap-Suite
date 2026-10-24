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
    return () => { document.body.style.removeProperty('zoom'); document.body.style.removeProperty('--workspace-height') }
  }, [scale, viewport.height])
  return <div data-layout="market-workspace" data-design-width={WORKSPACE_DESIGN_WIDTH} data-ui-scale={scale} className="flex overflow-hidden" style={{ width: WORKSPACE_DESIGN_WIDTH, height: viewport.height / scale }}>{children}</div>
}
