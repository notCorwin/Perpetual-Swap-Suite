const DEFAULT_PERCENTILE_MINIMUM = 100
const DEFAULT_P99_MINIMUM = 1_000

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right)
  if (!ordered.length) return null
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)]
}

// Small samples are useful as maxima but make p95 unstable, so omit that
// statistic until there are enough independent observations.
export function summarizeLatencySamples(values, { minimumPercentileSamples = DEFAULT_PERCENTILE_MINIMUM, minimumP99Samples = DEFAULT_P99_MINIMUM } = {}) {
  if (!Array.isArray(values)) throw new TypeError('Latency samples must be an array.')
  if (!Number.isSafeInteger(minimumPercentileSamples) || minimumPercentileSamples < 1) throw new RangeError('The percentile sample minimum must be a positive integer.')
  if (!Number.isSafeInteger(minimumP99Samples) || minimumP99Samples < 1) throw new RangeError('The p99 sample minimum must be a positive integer.')
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`Latency sample ${index} must be a finite nonnegative number.`)
    }
  }
  const finite = values
  return {
    sampleCount: finite.length,
    p50MS: finite.length ? percentile(finite, .5) : null,
    p95MS: finite.length >= minimumPercentileSamples ? percentile(finite, .95) : null,
    p95SampleMinimum: minimumPercentileSamples,
    p99MS: finite.length >= minimumP99Samples ? percentile(finite, .99) : null,
    p99SampleMinimum: minimumP99Samples,
    maxMS: finite.length ? Math.max(...finite) : null,
  }
}

export function assertScrollResponsiveness(report, { inputBudgetMS = 100, frameBudgetMS = 100 } = {}) {
  const latency = summarizeLatencySamples(report.intentLatenciesMS)
  if (!latency.sampleCount || report.unaccountedInputs?.length) throw new Error('Scroll responsiveness needs every input intent accounted for.')
  if (latency.maxMS >= inputBudgetMS) throw new Error(`Scroll intent exceeded ${inputBudgetMS} ms: ${latency.maxMS} ms.`)
  if (!Number.isFinite(report.maxFrameGapMS) || report.maxFrameGapMS >= frameBudgetMS) {
    throw new Error(`A renderer RAF gap exceeded ${frameBudgetMS} ms: ${report.maxFrameGapMS} ms.`)
  }
}

// The seeded warm fixture promises numeric source values for every populated
// OI and Taker slot. This explicit contract catches missing data even if the
// renderer marks those fields unobserved, while empty oracle slots stay null.
export function assertWarmStatistics(actualBars, expectedBars) {
  const expectedByHour = new Map(expectedBars.map(bar => [bar.hour, bar]))
  for (const actual of actualBars) {
    const expected = expectedByHour.get(actual.hour)
    if (!expected) throw new Error(`Warm chart bar ${actual.hour} is absent from its fixture oracle.`)
    for (const [field, sourceBit, observedField] of [['oi', 1, 'oiObserved'], ['buy', 2, 'takerObserved'], ['sell', 2, 'takerObserved']]) {
      if (!Number.isFinite(expected[field])) {
        if (actual[field] !== null) throw new Error(`Warm chart ${actual.hour} ${field} must remain null when its fixture oracle is empty.`)
        continue
      }
      const observed = actual[observedField] ?? actual.statisticsObserved ?? Boolean((actual.statisticsSources ?? 0) & sourceBit)
      if (!observed || !Number.isFinite(actual[field])) throw new Error(`Warm chart ${actual.hour} ${field} is fixture-known but missing from the renderer snapshot.`)
      if (Math.abs(actual[field] - expected[field]) > Math.max(1, Math.abs(expected[field])) * 1e-10) {
        throw new Error(`Warm chart ${actual.hour} ${field} differs from its fixture oracle: expected ${expected[field]}, got ${actual[field]}.`)
      }
    }
  }
  return { bars: actualBars.length, oiValues: actualBars.filter(bar => Number.isFinite(bar.oi)).length,
    takerValues: actualBars.filter(bar => Number.isFinite(bar.buy) && Number.isFinite(bar.sell)).length }
}

// Every wheel intent must be backed by an exact committed target or accounted
// for by a later committed target. A coalesced intent is measured through the
// later commit so a stall in the middle of a gesture cannot vanish from the
// latency report.
export function accountChartIntents(intents, commits) {
  if (!Array.isArray(intents) || !Array.isArray(commits) || !intents.length) throw new TypeError('Chart intent accounting needs nonempty intents and commit arrays.')
  const hasIdentity = value => typeof value?.instId === 'string' && value.instId.length > 0
    && typeof value.timeframe === 'string' && value.timeframe.length > 0
  if (commits.some(commit => !commit || !hasIdentity(commit) || !Number.isFinite(commit.at) || !Number.isFinite(commit.end)
    || !(commit.rafSampledAt === null || Number.isFinite(commit.rafSampledAt) && commit.rafSampledAt >= commit.at))) {
    throw new TypeError('Every chart commit needs a finite target and ordered commit/RAF timestamps.')
  }
  if (intents.length !== intents.reduce((count, intent) => count + Number(hasIdentity(intent) && Number.isFinite(intent.at) && Number.isFinite(intent.target)), 0)) {
    throw new TypeError('Every chart intent needs a finite timestamp and target.')
  }

  const orderedCommits = [...commits].sort((left, right) => left.at - right.at || (left.rafSampledAt ?? Infinity) - (right.rafSampledAt ?? Infinity))
  const matched = intents.map(intent => orderedCommits.find(commit => commit.end === intent.target
    && commit.instId === intent.instId && commit.timeframe === intent.timeframe
    && commit.at >= intent.at && Number.isFinite(commit.rafSampledAt)))
  return intents.map((intent, index) => {
    const exact = matched[index]
    if (exact) return { index, target: intent.target, status: 'committed', commit: exact,
      latencyMS: exact.rafSampledAt - intent.at }

    const successorIndex = matched.findIndex((commit, candidate) => candidate > index && commit
      && intents[candidate].instId === intent.instId && intents[candidate].timeframe === intent.timeframe)
    if (successorIndex !== -1) {
      const commit = matched[successorIndex]
      return { index, target: intent.target, status: 'coalesced', supersededBy: successorIndex, commit,
        latencyMS: commit.rafSampledAt - intent.at }
    }
    return { index, target: intent.target, status: 'unaccounted', commit: null, latencyMS: null }
  })
}
