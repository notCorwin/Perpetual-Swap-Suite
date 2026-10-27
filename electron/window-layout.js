export const WORKSPACE_DESIGN_WIDTH = 1600

// Native buttons stay in macOS points while the renderer uses CSS zoom.
// Both sides must use the same physical toolbar height and vertical center.
export function windowToolbarLayout(width, nativeWindowControls = false) {
  const scale = width / WORKSPACE_DESIGN_WIDTH
  const height = Math.max(48 * scale, nativeWindowControls ? 36 : 0)
  return {
    scale, height, controlsInset: nativeWindowControls ? 72 : 0,
    // AppKit's 14-point button face occupies a 16-point native view.
    buttonsPosition: nativeWindowControls ? { x: Math.round(16 * scale), y: Math.round((height - 16) / 2) } : undefined,
  }
}
