import { createHash } from 'node:crypto'

export const marketTrafficClock = 'process.hrtime.bigint() converted to integer microseconds; same-host Node monotonic clock'

export function monotonicMicroseconds() {
  return Number(process.hrtime.bigint() / 1_000n)
}

export function validateMarketTrafficDrainWindow(input, nowUS = monotonicMicroseconds()) {
  const { sampleStartedMonotonicUS: start, sampleEndedMonotonicUS: end, drainDeadlineMonotonicUS: deadline } = input
  if (![start, end, deadline, nowUS].every(value => Number.isSafeInteger(value) && value >= 0)
    || end <= start || end > nowUS || deadline < start) {
    throw new Error('Market traffic capture requires an ordered, completed monotonic sample window.')
  }
  // The fixture and CLI accept cadence values of at most 2,000 ms. Validate
  // before waiting, even when the caller supplies a malformed future deadline.
  if (deadline > end + 2_000_000) throw new Error('Market traffic drain exceeds the maximum 2000 ms fixture cadence.')
}

const text = value => value == null ? '' : String(value)
const numeric = value => {
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function normalizeCandle(payload) {
  if (Array.isArray(payload)) return {
    timestamp: numeric(payload[0]), open: numeric(payload[1]), high: numeric(payload[2]), low: numeric(payload[3]),
    close: numeric(payload[4]), volume: numeric(payload[5]), baseVolume: numeric(payload[6]), quoteVolume: numeric(payload[7]),
    confirmed: payload[8] === '1' || payload[8] === 1 || payload[8] === true,
  }
  return {
    timestamp: numeric(payload?.timestamp), open: numeric(payload?.open), high: numeric(payload?.high), low: numeric(payload?.low),
    close: numeric(payload?.close), volume: numeric(payload?.volume), baseVolume: numeric(payload?.baseVolume),
    quoteVolume: numeric(payload?.quoteVolume), confirmed: payload?.confirmed === true,
  }
}

/**
 * Build a stable identity from fields already present in OKX data. This is
 * called only while the loopback traffic observer is armed; normal live
 * messages are neither hashed nor retained.
 */
export function marketTrafficPayloadIdentity(channel, instId, payload) {
  if (typeof channel !== 'string' || typeof instId !== 'string' || !payload) return null
  let identityFields, normalized
  if (channel === 'tickers') {
    identityFields = [text(payload.ts), text(payload.last), text(payload.bidPx), text(payload.askPx)]
    normalized = Object.fromEntries(['ts', 'last', 'bidPx', 'askPx', 'open24h', 'high24h', 'low24h', 'volCcy24h', 'vol24h']
      .map(key => [key, text(payload[key])]))
  } else if (channel === 'open-interest') {
    identityFields = [text(payload.ts), text(payload.oi), text(payload.oiUsd)]
    normalized = Object.fromEntries(['ts', 'oi', 'oiUsd'].map(key => [key, text(payload[key])]))
  } else if (channel === 'books') {
    const bids = Array.isArray(payload.bids) ? payload.bids.map(level => Array.isArray(level) ? level.slice(0, 4).map(text) : []) : []
    const asks = Array.isArray(payload.asks) ? payload.asks.map(level => Array.isArray(level) ? level.slice(0, 4).map(text) : []) : []
    identityFields = [text(payload.seqId), text(payload.ts)]
    normalized = { seqId: numeric(payload.seqId), ts: text(payload.ts), bids, asks }
  } else if (channel === 'trades') {
    identityFields = [text(payload.tradeId)]
    normalized = Object.fromEntries(['tradeId', 'ts', 'side', 'sz', 'px', 'count']
      .map(key => [key, text(payload[key])]))
  } else if (/^candle(?:5m|15m|1H)$/.test(channel)) {
    normalized = normalizeCandle(payload)
    identityFields = [text(normalized.timestamp), text(normalized.confirmed), text(normalized.close), text(normalized.volume)]
  } else return null

  const identity = JSON.stringify([channel, instId, ...identityFields])
  const payloadFingerprint = createHash('sha256').update(JSON.stringify([channel, instId, normalized])).digest('hex')
  return { channel, instId, identity, payloadFingerprint }
}

let nextCallbackID = 0
let callbackProbeObserverCostMonotonicUS = 0

export function drainCallbackProbeObserverCostMonotonicUS() {
  const cost = callbackProbeObserverCostMonotonicUS
  callbackProbeObserverCostMonotonicUS = 0
  return cost
}

/**
 * Observe callback entry and fulfillment without changing callback return,
 * receiver, rejection, or synchronous-throw behavior. Entry and acceptance
 * have separate timestamps so async completion cannot borrow receive time.
 */
export function wrapAcceptedCallback(options, name, observe, restorers) {
  if (!options || typeof options[name] !== 'function') {
    throw new Error(`Application realtime callback ${name} is unavailable.`)
  }
  if (typeof observe !== 'function' || !Array.isArray(restorers)) throw new TypeError('Callback probe requires an observer and restorers.')
  const original = options[name]
  const wrapped = function (...args) {
    const callbackID = ++nextCallbackID
    const entryProbeStartedAtMonotonicUS = monotonicMicroseconds()
    const callbackEnteredAtMonotonicUS = monotonicMicroseconds()
    observe(args, { phase: 'entry', callbackID, callbackEnteredAtMonotonicUS })
    callbackProbeObserverCostMonotonicUS += monotonicMicroseconds() - entryProbeStartedAtMonotonicUS
    const result = original.apply(this, args)
    const then = result !== null && (typeof result === 'object' || typeof result === 'function') ? result.then : null
    const accepted = value => {
      const acceptanceProbeStartedAtMonotonicUS = monotonicMicroseconds()
      const callbackAcceptedAtMonotonicUS = monotonicMicroseconds()
      observe(args, { phase: 'accepted', callbackID, callbackEnteredAtMonotonicUS,
        callbackAcceptedAtMonotonicUS })
      callbackProbeObserverCostMonotonicUS += monotonicMicroseconds() - acceptanceProbeStartedAtMonotonicUS
      return value
    }
    if (typeof then === 'function') return then.call(result, accepted)
    return accepted(result)
  }
  options[name] = wrapped
  restorers.push(() => { if (options[name] === wrapped) options[name] = original })
  return wrapped
}
