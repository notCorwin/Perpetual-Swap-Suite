const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null

export const signedRelativeChange = (current, previous) => {
  const next = finite(current), prior = finite(previous)
  if (next === null || prior === null || prior === 0) return null
  const difference = next - prior
  const change = (Number.isFinite(difference) ? difference / Math.abs(prior) : next / Math.abs(prior) - Math.sign(prior)) * 100
  return Number.isFinite(change) ? change : null
}
