import type { Bar } from './chart-data.ts'

export const RSI_FIELDS = ['rsi6', 'rsi12', 'rsi24'] as const
export const RSI_LEVELS = [30, 70] as const

export type RsiField = typeof RSI_FIELDS[number]
export type RsiLevel = typeof RSI_LEVELS[number]
export type RsiCrossing = {
  field: RsiField
  index: number
  hour: number
  value: number
  level: RsiLevel
  direction: 'up' | 'down'
}

/** Crossing candles use sampled values; equality retains the last strict side. */
export function chartRsiCrossings(bars: readonly Pick<Bar, 'hour' | RsiField>[], intervalMS: number): RsiCrossing[] {
  const crossings: RsiCrossing[] = []
  if (!Number.isFinite(intervalMS) || intervalMS <= 0) return crossings

  const sides = RSI_FIELDS.map(() => RSI_LEVELS.map(() => 0))
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index]
    if (!Number.isFinite(bar.hour) || index > 0 && bar.hour - bars[index - 1].hour !== intervalMS) {
      for (const fieldSides of sides) fieldSides.fill(0)
    }
    if (!Number.isFinite(bar.hour)) continue

    for (let fieldIndex = 0; fieldIndex < RSI_FIELDS.length; fieldIndex++) {
      const field = RSI_FIELDS[fieldIndex], value = bar[field], fieldSides = sides[fieldIndex]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fieldSides.fill(0)
        continue
      }
      for (let levelIndex = 0; levelIndex < RSI_LEVELS.length; levelIndex++) {
        const level = RSI_LEVELS[levelIndex], side = value > level ? 1 : value < level ? -1 : 0
        if (side === 0) continue
        const previousSide = fieldSides[levelIndex]
        if (previousSide !== 0 && side !== previousSide) {
          crossings.push({ field, index, hour: bar.hour, value, level, direction: side > 0 ? 'up' : 'down' })
        }
        fieldSides[levelIndex] = side
      }
    }
  }
  return crossings
}
