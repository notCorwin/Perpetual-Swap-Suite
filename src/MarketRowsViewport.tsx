import { Fragment, memo, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { TableBody, TableCell, TableRow } from "@/components/ui/table"

// The list is scaled as a complete macOS window layout. Measure in screen pixels
// for scrolling, then convert spacer heights back into the original design size.
export const MarketRowsViewport = memo(function MarketRowsViewport({ ids, children }: { ids: string[]; children: (index: number) => ReactNode }) {
  const body = useRef<HTMLTableSectionElement>(null)
  const geometry = useRef({ top: 0, rowSize: 56, scroller: null as HTMLElement | null })
  const focusRequest = useRef<number | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  const [range, setRange] = useState({ first: 0, end: Math.min(ids.length, 20), size: 56 })

  useLayoutEffect(() => {
    const element = body.current
    const scroller = element?.closest<HTMLElement>("[data-market-scroll]")
    if (!element || !scroller) return
    let frame: number | null = null
    const overscan = 8
    const measure = () => {
      frame = null
      const rect = element.getBoundingClientRect(), scale = rect.width / element.offsetWidth || 1
      const row = element.querySelector<HTMLTableRowElement>("tr[data-market-index]")
      const size = row ? row.getBoundingClientRect().height / scale : geometry.current.rowSize
      if (!(size > 0)) return
      const viewport = scroller.getBoundingClientRect(), pixels = size * scale
      geometry.current = { top: (rect.top - viewport.top) / scale + scroller.scrollTop, rowSize: size, scroller }
      const first = Math.min(Math.max(0, ids.length - 1), Math.max(0, Math.floor((viewport.top - rect.top) / pixels) - overscan))
      const end = Math.min(ids.length, Math.max(first + 1, Math.ceil((viewport.bottom - rect.top) / pixels) + overscan))
      setRange(current => current.first === first && current.end === end && Math.abs(current.size - size) < 0.1 ? current : { first, end, size })
    }
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(measure) }
    const focus = (event: FocusEvent) => {
      const target = event.target as HTMLElement
      const row = target.closest<HTMLTableRowElement>("tr[data-market-index]")
      if (row && element.contains(row)) setPinned(ids[Number(row.dataset.marketIndex)])
      else if (!target.closest("[data-slot=select-content], [role=dialog]")) setPinned(null)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    observer.observe(scroller)
    scroller.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    document.addEventListener("focusin", focus)
    measure()
    return () => {
      observer.disconnect(); scroller.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); document.removeEventListener("focusin", focus)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [ids])

  useLayoutEffect(() => {
    if (focusRequest.current === null) return
    const row = body.current?.querySelector<HTMLTableRowElement>(`tr[data-market-index="${focusRequest.current}"]`)
    if (row) { focusRequest.current = null; row.focus() }
  }, [range])

  const first = Math.min(range.first, Math.max(0, ids.length - 1))
  const end = Math.min(ids.length, Math.max(first + 1, range.end))
  const indices = new Set(Array.from({ length: Math.max(0, end - first) }, (_, offset) => first + offset))
  const pinnedIndex = pinned ? ids.indexOf(pinned) : -1
  if (pinnedIndex >= 0) indices.add(pinnedIndex)
  const ordered = [...indices].sort((a, b) => a - b)
  const spacer = (count: number, key: string) => count > 0 && <TableRow key={key} aria-hidden="true" className="border-0" data-virtual-spacer><TableCell colSpan={3} className="p-0" style={{ height: count * range.size }} /></TableRow>
  return <TableBody ref={body} onKeyDownCapture={event => {
    if (!(event.target instanceof HTMLTableRowElement) || !["Home", "End"].includes(event.key)) return
    const target = event.key === "Home" ? 0 : ids.length - 1
    event.preventDefault()
    const existing = body.current?.querySelector<HTMLTableRowElement>(`tr[data-market-index="${target}"]`)
    if (existing) existing.focus()
    else {
      focusRequest.current = target
      geometry.current.scroller?.scrollTo({ top: geometry.current.top + target * geometry.current.rowSize, behavior: "instant" })
      setRange(current => ({ ...current, first: Math.max(0, target - 8), end: Math.min(ids.length, target + 9) }))
    }
  }}>
    {ordered.map((index, position) => <Fragment key={ids[index]}>{spacer(index - (position ? ordered[position - 1] + 1 : 0), `before-${index}`)}{children(index)}</Fragment>)}
    {spacer(ids.length - (ordered.length ? ordered[ordered.length - 1] + 1 : 0), "after")}
  </TableBody>
})
