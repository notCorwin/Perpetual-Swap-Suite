export const CHART_WHEEL_PIXELS_PER_BAR = 12

export function chartRsiNavigationTarget(indices: readonly number[], current: number, direction: -1 | 1) {
  const visible = [...new Set(indices.filter(index => index >= 0))].sort((left, right) => left - right)
  return direction < 0 ? visible.findLast(index => index < current) : visible.find(index => index > current)
}

export type ChartWheelProgress = Readonly<{ steps: number; remainderPixels: number; fraction: number }>

/** Preserve sub-bar wheel input while returning whole bars to window navigation. */
export function advanceChartWheel(remainderPixels: number, pixels: number): ChartWheelProgress {
  if (!Number.isFinite(remainderPixels) || !Number.isFinite(pixels)) {
    return { steps: 0, remainderPixels: 0, fraction: 0 }
  }
  const total = remainderPixels + pixels
  const steps = Math.trunc(total / CHART_WHEEL_PIXELS_PER_BAR) || 0
  const remainder = total - steps * CHART_WHEEL_PIXELS_PER_BAR
  return { steps, remainderPixels: remainder, fraction: remainder / CHART_WHEEL_PIXELS_PER_BAR }
}

/** Collect wheel pixels until the next navigation update. */
export function createChartWheelBatch() {
  let pendingPixels = 0
  return {
    add(pixels: number) {
      if (Number.isFinite(pixels)) pendingPixels += pixels
    },
    consume(remainderPixels: number) {
      const pixels = pendingPixels
      pendingPixels = 0
      return advanceChartWheel(remainderPixels, pixels)
    },
    reset() { pendingPixels = 0 },
    get pending() { return pendingPixels !== 0 },
  }
}

/** Apply the first burst before the next frame and coalesce later input into that frame. */
export function createChartWheelScheduler({ queueMicrotask, requestFrame, cancelFrame }: {
  queueMicrotask: (callback: () => void) => void
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
}) {
  let pending: (() => void) | null = null
  let token: object | null = null
  let frame: number | null = null
  const flush = () => {
    const callback = pending
    pending = null
    callback?.()
  }
  return {
    schedule(callback: () => void) {
      pending = callback
      if (frame !== null) return
      const current = token = {}
      queueMicrotask(() => { if (token === current) flush() })
      frame = requestFrame(() => {
        if (token !== current) return
        frame = null
        token = null
        flush()
      })
    },
    cancel() {
      pending = null
      token = null
      if (frame !== null) cancelFrame(frame)
      frame = null
    },
  }
}

/** Return the visible plot translation, limited to sides with a known adjacent bar. */
export function chartWheelContentOffset(fraction: number, barPitch: number, hasBefore: boolean, hasAfter: boolean) {
  if (!Number.isFinite(fraction) || !Number.isFinite(barPitch) || barPitch <= 0
    || fraction < 0 && !hasBefore || fraction > 0 && !hasAfter) return 0
  return -fraction * barPitch
}
