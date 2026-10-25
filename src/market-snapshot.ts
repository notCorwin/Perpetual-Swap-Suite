import type { RankedMarketRow } from './desktop-contract.ts'

/** Price-only snapshots do not change navigation or virtual-list geometry. */
export function reconcileMarketOrder(previous: string[], incoming: string[]): string[] {
  return previous.length === incoming.length && incoming.every((id, index) => id === previous[index]) ? previous : incoming
}

// Bridge replies contain fresh objects, even when the native cache is unchanged.
// Preserve row identities so typing and menu state do not redraw every contract.
export function reconcileMarketRows(previous: RankedMarketRow[], incoming: RankedMarketRow[]): RankedMarketRow[] {
  const byID = new Map(previous.map(row => [row.instId, row]))
  const next = incoming.map(row => {
    const old = byID.get(row.instId)
    return old && old.lastPrice === row.lastPrice && old.turnover24hUSDT === row.turnover24hUSDT
      && old.rankingChange === row.rankingChange && old.rankingAsOf === row.rankingAsOf ? old : row
  })
  return previous.length === next.length && next.every((row, index) => row === previous[index]) ? previous : next
}
