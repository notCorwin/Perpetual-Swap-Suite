import assert from 'node:assert/strict'
const crossProcessOriginToleranceMS = 2 // Epoch-origin precision across Node and Chromium monotonic clocks.

export function summarizeResourceDelivery(load, commits, { intents = [] } = {}) {
  assert.equal(load.state, 'complete', 'Fixed-rate intake must finish without failures or pending work.')
  assert.equal(load.emitted, load.plannedTicks, 'Every scheduled input must be emitted.')
  assert.equal(load.completed, load.plannedTicks, 'Every emitted input must settle.')
  assert.equal(load.failed, 0)
  assert.ok(load.ticks?.length === load.plannedTicks && load.ticks.every(row =>
    ['plannedAt', 'emittedAt', 'receivedAt', 'completedAt'].every(field => Number.isFinite(row[field]))
    && row.plannedAt <= row.emittedAt && row.emittedAt <= row.receivedAt && row.receivedAt <= row.completedAt),
  'Every input needs ordered scheduled, emitted, received and completed source timestamps on its monotonic clock.')
  assert.ok(intents.every((intent, index) => Number.isFinite(intent.at) && typeof intent.instId === 'string'
    && typeof intent.timeframe === 'string' && (!index || intent.at >= intents[index - 1].at)), 'Viewport intents must have ordered renderer timestamps and series identities.')
  const activeAt = at => intents.findLast(value => value.at <= at)
  const excluded = [], viewportOriginAmbiguities = []
  const deliveries = load.ticks.flatMap(tick => {
    const possibleIntents = [...new Set([activeAt(tick.receivedAt - crossProcessOriginToleranceMS),
      ...intents.filter(value => Math.abs(value.at - tick.receivedAt) <= crossProcessOriginToleranceMS)])]
    const possibleViews = new Set(possibleIntents.map(value => `${value?.instId ?? tick.instId}:${value?.timeframe ?? tick.timeframe}:${Boolean(value?.historical)}`))
    if (possibleViews.size > 1) viewportOriginAmbiguities.push({ sequence: tick.sequence,
      possibleViews: [...possibleViews] })
    // A historical viewport deliberately does not render forming prices.
    // Never exclude a clock-ambiguous transition that could still be live.
    if (possibleIntents.length && possibleIntents.every(value => value?.historical)) { excluded.push(tick.sequence); return [] }
    // Rendering may coalesce revisions, but the first subsequent revision still
    // has to acknowledge the earlier intent within the same latency budget.
    // Every synthetic tick updates the whole market. A selection may supersede
    // the old viewport before it draws; acknowledge the current visible series
    // using renderer-clock intent/commit comparisons, rather than demand an
    // obsolete chart whose selection the user has already replaced.
    const matchesView = (value, at) => {
      const intent = activeAt(at)
      return !intent?.historical && value.instId === (intent?.instId ?? tick.instId)
        && value.timeframe === (intent?.timeframe ?? tick.timeframe)
    }
    const commit = commits.find(value => matchesView(value, value.committedAt) && matchesView(value, value.nextFrameAt)
      && value.sequence >= tick.sequence && Number.isFinite(value.nextFrameAt) && value.nextFrameAt + crossProcessOriginToleranceMS >= tick.receivedAt)
    assert.ok(commit, `Scheduled update ${tick.sequence} never reached a renderer frame opportunity.`)
    assert.ok(Number.isFinite(commit.committedAt) && commit.committedAt + crossProcessOriginToleranceMS >= tick.receivedAt && commit.nextFrameAt >= commit.committedAt,
      'Renderer delivery must use valid, ordered receive/commit/RAF timestamps.')
    const receiveToCommitClockDeltaMS = commit.committedAt - tick.receivedAt
    const receiveToFrameClockDeltaMS = commit.nextFrameAt - tick.receivedAt
    return [{ sequence: tick.sequence, instId: commit.instId, timeframe: commit.timeframe,
      renderedSequence: commit.sequence, coalesced: commit.sequence !== tick.sequence,
      scheduleToCommitMS: commit.committedAt - tick.plannedAt, scheduleToFrameMS: commit.nextFrameAt - tick.plannedAt,
      receiveToCommitClockDeltaMS, receiveToFrameClockDeltaMS,
      receiveToCommitMS: Math.max(0, receiveToCommitClockDeltaMS), receiveToFrameMS: Math.max(0, receiveToFrameClockDeltaMS) }]
  })
  assert.ok(deliveries.length >= Math.max(2, Math.ceil(load.plannedTicks / 2)), 'At least half of the fixed-rate inputs must exercise visible live delivery.')
  const values = deliveries.map(value => value.scheduleToFrameMS).sort((a, b) => a - b)
  const summary = { count: values.length, crossProcessOriginToleranceMS, maxMS: values.at(-1), p50MS: values[Math.ceil(values.length * .5) - 1],
    p95MS: values.length >= 100 ? values[Math.ceil(values.length * .95) - 1] : null,
    p99MS: values.length >= 1000 ? values[Math.ceil(values.length * .99) - 1] : null,
    receiveToFrameMaxMS: Math.max(...deliveries.map(value => value.receiveToFrameMS)),
    coalesced: deliveries.filter(value => value.coalesced).length, historicalViewportInputs: excluded,
    viewportOriginAmbiguities, samples: deliveries }
  return summary
}

