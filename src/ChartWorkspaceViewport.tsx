import { useLayoutEffect, useRef, type ReactNode } from 'react'

export function ChartWorkspaceViewport({ expanded, children }: { expanded: boolean; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!viewport.current || !content.current) return
    const fit = () => {
      const available = viewport.current!.clientWidth
      const design = expanded ? Number.parseFloat(getComputedStyle(viewport.current!).getPropertyValue('--analysis-design-width')) : available
      const width = Math.max(available, design), scale = available > 0 ? available / width : 1
      content.current!.style.width = `${width}px`
      content.current!.style.height = `${viewport.current!.clientHeight / scale}px`
      content.current!.style.transform = `scale(${scale})`
    }
    const observer = new ResizeObserver(fit); observer.observe(viewport.current); fit()
    return () => observer.disconnect()
  }, [expanded])
  return <div ref={viewport} className="h-svh w-full overflow-hidden"><div ref={content} data-chart-workspace className="h-full origin-top-left">{children}</div></div>
}
