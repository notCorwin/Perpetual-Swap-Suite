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

type CoveredCharts = { cover: DOMRect; charts: { rect: DOMRect; source: string }[]; dividers: { rect: DOMRect; color: string; width: number }[] }

/** Take a visual snapshot of the underlying SVGs without changing the interactive UI. */
export function snapshotCoveredCharts(element: HTMLElement, cover: DOMRect): CoveredCharts {
  const charts = Array.from(element.querySelectorAll<SVGSVGElement>('svg[data-rendered-inst]')).map(svg => {
    const clone = svg.cloneNode(true) as SVGSVGElement
    const computed = getComputedStyle(svg)
    // Presentation attributes use inherited design tokens; make them self-contained
    // for SVG image decoding, which has no access to the document stylesheet.
    for (const property of computed) if (property.startsWith('--')) clone.style.setProperty(property, computed.getPropertyValue(property))
    clone.style.fontFamily = computed.fontFamily
    clone.style.fontSize = computed.fontSize
    clone.style.color = computed.color
    clone.style.visibility = 'visible'
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    return { rect: svg.getBoundingClientRect(), source: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}` }
  })
  const dividers = Array.from(element.querySelectorAll<HTMLElement>('[data-chart-workspace]')).flatMap(workspace => {
    const style = getComputedStyle(workspace)
    const width = Number.parseFloat(style.borderTopWidth)
    return width > 0 ? [{ rect: workspace.getBoundingClientRect(), color: style.borderTopColor, width }] : []
  })
  return { cover, charts, dividers }
}

/** Remove a toolbar action and restore chart pixels covered by the floating panel. */
export async function eraseCapturedAction(dataURL: string, bounds: ChartCaptureBounds, action: DOMRect, background: string, covered?: CoveredCharts): Promise<string> {
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
  if (covered) {
    // The shadow extends beyond the panel. Restore a slightly larger rectangle
    // from the captured SVG snapshots, without ever hiding the live panel.
    const shadow = 16
    const left = Math.floor((covered.cover.left - captureX - shadow) * xScale)
    const firstChartTop = Math.min(...covered.charts.map(chart => chart.rect.top))
    const top = Math.floor((Math.max(firstChartTop, covered.cover.top - shadow) - captureY) * yScale)
    const right = Math.ceil((covered.cover.right - captureX + shadow) * xScale)
    const bottom = Math.ceil((covered.cover.bottom - captureY + shadow) * yScale)
    context.save()
    context.beginPath(); context.rect(left, top, right - left, bottom - top); context.clip()
    context.fillStyle = background
    context.fillRect(left, top, right - left, bottom - top)
    for (const chart of covered.charts) {
      const svg = new Image()
      svg.src = chart.source
      await svg.decode()
      context.drawImage(svg, (chart.rect.left - captureX) * xScale, (chart.rect.top - captureY) * yScale, chart.rect.width * xScale, chart.rect.height * yScale)
    }
    for (const divider of covered.dividers) {
      context.fillStyle = divider.color
      context.fillRect((divider.rect.left - captureX) * xScale, (divider.rect.top - captureY) * yScale, divider.rect.width * xScale, divider.width * yScale)
    }
    context.restore()
  }
  // Include the button border and focus ring while leaving the title intact.
  const padding = 3
  const left = Math.floor((action.left - captureX - padding) * xScale)
  const top = Math.floor((action.top - captureY - padding) * yScale)
  const right = Math.ceil((action.right - captureX + padding) * xScale)
  const bottom = Math.ceil((action.bottom - captureY + padding) * yScale)
  context.fillStyle = background
  context.fillRect(left, top, right - left, bottom - top)
  return canvas.toDataURL('image/png')
}
