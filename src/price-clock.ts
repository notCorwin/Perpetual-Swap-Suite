const FRESHNESS_MS = 30_000

export function isPriceFresh(observedAt: number | null | undefined, realtime: 'live' | 'stale' | undefined, now: number) {
  return realtime === 'live' && observedAt != null && now - observedAt < FRESHNESS_MS
}

// Scheduling owns no React state. Callers supply the current presentation gate
// so callbacks already queued at deactivation cannot wake an idle interface.
export function watchPriceFreshness({ observedAt, realtime, active, displayedAt, isActive, onTime }: {
  observedAt?: number | null
  realtime?: 'live' | 'stale'
  active: boolean
  displayedAt: number
  isActive: () => boolean
  onTime: (now: number) => void
}) {
  if (!active || realtime !== 'live' || observedAt == null) return
  const current = Date.now(), remaining = observedAt + FRESHNESS_MS - current
  if (isPriceFresh(observedAt, realtime, displayedAt) !== (remaining > 0)) onTime(current)
  if (remaining <= 0) return
  const timer = setTimeout(() => { if (isActive()) onTime(Date.now()) }, remaining)
  return () => clearTimeout(timer)
}

export function watchPriceCountdown(visible: boolean, isActive: () => boolean, onTime: (now: number) => void) {
  if (!visible) return
  onTime(Date.now())
  const timer = setInterval(() => { if (isActive()) onTime(Date.now()) }, 1000)
  return () => clearInterval(timer)
}
