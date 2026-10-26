import assert from 'node:assert/strict'
const sourceTimestampToleranceMS = 2 // Date.now() receipt vs epoch-aligned monotonic scheduler precision.

export function summarizeResourceDelivery(load, commits, { intents = [] } = {}) {
  assert.equal(load.state, 'complete', 'Fixed-rate intake must finish without failures or pending work.')
  assert.equal(load.emitted, load.plannedTicks, 'Every scheduled input must be emitted.')
  assert.equal(load.completed, load.plannedTicks, 'Every emitted input must settle.')
  assert.equal(load.failed, 0)
  assert.ok(Number.isFinite(load.maxScheduleLatenessMS) && load.maxScheduleLatenessMS <= load.cadenceMS,
    'The source scheduler must not fall behind by a complete input interval.')
  assert.ok(load.ticks?.length === load.plannedTicks && load.ticks.every(row =>
    ['plannedAt', 'emittedAt', 'receivedAt', 'completedAt'].every(field => Number.isFinite(row[field]))
    && row.plannedAt <= row.emittedAt + sourceTimestampToleranceMS
    && row.emittedAt <= row.receivedAt + sourceTimestampToleranceMS
    && row.receivedAt <= row.completedAt + sourceTimestampToleranceMS),
  'Every input needs ordered scheduled, emitted, received and completed source timestamps (2 ms clock precision tolerance).')
  const excluded = []
  const deliveries = load.ticks.flatMap(tick => {
    const intent = intents.findLast(value => value.at <= tick.receivedAt)
    // A historical viewport deliberately does not render forming prices.
    if (intent?.historical) { excluded.push(tick.sequence); return [] }
    // Rendering may coalesce revisions, but the first subsequent revision still
    // has to acknowledge the earlier intent within the same latency budget.
    const commit = commits.find(value => value.instId === (intent?.instId ?? tick.instId) && value.timeframe === (intent?.timeframe ?? tick.timeframe)
      && value.sequence >= tick.sequence && Number.isFinite(value.nextFrameAt) && value.nextFrameAt >= tick.receivedAt)
    assert.ok(commit, `Scheduled update ${tick.sequence} never reached a renderer frame opportunity.`)
    assert.ok(Number.isFinite(commit.committedAt) && commit.committedAt >= tick.receivedAt && commit.nextFrameAt >= commit.committedAt,
      'Renderer delivery must use valid, ordered receive/commit/RAF timestamps.')
    return [{ sequence: tick.sequence, renderedSequence: commit.sequence, coalesced: commit.sequence !== tick.sequence,
      scheduleToCommitMS: commit.committedAt - tick.plannedAt, scheduleToFrameMS: commit.nextFrameAt - tick.plannedAt,
      receiveToCommitMS: commit.committedAt - tick.receivedAt, receiveToFrameMS: commit.nextFrameAt - tick.receivedAt }]
  })
  assert.ok(deliveries.length >= Math.max(2, Math.ceil(load.plannedTicks / 2)), 'At least half of the fixed-rate inputs must exercise visible live delivery.')
  const values = deliveries.map(value => value.scheduleToFrameMS).sort((a, b) => a - b)
  const summary = { count: values.length, sourceTimestampToleranceMS, maxMS: values.at(-1), p50MS: values[Math.ceil(values.length * .5) - 1],
    p95MS: values.length >= 100 ? values[Math.ceil(values.length * .95) - 1] : null,
    p99MS: values.length >= 1000 ? values[Math.ceil(values.length * .99) - 1] : null,
    receiveToFrameMaxMS: Math.max(...deliveries.map(value => value.receiveToFrameMS)),
    coalesced: deliveries.filter(value => value.coalesced).length, historicalViewportInputs: excluded, samples: deliveries }
  return summary
}

export function assertResourceDeliveryBudget(summary, budgetMS = 100) {
  if (budgetMS === null) return
  assert.ok(Number.isFinite(budgetMS) && budgetMS > 0, 'The renderer delivery budget must be a positive measurement.')
  assert.ok(Number.isFinite(summary.receiveToFrameMaxMS) && summary.receiveToFrameMaxMS <= budgetMS,
    `An accepted market input waited ${summary.receiveToFrameMaxMS.toFixed(2)} ms for a renderer frame opportunity (budget ${budgetMS} ms).`)
}
