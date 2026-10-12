// Send geometry only. CSS remains the source of the material, and WebKit keeps
// ownership of layout, hit testing, scrolling, focus, and foreground rendering.
export function installFloatingGlass() {
  if (!window.radarAppearance?.nativeWindowBackground) return () => {}
  let frame = 0, previous = '', stopped = false
  const resized = new ResizeObserver(() => schedule())
  let watched: Element[] = []
  const update = () => {
    frame = 0
    const elements = [...document.querySelectorAll<HTMLElement>('[data-surface="floating"]')]
    if (elements.length !== watched.length || elements.some((element, index) => element !== watched[index])) {
      resized.disconnect(); elements.forEach(element => resized.observe(element)); watched = elements
    }
    const surfaces = elements.flatMap(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
      const radius = Number.parseFloat(style.backdropFilter.match(/blur\(([^)]+)\)/)?.[1] ?? '0')
      if (!radius || !rect.width || !rect.height || style.visibility === 'hidden') return []
      const scale = rect.width / element.offsetWidth
      return [{ x: rect.x, y: rect.y, width: rect.width, height: rect.height, radius: radius * scale, corner: Number.parseFloat(style.borderTopLeftRadius) * scale }]
    })
    const signature = JSON.stringify(surfaces)
    if (signature !== previous) {
      previous = signature
      void window.webkit.messageHandlers.radar.postMessage({ floatingGlassSurfaces: surfaces }).catch(() => { previous = '' })
    }
    if (elements.some(element => element.getAnimations().some(animation => animation.playState === 'running'))) schedule()
  }
  function schedule() { if (!stopped && !frame) frame = requestAnimationFrame(update) }
  const mutations = new MutationObserver(schedule)
  mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'data-state', 'data-surface'] })
  window.addEventListener('resize', schedule)
  document.addEventListener('scroll', schedule, true)
  document.addEventListener('animationstart', schedule, true)
  schedule()
  return () => {
    stopped = true; cancelAnimationFrame(frame); mutations.disconnect(); resized.disconnect()
    window.removeEventListener('resize', schedule)
    document.removeEventListener('scroll', schedule, true)
    document.removeEventListener('animationstart', schedule, true)
  }
}
