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
