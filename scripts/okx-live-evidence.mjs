const time = value => Number.isFinite(value) && value > 0
const matching = (arg, instId, channel) => arg?.instId === instId && arg.channel === channel
const business = connection => { try { return new URL(connection.url).pathname === '/ws/v5/business' } catch { return false } }

/** Local scope/cap violations invalidate the check even after successful market
 * assertions. Recovered upstream failures do not establish a local defect. */
export function chartOutcomeWithRelayErrors(outcome, source) {
  const errors = source?.errors ?? []
  const violation = errors.find(value => value.kind === 'app-scope-escape') ?? errors.find(value => value.kind === 'harness-bound')
  if (!violation) return outcome
  return { ...outcome, classification: violation.kind === 'app-scope-escape' ? 'app-failure' : 'harness-failure',
    localRelayFailure: violation, error: outcome.error ?? { name: 'RelayLocalViolation', message: violation.message } }
}

/** Absence of a witness cannot establish an external outage on its own. */
export function missingCandleEvidence(source, { instId, channel = 'candle5m', sinceOrder } = {}) {
  const connection = (source?.connections ?? []).filter(business).at(-1)
  const result = (classification, reason, evidence = {}) => ({ classification, reason, instId, channel, ...evidence })
  if (!connection) return result('app-failure', 'No native business connection was established for the requested candle.')
  const failureOrder = connection.errorOrder ?? connection.closedOrder
  const requestedClose = Number.isSafeInteger(connection.closeRequestedOrder)
    && (!Number.isSafeInteger(failureOrder) || connection.closeRequestedOrder < failureOrder)
  const upstreamFailed = !requestedClose && Number.isSafeInteger(failureOrder)
  const command = (connection.commands ?? []).filter(value => value.args?.some(arg => matching(arg, instId, channel))).at(-1)
  if (!command || command.op !== 'subscribe') return result(upstreamFailed ? 'integration-failed' : 'app-failure',
    'The current native connection has no exact candle subscription; an unrelated upstream failure cannot establish that admission.')
  // A connection may independently fail before the command leaves its native
  // queue, before its ACK, or just before the observation gate. Keep that actual
  // outage evidence separate from proof of a currently active subscription.
  if (upstreamFailed) return result('external-unavailable', 'The exact app subscription attempt encountered an independently failed native upstream connection.',
    { connectionStartedAt: connection.startedAt, commandReceivedAt: command.receivedAt, commandForwardedAt: command.forwardedAt,
      nativeFailureOrder: failureOrder })
  if (Number.isSafeInteger(connection.closedOrder) && connection.closedOrder <= sinceOrder) return result('app-failure', 'An older closed connection cannot attest the current app candle subscription.')
  if (!time(command.forwardedAt)) return result('integration-failed', 'The exact candle subscription was not independently observed reaching upstream OKX.')
  const acknowledgment = (connection.acknowledgements ?? []).find(value => value.event === 'subscribe'
    && matching(value.arg, instId, channel) && time(value.forwardedAt) && value.receivedOrder > command.forwardedOrder
    && (command.id === undefined || value.id === command.id))
  if (!acknowledgment) return result('integration-failed', 'The exact native OKX subscription acknowledgment was not forwarded to the app.')
  const evidence = { connectionStartedAt: connection.startedAt, commandForwardedAt: command.forwardedAt,
    acknowledgmentForwardedAt: acknowledgment.forwardedAt }
  return result('integration-failed', 'The acknowledged native source produced no eligible witness; no independent external failure was demonstrated.', evidence)
}

/** Market-row admission with disabled liquidity filters needs catalog and ticker
 * inputs, not a different contract's chart history. Consider the newest attempt
 * for each required input, and never treat an in-flight attempt as a failure. */
export function requiredMarketInputFailures(source, { instId, sinceOrder = 0 } = {}) {
  const latest = new Map()
  for (const request of source?.requests ?? []) {
    let url
    try { url = new URL(request.path, 'http://127.0.0.1') } catch { continue }
    const id = url.searchParams.get('instId')
    if (id && id !== instId) continue
    const kind = url.pathname === '/api/v5/public/instruments' ? 'instruments'
      : ['/api/v5/market/tickers', '/api/v5/market/ticker'].includes(url.pathname) ? 'tickers' : null
    if (kind && Number.isSafeInteger(request.startedOrder) && request.startedOrder >= sinceOrder) latest.set(kind, request)
  }
  return [...latest].flatMap(([kind, request]) => {
    if (!time(request.endedAt) || !request.error && request.status >= 200 && request.status < 300 && request.code === '0') return []
    // A native input delivered after the failed HTTP attempt is independent
    // recovery evidence for this exact contract and input family.
    if ((source.inputs ?? []).some(value => value.kind === kind && value.instId === instId
      && time(value.forwardedAt) && value.forwardedOrder > request.endedOrder)) return []
    return [{ kind, path: request.path, startedAt: request.startedAt, endedAt: request.endedAt,
      status: request.status, code: request.code, error: request.error }]
  })
}
