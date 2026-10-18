const unchangedFields = ['generation', 'endHour', 'latestEnd', 'oldestHour', 'historyExhausted', 'oiState', 'takerState', 'indicatorState', 'error', 'unavailable']

/** Compress only updates whose completed source frame the renderer can identify. */
export class ChartNotificationEncoder {
  constructor(maxFrames = 16) {
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) throw new TypeError('maxFrames must be a positive safe integer.')
    this.maxFrames = maxFrames
    this.frames = new Map()
  }

  get size() { return this.frames.size }

  encode(frame) {
    const key = `${frame.instId}:${frame.timeframe}:${frame.endHour}`, previous = this.frames.get(key)
    // A forming-only frame has no completed boundary. The renderer normalizes
    // that boundary from its live candle, so its next update must stay complete.
    const liveOnly = Number.isSafeInteger(frame.endHour) && previous && previous.bars === frame.bars
      && unchangedFields.every(field => previous[field] === frame[field])
    this.frames.delete(key)
    this.frames.set(key, frame)
    while (this.frames.size > this.maxFrames) this.frames.delete(this.frames.keys().next().value)
    return liveOnly ? { type: 'live', instId: frame.instId, timeframe: frame.timeframe,
      generation: frame.generation, revision: frame.revision, endHour: frame.endHour,
      liveBar: frame.liveBar ?? null, priceObservedAt: frame.priceObservedAt, priceAsOf: frame.priceAsOf,
      realtimeState: frame.realtimeState, priceState: frame.priceState, sourceVersions: frame.sourceVersions } : frame
  }
}
