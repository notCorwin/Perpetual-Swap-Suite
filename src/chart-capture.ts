import type { ChartCaptureBounds } from './desktop-contract.ts'
export type { ChartCaptureBounds, ChartImage } from './desktop-contract.ts'

export function chartCaptureBounds(element: HTMLElement): ChartCaptureBounds {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) throw new Error('Chart is not ready for capture.')
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not prepare the chart background.')
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--background')
  context.fillRect(0, 0, 1, 1)
  const backgroundRGB = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(value => value / 255)
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, backgroundRGB }
}

/** Reject captures when the chart changes before the asynchronous pixels arrive. */
export async function captureStableChart<T>(capture: () => Promise<T>, current: () => boolean): Promise<T> {
  if (!current()) throw new Error('Chart changed before capture. Start again.')
  const image = await capture()
  if (!current()) throw new Error('Chart changed during capture. Start again.')
  return image
}

/** Remove the action and contract list from the captured chart workspace. */
export async function eraseCapturedAction(dataURL: string, bounds: ChartCaptureBounds, actions: DOMRect[], background: string, list: DOMRect): Promise<string> {
  const image = new Image()
  image.src = dataURL
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not prepare the chart image.')
  context.drawImage(image, 0, 0)
  // Electron captures the enclosing integer rectangle, not the fractional DOM box.
  const captureX = Math.floor(bounds.x), captureY = Math.floor(bounds.y)
  const captureWidth = Math.ceil(bounds.x + bounds.width) - captureX
  const captureHeight = Math.ceil(bounds.y + bounds.height) - captureY
  const xScale = canvas.width / captureWidth, yScale = canvas.height / captureHeight
  context.fillStyle = background
  context.fillRect(Math.floor((list.left - captureX) * xScale), Math.floor((list.top - captureY) * yScale), Math.ceil(list.width * xScale), Math.ceil(list.height * yScale))
  // Include the controls' borders and focus rings while leaving the title intact.
  const padding = 3
  for (const action of actions) {
    const left = Math.floor((action.left - captureX - padding) * xScale)
    const top = Math.floor((action.top - captureY - padding) * yScale)
    const right = Math.ceil((action.right - captureX + padding) * xScale)
    const bottom = Math.ceil((action.bottom - captureY + padding) * yScale)
    context.fillStyle = background
    context.fillRect(left, top, right - left, bottom - top)
  }
  return canvas.toDataURL('image/png')
}
