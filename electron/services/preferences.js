// Shared preference schema: no Electron, native modules, or credentials.
const TIMEFRAMES = new Set(['5m', '15m', '1H'])

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

export const DEFAULT_PREFERENCES = freeze({
  chartTimeframe: '15m',
  rankingLookback: 15,
  historyDays: 30,
  liquidity: {
    spread: { enabled: true, maxPercent: 0.05 },
    depth: { enabled: true, minUSDT: 100_000 },
    slippage: { enabled: true, maxPercent: 0.1, notionalUSDT: 100_000 },
    volume24h: { enabled: true, minUSDT: 30_000_000 },
    openInterest: { enabled: true, minUSDT: 5_000_000 },
    volumeStability: { enabled: false, maxRatio: 2 },
  },
})

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain object.`)
}

function keys(value, allowed, label) {
  object(value, label)
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`${label} contains an unknown field.`)
}

function positive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be a positive finite number.`)
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer.`)
}

export function validatePreferenceFields(value, partial = false) {
  keys(value, Object.keys(DEFAULT_PREFERENCES), 'Preferences')
  for (const key of Object.keys(DEFAULT_PREFERENCES)) {
    if (partial && !Object.hasOwn(value, key)) continue
    if (key === 'chartTimeframe') {
      if (!TIMEFRAMES.has(value[key])) throw new TypeError('chartTimeframe must be 5m, 15m, or 1H.')
    } else if (key === 'rankingLookback') {
      integer(value[key], key)
      if (value[key] < 5 || value[key] % 5 !== 0 || !Number.isSafeInteger(value[key] * 60_000)) throw new TypeError('rankingLookback must be a positive multiple of 5 minutes within the timestamp range.')
    } else if (key === 'historyDays') {
      integer(value[key], key)
      if (value[key] < 1 || value[key] > 3650) throw new TypeError('historyDays must be a whole number from 1 through 3650.')
    } else {
      const liquidity = value.liquidity
      keys(liquidity, Object.keys(DEFAULT_PREFERENCES.liquidity), 'liquidity')
      for (const [rule, fields] of Object.entries(DEFAULT_PREFERENCES.liquidity)) {
        if (partial && !Object.hasOwn(liquidity, rule)) continue
        keys(liquidity[rule], Object.keys(fields), `liquidity.${rule}`)
        for (const field of Object.keys(fields)) {
          if (partial && !Object.hasOwn(liquidity[rule], field)) continue
          const current = liquidity[rule][field]
          if (field === 'enabled') {
            if (typeof current !== 'boolean') throw new TypeError(`liquidity.${rule}.enabled must be a boolean.`)
          } else {
            positive(current, `liquidity.${rule}.${field}`)
            if (field === 'maxRatio' && current <= 1) throw new TypeError('liquidity.volumeStability.maxRatio must be greater than 1.')
          }
        }
      }
    }
  }
}

/** Validate a complete preference value and return an independent plain copy. */
export function validatePreferences(value) {
  validatePreferenceFields(value)
  return structuredClone(value)
}

