export type ChartCaptureBounds = { x: number; y: number; width: number; height: number; backgroundRGB: number[] }
export type ChartImage = { imageDataURL: string; width: number; height: number }

export function chartCaptureBounds(element: HTMLElement): ChartCaptureBounds {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) throw new Error('Chart is not ready for capture.')
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not prepare the chart background.')
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-snapshot-background')
  context.fillRect(0, 0, 1, 1)
  const backgroundRGB = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(value => value / 255)
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, backgroundRGB }
}
