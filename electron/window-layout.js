export const WORKSPACE_DESIGN_WIDTH = 1600

// Native chrome and renderer controls keep their size at every window width.
// Both sides must use the same physical toolbar height and vertical center.
export function windowToolbarLayout(width, nativeWindowControls = false) {
  const scale = 1
  const height = 36
  return {
    scale, height, controlsInset: nativeWindowControls ? 72 : 0,
    // AppKit's 14-point button face occupies a 16-point native view.
    buttonsPosition: nativeWindowControls ? { x: Math.round(12 * scale), y: Math.round((height - 16) / 2) } : undefined,
  }
}

// Test presentation remains owned by the guarded runtime, even with this flag.
export function backgroundWindowLaunch(argv, testMode = false, backgroundTests = false) {
  return !testMode && !backgroundTests && argv.includes('--background-launch')
}
