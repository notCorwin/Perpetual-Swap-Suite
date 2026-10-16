import type { BreakResult } from "./market-breaks.ts"
import { logBBBandRank, type BandWidthExpansion, type LogBBAboveBand } from "./market-logbb.ts"
import { percentageNumber, type PercentageValue } from "./market-percent.ts"
import { opportunityStatusRank, type OpportunityResult } from "./market-opportunity.ts"

export type EMA200Signal = "Long" | "Short" | "Unsure"
export type SortKey = "opportunity" | "turnover24hUSDT" | "highBreakout" | "highBreakoutPriorAge" | "lowBreakdown" | "lowBreakdownPriorAge" | "takerRatio" | "oiChange" | "roc" | "maroc" | "rsi6" | "rsi12" | "rsi24" | "logBBAboveBand" | "logBBExpansion"

export type SortableRow = {
  instId: string
  turnover24hUSDT: number | null
  highBreakout: BreakResult
  lowBreakdown: BreakResult
  takerRatio: number | null
  oiChange: PercentageValue
  roc: PercentageValue
  maroc: PercentageValue
  rsi6: number | null
  rsi12: number | null
  rsi24: number | null
  logBBAboveBand: LogBBAboveBand | null
  logBBExpansion: BandWidthExpansion | null
  opportunity?: OpportunityResult
}

export function compareMarketTurnover(a: { instId: string; turnover24hUSDT: number | null }, b: { instId: string; turnover24hUSDT: number | null }): number {
  const left = a.turnover24hUSDT, right = b.turnover24hUSDT
  if (left === null || right === null) { if (left !== right) return left === null ? 1 : -1 }
  else if (left !== right) return right - left
  return a.instId.localeCompare(b.instId)
}

export function wrappedMarket(order: string[], index: number): string | undefined {
  return order.length ? order[((index % order.length) + order.length) % order.length] : undefined
}

export function chartNavigationTarget(listOrder: string[], turnoverOrder: string[], currentId: string, key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"): string | undefined {
  if (key === "ArrowLeft") return listOrder[0]
  if (key === "ArrowRight") return turnoverOrder[0]
  const index = listOrder.indexOf(currentId)
  if (index < 0) return key === "ArrowUp" ? listOrder[listOrder.length - 1] : listOrder[0]
  return wrappedMarket(listOrder, index + (key === "ArrowUp" ? -1 : 1))
}

export function defaultSortDescending(key: SortKey): boolean {
  return key !== "highBreakout" && key !== "lowBreakdown"
}

function sortValue(row: SortableRow, key: Exclude<SortKey, "opportunity">): number | null {
  switch (key) {
    case "highBreakout": return row.highBreakout.status === "event" ? row.highBreakout.hoursAgo : null
    case "lowBreakdown": return row.lowBreakdown.status === "event" ? row.lowBreakdown.hoursAgo : null
    case "highBreakoutPriorAge": return row.highBreakout.status === "event" ? row.highBreakout.priorAgeHours : null
    case "lowBreakdownPriorAge": return row.lowBreakdown.status === "event" ? row.lowBreakdown.priorAgeHours : null
    case "logBBAboveBand": return row.logBBAboveBand === null ? null : logBBBandRank[row.logBBAboveBand]
    case "logBBExpansion": return row.logBBExpansion?.hours ?? null
    case "oiChange":
    case "roc":
    case "maroc": return percentageNumber(row[key])
    default: return row[key]
  }
}

export function compareMarketRows(a: SortableRow, b: SortableRow, key: SortKey, descending: boolean): number {
  if (key === "opportunity") {
    const left = a.opportunity, right = b.opportunity
    const leftScore = left?.score ?? null, rightScore = right?.score ?? null
    const leftMissing = left == null || left.status === "Incomplete" || leftScore === null
    const rightMissing = right == null || right.status === "Incomplete" || rightScore === null
    if (leftMissing || rightMissing) {
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1
    } else {
      const difference = opportunityStatusRank[right.status] - opportunityStatusRank[left.status] || rightScore - leftScore
      if (difference) return descending ? difference : -difference
    }
    return compareMarketTurnover(a, b)
  }
  const left = sortValue(a, key)
  const right = sortValue(b, key)
  if (left === null || right === null) {
    if (left !== right) return left === null ? 1 : -1
  } else {
    const difference = descending ? right - left : left - right
    if (difference) return difference
  }
  return compareMarketTurnover(a, b)
}