export function assertResourceDeliveryBudget(summary, budgetMS = 100) {
  if (budgetMS === null) return
  assert.ok(Number.isFinite(budgetMS) && budgetMS > 0, 'The renderer delivery budget must be a positive measurement.')
  assert.ok(Number.isFinite(summary.receiveToFrameMaxMS) && summary.receiveToFrameMaxMS <= budgetMS,
    `An accepted market input waited ${summary.receiveToFrameMaxMS.toFixed(2)} ms for a renderer frame opportunity (budget ${budgetMS} ms).`)
}

// Evaluate independent performance budgets together. A source scheduling miss
// must not discard valid renderer samples or hide a simultaneous frame stall.
export function assessResourceBudgets({ load, delivery, switches, frameCadence }, { offscreen = false } = {}) {
  const checks = [
    ['source-cadence', () => assert.ok(Number.isFinite(load.cadenceMS) && load.cadenceMS > 0
      && Number.isFinite(load.maxScheduleLatenessMS) && load.maxScheduleLatenessMS >= 0
      && load.maxScheduleLatenessMS <= load.cadenceMS,
    `The source scheduler fell behind by ${load.maxScheduleLatenessMS} ms (budget ${load.cadenceMS} ms).`)],
    ['receive-to-raf', () => assertResourceDeliveryBudget(delivery, offscreen ? null : 100)],
  ]
  if (!offscreen) checks.push(
    ['prepared-selection', () => assert.ok(Array.isArray(switches) && switches.length > 0
      && switches.every(value => Number.isFinite(value.rowClickToFrameMS) && value.rowClickToFrameMS >= 0 && value.rowClickToFrameMS <= 100),
    'A prepared contract selection exceeded the 100 ms row-click-to-RAF budget or has no valid measurement.')],
    ['raf-gap', () => assert.ok(Number.isFinite(frameCadence?.maxMS) && frameCadence.maxMS >= 0 && frameCadence.maxMS < 100,
      `The renderer RAF gap was ${frameCadence?.maxMS} ms (budget <100 ms).`)],
    ['raf-p95', () => assert.ok(Number.isFinite(frameCadence?.p95MS) && frameCadence.p95MS >= 0 && frameCadence.p95MS <= 50,
      `The renderer RAF p95 was ${frameCadence?.p95MS} ms (budget 50 ms).`)],
  )
  return checks.flatMap(([gate, check]) => {
    try { check(); return [] }
    catch (error) { return [{ gate, message: error.message }] }
  })
}
