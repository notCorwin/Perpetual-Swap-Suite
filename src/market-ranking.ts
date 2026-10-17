export function compareRankingChange(a: { instId: string; rankingChange: number | null }, b: { instId: string; rankingChange: number | null }): number {
  const left = Number.isFinite(a.rankingChange) ? a.rankingChange : null
  const right = Number.isFinite(b.rankingChange) ? b.rankingChange : null
  if (left === null || right === null) return left === right ? a.instId.localeCompare(b.instId, 'en') : left === null ? 1 : -1
  return Math.abs(right) - Math.abs(left) || a.instId.localeCompare(b.instId, 'en')
}
