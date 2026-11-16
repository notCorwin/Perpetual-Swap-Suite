export const WORKSPACE_DESIGN_WIDTH: number
export function windowToolbarLayout(width: number, nativeWindowControls?: boolean): {
  scale: number
  height: number
  controlsInset: number
  buttonsPosition?: { x: number; y: number }
}

export function backgroundWindowLaunch(argv: readonly string[], testMode?: boolean, backgroundTests?: boolean): boolean
