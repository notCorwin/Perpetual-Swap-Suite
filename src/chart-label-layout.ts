export type ChartLabelSide = "top" | "bottom"

export type ChartLabel = {
  id: string
  anchorX: number
  anchorY: number
  text: string
  side: ChartLabelSide
  priority: number
}

export type PlacedChartLabel = ChartLabel & {
  x: number
  y: number
  width: number
  hidden: boolean
}

export type ChartLabelSummary = {
  id: string
  side: ChartLabelSide
  x: number
  y: number
  text: string
  count: number
}

type Rectangle = { left: number; right: number; top: number; bottom: number }

const overlaps = (left: Rectangle, right: Rectangle, gap: number) =>
  left.left < right.right + gap && left.right > right.left - gap &&
  left.top < right.bottom + gap && left.bottom > right.top - gap

export function placeChartLabels(
  labels: ChartLabel[],
  bounds: { left: number; right: number; top: number; bottom: number },
  measure: (text: string) => number,
  options: { height?: number; horizontalPadding?: number; gap?: number; laneGap?: number } = {},
) {
  const height = options.height ?? 12
  const horizontalPadding = options.horizontalPadding ?? 4
  const gap = options.gap ?? 3
  const laneGap = options.laneGap ?? 4
  const laneStep = height + gap + laneGap
  const occupied: Rectangle[] = []
  const result = new Map<string, PlacedChartLabel>()

  const ordered = [...labels].sort((left, right) => left.priority - right.priority || left.anchorX - right.anchorX || left.id.localeCompare(right.id))
  for (const label of ordered) {
    const width = Math.min(bounds.right - bounds.left, measure(label.text) + horizontalPadding * 2)
    const x = Math.max(bounds.left + width / 2, Math.min(label.anchorX, bounds.right - width / 2))
    let placement: PlacedChartLabel | undefined

    for (let lane = 0; ; lane++) {
      const y = label.side === "top"
        ? label.anchorY - 10 - lane * laneStep
        : label.anchorY + 14 + lane * laneStep
      const rectangle = { left: x - width / 2, right: x + width / 2, top: y - height, bottom: y + 2 }
      if (rectangle.top < bounds.top || rectangle.bottom > bounds.bottom) break
      if (occupied.every(other => !overlaps(rectangle, other, gap))) {
        occupied.push(rectangle)
        placement = { ...label, x, y, width, hidden: false }
        break
      }
    }

    result.set(label.id, placement ?? { ...label, x, y: label.anchorY, width, hidden: true })
  }

  const summaries: ChartLabelSummary[] = []
  for (const side of ["top", "bottom"] as const) {
    const hidden = ordered.filter(label => label.side === side && result.get(label.id)?.hidden)
    if (!hidden.length) continue

    // Reuse the least important visible label's collision-free slot. This keeps
    // the density indicator readable without adding another overlapping box.
    const replacement = [...ordered].reverse().find(label => label.side === side && !result.get(label.id)?.hidden)
    if (!replacement) continue
    const placed = result.get(replacement.id)!
    placed.hidden = true
    const count = hidden.length + 1
    summaries.push({ id: `summary-${side}`, side, x: placed.x, y: placed.y, text: `+${count}`, count })
  }

  return { labels: result, summaries }
}
