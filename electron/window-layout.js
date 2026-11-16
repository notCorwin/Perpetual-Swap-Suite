export const WORKSPACE_DESIGN_WIDTH = 1600

// Keep normal density above the design width; compact windows scale down.
// Both sides must use the same physical toolbar height and vertical center.
export function windowToolbarLayout(width, nativeWindowControls = false) {
  const scale = Math.min(1, width / WORKSPACE_DESIGN_WIDTH)
  const height = Math.max(48 * scale, nativeWindowControls ? 36 : 0)
  return {
    scale, height, controlsInset: nativeWindowControls ? 72 : 0,
    // AppKit's 14-point button face occupies a 16-point native view.
    buttonsPosition: nativeWindowControls ? { x: Math.round(16 * scale), y: Math.round((height - 16) / 2) } : undefined,
  }
}
