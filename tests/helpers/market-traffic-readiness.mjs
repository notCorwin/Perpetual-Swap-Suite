const truncate = (value, maximum = 400) => typeof value === 'string' ? value.slice(0, maximum) : value

function sourceStatus(status) {
  if (!status) return null
  return {
    state: status.state ?? null,
    from: status.from ?? null,
    through: status.through ?? null,
    reason: status.reason ?? null,
    retryAt: status.retryAt ?? null,
    retryOn: status.retryOn ?? null,
    error: truncate(status.error),
  }
}

function notReadyReasons(frame) {
  if (!frame.present) return ['no-resident-frame']
  const reasons = []
  if (frame.barCount !== 96) reasons.push(`bar-count-${frame.barCount ?? 0}-instead-of-96`)
  if (frame.indicatorState !== 'ready') reasons.push(`indicators-${frame.indicatorState ?? 'missing'}`)
  if (!['ready', 'stale'].includes(frame.priceState)) reasons.push(`price-${frame.priceState ?? 'missing'}`)
  if (!['ready', 'unavailable'].includes(frame.oiState)) reasons.push(`open-interest-${frame.oiState ?? 'missing'}`)
  if (!['ready', 'unavailable'].includes(frame.takerState)) reasons.push(`taker-volume-${frame.takerState ?? 'missing'}`)
  return reasons
}

/** Summarize one bounded chart-universe response without returning its bar arrays over IPC. */
export function inspectMarketTrafficReadiness(instIds, timeframe, frames) {
  const selected = new Map()
  for (const frame of frames ?? []) if (frame?.timeframe === timeframe && instIds.includes(frame.instId)) selected.set(frame.instId, frame)
  const terminalStates = instIds.map(instId => {
    const frame = selected.get(instId)
    if (!frame || frame.present === false) return { instId, timeframe, present: false, ready: false, notReadyReasons: ['no-resident-frame'] }
    const summary = {
      instId, timeframe, present: true, barCount: frame.barCount ?? 0,
      firstBarHour: frame.firstBarHour ?? null, lastBarHour: frame.lastBarHour ?? null,
      endHour: frame.endHour ?? null, latestEnd: frame.latestEnd ?? null, oldestHour: frame.oldestHour ?? null,
      historyExhausted: frame.historyExhausted ?? null, generation: frame.generation ?? null, revision: frame.revision ?? null,
      indicatorState: frame.indicatorState ?? null, indicatorStatus: sourceStatus(frame.indicatorStatus),
      priceState: frame.priceState ?? null, priceStatus: sourceStatus(frame.priceStatus),
      oiState: frame.oiState ?? null, oiStatus: sourceStatus(frame.oiStatus),
      takerState: frame.takerState ?? null, takerStatus: sourceStatus(frame.takerStatus),
      sourceVersions: frame.sourceVersions ?? null, error: truncate(frame.error),
    }
    summary.notReadyReasons = notReadyReasons(summary)
    summary.ready = summary.notReadyReasons.length === 0
    return summary
  })
  const readyIDs = terminalStates.filter(frame => frame.ready).map(frame => frame.instId).sort()
  return { readyIDs, missingIDs: terminalStates.filter(frame => !frame.ready).map(frame => frame.instId).sort(), terminalStates }
}
