// Frozen compatibility fixtures from the v1 Web renderer. The shipped UI reads
// native Opportunity and rule results; this generator is only a migration oracle.
import { writeFileSync } from "node:fs"
import { evaluateMarketOpportunity } from "../src/market-opportunity.ts"
import { FILTER_FIELDS } from "../src/market-filters.ts"
import type { MarketRow } from "../src/market-row.ts"

const event = (age: number) => ({ status: "event" as const, hour: 100 * 3_600_000, hoursAgo: age, priorHour: 50 * 3_600_000, priorAgeHours: 50, priorPrice: 100, live: age === 0 })
const base: MarketRow = {
  instId: "BTC-USDT-SWAP", turnover24hUSDT: 20_000_000, ema200Signal: "Long", price: 110, priceChange: 0.4,
  currentLow: 95, currentHigh: 125, buy: 80, sell: 20, takerRatio: 12, oiChange: 2,
  highBreakout: event(1), lowBreakdown: { status: "none" }, highBreakout96: event(12), lowBreakdown96: { status: "none" },
  roc: 3, maroc: 2, rocChange: 50, marocChange: -10, rsi6: 62, rsi12: 58, rsi24: 54,
  logBBAboveBand: "middle", logBBExpansion: { hours: 2, complete: true },
  filterMetrics: { liveOpen: 105, liveClose: 110, ema200: 101, previousEMA200: 100, vwap14: 108, bbUpper: 120, bbMiddle: 100, bbLower: 80, priorHigh48: 120, priorHigh96: 130, priorLow48: 90, priorLow96: 85, oiUSD: 30_000_000, spreadPercent: 0.1, liveVolumeUSDT: 10_000 },
}
const patches: Partial<MarketRow>[] = [
  {}, { ema200Signal: "Unsure" }, { ema200Signal: null }, { takerRatio: null, oiChange: "Infinity" },
  { priceChange: null, roc: "-Infinity", rsi6: null, logBBExpansion: null },
  { rsi6: 50, rsi12: 55, rsi24: 57, roc: -1, logBBExpansion: { hours: 0, complete: true }, highBreakout: { status: "none" } },
  { rsi6: 86, rsi12: 76, rsi24: 69, logBBAboveBand: "upper", logBBExpansion: { hours: 8, complete: true } },
]
for (const rsi6 of [39.999, 40, 50, 58, 58.001, 60, 60.001, 70, 74.999, 75, 80]) patches.push({ rsi6 })
for (const rsi12 of [44.999, 45, 50, 65, 65.001, 69.999, 70]) patches.push({ rsi12 })
for (const rsi24 of [50, 50.001]) patches.push({ rsi24 })
for (const hours of [0, 1, 3, 4, 5, 6, 9]) for (const complete of [true, false]) patches.push({ logBBExpansion: { hours, complete } })
for (const age of [0, 3, 4, 12, 13, 47]) patches.push({ highBreakout: event(age) })
for (const status of ["loading", "insufficient-history", "none"] as const) patches.push({ highBreakout: { status } })
for (const band of ["below", "lower", "middle", "upper", null] as const) patches.push({ logBBAboveBand: band })
for (const field of ["priceChange", "roc", "maroc", "rocChange", "marocChange", "oiChange"] as const) for (const value of [null, "Infinity", "-Infinity", 0, -3] as const) patches.push({ [field]: value })
const variants = patches.map(patch => ({ ...base, ...patch }))
variants.push({ ...base, turnover24hUSDT: null, filterMetrics: Object.fromEntries(Object.keys(base.filterMetrics).map(key => [key, null])) as MarketRow["filterMetrics"] })
const mirrorBand = { upper: "below", middle: "lower", lower: "middle", below: "upper" } as const
const flip = (v: MarketRow["roc"]) => v === null ? null : v === "Infinity" ? "-Infinity" as const : v === "-Infinity" ? "Infinity" as const : -v
const mirrored = variants.map(row => ({ ...row, ema200Signal: row.ema200Signal === "Long" ? "Short" as const : row.ema200Signal,
  priceChange: flip(row.priceChange), roc: flip(row.roc), maroc: flip(row.maroc), rsi6: row.rsi6 === null ? null : 100 - row.rsi6, rsi12: row.rsi12 === null ? null : 100 - row.rsi12, rsi24: row.rsi24 === null ? null : 100 - row.rsi24, takerRatio: row.takerRatio === null ? null : -row.takerRatio,
  logBBAboveBand: row.logBBAboveBand === null ? null : mirrorBand[row.logBBAboveBand], highBreakout: row.lowBreakdown, lowBreakdown: row.highBreakout }))
const fixtures = [...variants, ...mirrored].map((input, id) => {
  const row = { ...input, opportunity: evaluateMarketOpportunity(input) }
  const readings = Object.fromEntries(Object.entries(FILTER_FIELDS).map(([key, field]) => [key, field.read(row)]))
  return { id, row, readings }
})
writeFileSync(new URL("../Tests/Fixtures/filter-compatibility.json", import.meta.url), JSON.stringify(fixtures, (_key, value) => typeof value === "number" && !Number.isFinite(value) ? value > 0 ? "Infinity" : "-Infinity" : value) + "\n")
process.stdout.write(`Generated ${fixtures.length} compatibility cases.\n`)
