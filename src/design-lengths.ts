// Resolve all CSS lengths in one layout pass, then retain the immutable result.
// Custom properties can contain calc()/rem and must not be parsed as bare numbers.
export function readDesignLengths<T extends string>(defaults: Record<T, number>): Record<T, number> {
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;contain:strict;width:0;height:0;overflow:hidden'
  const entries = Object.entries(defaults) as [T, number][]
  const probes = entries.map(([token]) => {
    const probe = document.createElement('div')
    probe.style.width = `var(${token})`
    host.append(probe)
    return probe
  })
  document.documentElement.append(host)
  try {
    return Object.fromEntries(entries.map(([token, fallback], index) => {
      const width = getComputedStyle(probes[index]).width
      const value = width.endsWith('px') ? Number.parseFloat(width) : NaN
      return [token, Number.isFinite(value) && value >= 0 ? value : fallback]
    })) as Record<T, number>
  } finally { host.remove() }
}
