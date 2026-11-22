/** Absolute signed change descending, unavailable values last, then fixed ID. */
export function compareRanking(left, right) {
  const leftKnown = typeof left.rankingChange === 'number' && Number.isFinite(left.rankingChange)
  const rightKnown = typeof right.rankingChange === 'number' && Number.isFinite(right.rankingChange)
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
  if (leftKnown) {
    const difference = Math.abs(right.rankingChange) - Math.abs(left.rankingChange)
    if (difference !== 0) return difference
  }
  return left.instId < right.instId ? -1 : left.instId > right.instId ? 1 : 0
}
