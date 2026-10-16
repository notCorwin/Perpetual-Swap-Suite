function makeChartAxis(min: number, max: number, intervals: number, maxLabels: number) {
  const span = max - min || Math.max(Math.abs(max) * 0.01, 1e-10)
  if (min === max) { min -= span / 2; max += span / 2 }
  const rawStep = span / intervals
  const power = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / power
  let step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * power
  const round = (value: number) => Number(value.toPrecision(12))
  let lower = round(Math.floor(min / step) * step)
  let upper = round(Math.max(Math.ceil(max / step) * step, lower + step))
  while (Math.round((upper - lower) / step) + 1 > maxLabels) {
    const nextPower = 10 ** Math.floor(Math.log10(step))
    const multiple = step / nextPower
    step = (multiple < 1.5 ? 2 : multiple < 3.5 ? 5 : 10) * nextPower
    lower = round(Math.floor(min / step) * step)
    upper = round(Math.max(Math.ceil(max / step) * step, lower + step))
  }
  const ticks = Array.from({ length: Math.round((upper - lower) / step) + 1 }, (_, index) => round(lower + index * step))
  return { min: lower, max: upper, step, ticks, decimals: Math.max(0, Math.min(20, -Math.floor(Math.log10(step)))) }
}

export function chartAxis(min: number, max: number, intervals = 6) {
  return makeChartAxis(min, max, intervals, Infinity)
}

export function chartAxisForLabels(min: number, max: number, maxLabels: number) {
  const limit = Math.max(2, Math.floor(maxLabels))
  return makeChartAxis(min, max, limit - 1, limit)
}

export type LogChartAxis = { min: number; max: number; ticks: number[]; decimals: number; zeroInclusive: boolean }

const logCoordinate = (value: number, zeroInclusive: boolean) => zeroInclusive ? Math.log1p(value) / Math.LN10 : Math.log10(value)
const logValue = (coordinate: number, zeroInclusive: boolean) => zeroInclusive ? Math.expm1(coordinate * Math.LN10) : 10 ** coordinate

export function logarithmicChartAxis(min: number, max: number, maxLabels: number, zeroInclusive = false): LogChartAxis {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max || min < 0 || (!zeroInclusive && min <= 0)) {
    throw new RangeError("Logarithmic axes require a finite, ordered, nonnegative range")
  }
  const limit = Math.max(2, Math.floor(maxLabels))
  const low = logCoordinate(min, zeroInclusive), high = logCoordinate(max, zeroInclusive)
  const padding = low === high ? (min === 0 ? Math.log10(2) : zeroInclusive ? Math.max(low * 0.02, Number.EPSILON) : 0.01) : (high - low) * 0.04
  const lower = zeroInclusive ? Math.max(0, low - padding) : low - padding
  const upper = high + padding
  const axisMin = logValue(lower, zeroInclusive), axisMax = logValue(upper, zeroInclusive)
  const candidates = axisMin === 0 ? [0] : []
  const firstPower = axisMin === 0 ? Math.min(0, Math.floor(Math.log10(axisMax))) : Math.floor(Math.log10(axisMin))
  const lastPower = Math.ceil(Math.log10(axisMax))
  for (let power = firstPower; power <= lastPower; power++) {
    for (const multiple of [1, 2, 5]) {
      const tick = multiple * 10 ** power
      if (tick >= axisMin && tick <= axisMax) candidates.push(tick)
    }
  }
  const fallbackCount = Math.min(limit, 5)
  const ticks = candidates.length >= 2 ? candidates.length <= limit ? candidates : Array.from({ length: limit }, (_, index) => {
    const target = lower + (upper - lower) * index / (limit - 1)
    return candidates.reduce((closest, candidate) => Math.abs(logCoordinate(candidate, zeroInclusive) - target) < Math.abs(logCoordinate(closest, zeroInclusive) - target) ? candidate : closest)
  }).filter((tick, index, all) => all.indexOf(tick) === index).sort((a, b) => a - b) : Array.from({ length: fallbackCount }, (_, index) =>
    Number(logValue(lower + (upper - lower) * index / (fallbackCount - 1), zeroInclusive).toPrecision(12)))
  const differences = ticks.slice(1).map((tick, index) => tick - ticks[index]).filter(difference => difference > 0)
  const smallestStep = differences.length ? Math.min(...differences) : axisMax - axisMin
  const decimals = Math.max(0, Math.min(20, -Math.floor(Math.log10(smallestStep))))
  return { min: axisMin, max: axisMax, ticks, decimals, zeroInclusive }
}

export function logarithmicY(value: number, axis: LogChartAxis, panel: readonly [number, number]) {
  const min = logCoordinate(axis.min, axis.zeroInclusive), max = logCoordinate(axis.max, axis.zeroInclusive)
  return panel[1] - (logCoordinate(value, axis.zeroInclusive) - min) / (max - min) * (panel[1] - panel[0])
}
