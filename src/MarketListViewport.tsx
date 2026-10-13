import { useLayoutEffect, useRef, type ReactNode } from "react"

export function MarketListViewport({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const designWidth = Number.parseFloat(getComputedStyle(viewport).getPropertyValue("--market-list-design-width"))
    let scale = 1
    let widthFrame: number | null = null
    let heightFrame: number | null = null
    let previousWidth = -1
    let stopped = false
    const fitHeight = () => {
      heightFrame = null
      viewport.style.height = `${content.getBoundingClientRect().height}px`
    }
    const scheduleHeight = () => {
      if (!stopped && heightFrame === null) heightFrame = window.requestAnimationFrame(fitHeight)
    }
    const fitWidth = () => {
      widthFrame = null
      const available = viewport.getBoundingClientRect().width
      if (!available) return
      const width = Math.max(available, designWidth)
      content.style.width = `${width}px`
      scale = Math.min(1, available / designWidth)
      // Portaled dialogs retain the same design layout and typography scale.
      const root = document.documentElement.style
      root.setProperty('--market-list-scale', String(scale))
      root.setProperty('--market-list-layout-width', `${window.innerWidth / scale}px`)
      root.setProperty('--market-list-layout-height', `${window.innerHeight / scale}px`)
      content.style.minHeight = `${window.innerHeight / scale}px`
      // Keep the design canvas independent from live content. Data changes may
      // repaint a cell, but only a viewport resize may change the global scale.
      content.style.transform = `scale(${scale})`
      fitHeight()
    }
    const scheduleWidth = () => {
      if (!stopped && widthFrame === null) widthFrame = window.requestAnimationFrame(fitWidth)
    }
    const viewportObserver = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width
      if (Math.abs(width - previousWidth) <= 0.5) return
      previousWidth = width
      scheduleWidth()
    })
    const contentObserver = new ResizeObserver(scheduleHeight)
    viewportObserver.observe(viewport)
    contentObserver.observe(content)
    window.addEventListener("resize", scheduleWidth)
    fitWidth()
    void document.fonts.ready.then(scheduleHeight)
    return () => {
      stopped = true
      viewportObserver.disconnect(); contentObserver.disconnect()
      window.removeEventListener("resize", scheduleWidth)
      if (widthFrame !== null) window.cancelAnimationFrame(widthFrame)
      if (heightFrame !== null) window.cancelAnimationFrame(heightFrame)
      for (const token of ['--market-list-scale', '--market-list-layout-width', '--market-list-layout-height']) document.documentElement.style.removeProperty(token)
    }
  }, [])

  return <div ref={viewportRef} className="w-full overflow-hidden">
    <div ref={contentRef} data-market-list-content className="origin-top-left">{children}</div>
  </div>
}
