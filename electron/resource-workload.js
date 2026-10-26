/** Fixed-rate synthetic intake. Scheduling never waits for a renderer or tick. */
export function startResourceWorkload({ ticks = 60, cadenceMS = 500, firstSequence = 1, tick,
  now = () => performance.now(), epoch: configuredEpoch, schedule = setTimeout, unschedule = clearTimeout } = {}) {
  if (!Number.isSafeInteger(ticks) || ticks < 2 || ticks > 1200
    || !Number.isSafeInteger(cadenceMS) || cadenceMS < 20 || cadenceMS > 2000
    || !Number.isSafeInteger(firstSequence) || firstSequence < 1 || typeof tick !== 'function') {
    throw new Error('Invalid fixed-rate resource workload.')
  }
  const origin = now(), epoch = configuredEpoch ?? performance.timeOrigin + origin, records = [], pending = new Set()
  let timer, cancelled = false, emitted = 0, completed = 0, maxPending = 0, failed = 0, maxScheduleLatenessMS = 0
  const snapshot = ({ includeTicks = false } = {}) => ({
    state: cancelled ? 'cancelled' : emitted < ticks ? 'emitting' : pending.size ? 'draining' : failed ? 'failed' : 'complete',
    plannedTicks: ticks, cadenceMS, firstSequence, startedAt: epoch,
    plannedDurationMS: (ticks - 1) * cadenceMS, elapsedMS: now() - origin,
    emitted, completed, pending: pending.size, maxPending, failed,
    maxScheduleLatenessMS,
    ...(includeTicks ? { ticks: records.map(record => ({ ...record })) } : {}),
  })
  const emit = () => {
    if (cancelled) return
    const plannedMS = emitted * cadenceMS, emittedMS = now() - origin
    if (emittedMS < plannedMS) {
      timer = schedule(emit, Math.ceil(plannedMS - emittedMS))
      return
    }
    const index = emitted++
    const record = { sequence: firstSequence + index, plannedAt: epoch + plannedMS,
      emittedAt: epoch + emittedMS, scheduleLatenessMS: Math.max(0, emittedMS - plannedMS), completedAt: null }
    maxScheduleLatenessMS = Math.max(maxScheduleLatenessMS, record.scheduleLatenessMS)
    records.push(record)
    const task = Promise.resolve().then(() => tick({ sequence: record.sequence })).then(result => {
      Object.assign(record, result, { completedAt: epoch + now() - origin })
    }, error => { failed++; record.error = error?.message ?? String(error) })
      .finally(() => { completed++; pending.delete(task) })
    pending.add(task); maxPending = Math.max(maxPending, pending.size)
    if (emitted < ticks) timer = schedule(emit, Math.max(0, origin + emitted * cadenceMS - now()))
  }
  timer = schedule(emit, 0)
  return { snapshot, cancel() { cancelled = true; unschedule(timer); return snapshot({ includeTicks: true }) } }
}
