const unchangedFields = ['generation', 'endHour', 'latestEnd', 'oldestHour', 'historyExhausted', 'oiState', 'takerState', 'oiStatus', 'takerStatus', 'priceStatus', 'indicatorState', 'indicatorStatus', 'error', 'unavailable']

/** Compress only updates whose completed source frame the renderer can identify. */
export class ChartNotificationEncoder {
  #frames = new WeakMap()

  encode(frame) {
    // The renderer accepts compact updates only for its current completed
    // boundary. Forming-only and historical frames always remain complete.
    if (!Number.isSafeInteger(frame.endHour) || frame.endHour !== frame.latestEnd) return frame
    const previous = this.#frames.get(frame.bars)
    const liveOnly = previous
      && previous.instId === frame.instId && previous.timeframe === frame.timeframe && previous.bars === frame.bars
      && unchangedFields.every(field => previous[field] === frame[field])
    this.#frames.set(frame.bars, frame)
    return liveOnly ? { type: 'live', instId: frame.instId, timeframe: frame.timeframe,
      generation: frame.generation, revision: frame.revision, endHour: frame.endHour,
      liveBar: frame.liveBar ?? null, priceObservedAt: frame.priceObservedAt, priceAsOf: frame.priceAsOf,
      realtimeState: frame.realtimeState, priceState: frame.priceState, sourceVersions: frame.sourceVersions } : frame
  }
}
