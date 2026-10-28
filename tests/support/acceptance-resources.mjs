// Each owned resource must be finalized even when an earlier finalizer fails.
export async function finishAcceptanceResources(finalizers) {
  const failures = []
  for (const finalize of finalizers) {
    try { await finalize?.() } catch (error) { failures.push(error) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures,
    failures.map(error => error?.message ?? String(error)).join('\n'), { cause: failures[0] })
}
