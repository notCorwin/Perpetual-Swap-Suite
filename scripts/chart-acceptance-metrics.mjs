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

// Run independent checks even when one fails, so functional and performance
// failures remain visible together in the acceptance evidence.
export function collectAcceptanceChecks(checks) {
  const results = [], failures = []
  for (const [name, check] of checks) {
    try { check(); results.push({ name, passed: true }) }
    catch (error) {
      results.push({ name, passed: false, message: error?.message ?? String(error) })
      failures.push(error)
    }
  }
  return { results, failures }
}

function throwFailures(failures) {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, failures.map(error => error?.message ?? String(error)).join('\n'))
}

export function assertScrollResponsiveness(report, { inputBudgetMS = 100, frameBudgetMS = 100 } = {}) {
  let latency
  const { failures } = collectAcceptanceChecks([
    ['input accounting', () => {
      latency = summarizeLatencySamples(report.intentLatenciesMS)
      if (!latency.sampleCount || report.unaccountedInputs?.length) throw new Error('Scroll responsiveness needs every input intent accounted for.')
    }],
    ['input latency', () => {
      if (latency?.maxMS >= inputBudgetMS) throw new Error(`Scroll intent exceeded ${inputBudgetMS} ms: ${latency.maxMS} ms.`)
    }],
    ['renderer RAF gap', () => {
      if (!Number.isFinite(report.maxFrameGapMS) || report.maxFrameGapMS >= frameBudgetMS) {
        throw new Error(`A renderer RAF gap exceeded ${frameBudgetMS} ms: ${report.maxFrameGapMS} ms.`)
      }
    }],
  ])
  throwFailures(failures)
}

export function assertNavigationResponsiveness(report, { presentation, rapid = false, requireLocal = false }) {
  if (!['foreground', 'offscreen'].includes(presentation)) throw new TypeError('Navigation timing requires a declared presentation.')
  const maximumMS = rapid ? 100 : 50
  const { failures } = collectAcceptanceChecks([
    ...(!requireLocal ? [['renderer frames', () => {
      if (!Number.isSafeInteger(report.framesToCommit) || report.framesToCommit < 0 || report.framesToCommit > 1) {
        throw new Error(`${report.instId} needed ${report.framesToCommit} animation frames to switch.`)
      }
    }]] : []),
    ...(presentation === 'foreground' && !requireLocal ? [['prepared input latency', () => {
      if (!Number.isFinite(report.inputToSVGCommitMS) || report.inputToSVGCommitMS < 0 || report.inputToSVGCommitMS > maximumMS) {
        throw new Error(`${report.instId} blocked input for ${report.inputToSVGCommitMS} ms (native foreground budget ${maximumMS} ms).`)
      }
    }]] : []),
    ...(requireLocal ? [['cold selection acknowledgment', () => {
      if (!Number.isFinite(report.inputToSelectionAcknowledgedMS) || report.inputToSelectionAcknowledgedMS < 0) {
        throw new Error('A cold selection must acknowledge the requested contract before its data arrives.')
      }
      if (presentation === 'foreground' && report.inputToSelectionAcknowledgedMS > 100) {
        throw new Error('Cold selection acknowledgment exceeded 100 ms.')
      }
    }]] : []),
  ])
  throwFailures(failures)
}

// Renderer timestamps are performance.now() offsets; fixture timestamps use
// the source worker's performance.timeOrigin + performance.now(). Convert
// the renderer offsets to the same epoch before comparing the two domains.
export function coldBoundaryTiming({ rendererTimeOrigin, approachInputAt, finalInputAt, firstTargetRAFAt, readyTargetRAFAt,
  nearestStartedAt, nearestCompletedAt, preparedTargetAt }) {
  const timestamps = { rendererTimeOrigin, approachInputAt, finalInputAt, firstTargetRAFAt, readyTargetRAFAt,
    nearestStartedAt, nearestCompletedAt, preparedTargetAt }
  for (const [name, value] of Object.entries(timestamps)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a finite nonnegative timestamp.`)
  }
  if (nearestStartedAt > nearestCompletedAt || nearestCompletedAt > preparedTargetAt
    || approachInputAt > finalInputAt || finalInputAt > firstTargetRAFAt || firstTargetRAFAt > readyTargetRAFAt) {
    throw new RangeError('Cold-boundary timestamps are out of order within a clock domain.')
  }
  const approachInputEpoch = rendererTimeOrigin + approachInputAt, finalInputEpoch = rendererTimeOrigin + finalInputAt
  const firstTargetRAFEpoch = rendererTimeOrigin + firstTargetRAFAt, readyTargetRAFEpoch = rendererTimeOrigin + readyTargetRAFAt
  if (![approachInputEpoch, finalInputEpoch, firstTargetRAFEpoch, readyTargetRAFEpoch].every(Number.isFinite)
    || readyTargetRAFEpoch < nearestCompletedAt) throw new RangeError('Cold-boundary renderer and source timestamps are inconsistent.')
  return {
    clocks: { renderer: 'performance.now() offsets plus renderer performance.timeOrigin', source: 'worker performance.timeOrigin plus performance.now()' },
    timestamps: { ...timestamps, approachInputEpoch, finalInputEpoch, firstTargetRAFEpoch, readyTargetRAFEpoch },
    dataInputOrder: nearestCompletedAt < finalInputEpoch ? 'data-before-input' : nearestCompletedAt > finalInputEpoch ? 'input-before-data' : 'simultaneous',
    preInputLeadMS: finalInputEpoch - nearestCompletedAt,
    rawPageToFirstRAFMS: firstTargetRAFEpoch - nearestCompletedAt,
    rawPageToReadyRAFMS: readyTargetRAFEpoch - nearestCompletedAt,
    inputToFirstRAFMS: firstTargetRAFAt - finalInputAt,
    inputToReadyRAFMS: readyTargetRAFAt - finalInputAt,
    readyAfterPrerequisitesMS: readyTargetRAFEpoch - Math.max(nearestCompletedAt, finalInputEpoch),
    preparedAfterSourceMS: preparedTargetAt - nearestCompletedAt,
    preparedBeforeFinalInput: preparedTargetAt <= finalInputEpoch,
  }
}

export function assertColdBoundaryTiming(timing) {
  const { failures } = collectAcceptanceChecks([
    ['ready RAF budget', () => {
      if (!Number.isFinite(timing?.readyAfterPrerequisitesMS) || timing.readyAfterPrerequisitesMS < 0
        || timing.readyAfterPrerequisitesMS >= 1_000) throw new Error(`Cold ready RAF exceeded the 1000 ms post-prerequisite budget: ${timing?.readyAfterPrerequisitesMS} ms.`)
    }],
    ['source-to-prepared budget', () => {
      if (!Number.isFinite(timing?.preparedAfterSourceMS) || timing.preparedAfterSourceMS < 0
        || timing.preparedAfterSourceMS >= 1_000) throw new Error(`Cold prefetch preparation exceeded the 1000 ms source-to-prepared budget: ${timing?.preparedAfterSourceMS} ms.`)
    }],
    ['passive preparation', () => {
      if (!timing?.preparedBeforeFinalInput) throw new Error('No passive prepared-target history publication was observed before the final input; prefetch readiness cannot be established independently of demand.')
    }],
  ])
  throwFailures(failures)
}

export function assertColdBoundaryResponsiveness({ approachAcknowledgment, finalLatency, readyTargetInputToRAFMS, sourcePhaseRAF, targetPhaseRAF }) {
  const { failures } = collectAcceptanceChecks([
    ['approach milestone', () => {
      if (approachAcknowledgment?.milestone !== 'requested-cursor') throw new Error('The cold approach must measure the requested-cursor RAF acknowledgment.')
    }],
    ['approach acknowledgment', () => assertScrollResponsiveness(approachAcknowledgment)],
    ['final milestone', () => {
      if (finalLatency?.milestone !== 'rendered-window') throw new Error('The prepared boundary target must measure the rendered-window RAF.')
    }],
    ['final rendered target', () => assertScrollResponsiveness(finalLatency)],
    ['final maximum', () => {
      if (!Number.isFinite(finalLatency?.maxInputToRafSampleMS) || finalLatency.maxInputToRafSampleMS >= 100) {
        throw new Error(`A boundary intent took ${finalLatency?.maxInputToRafSampleMS} ms to reach its exact or coalesced chart target.`)
      }
    }],
    ['prepared target ready RAF', () => {
      if (!Number.isFinite(readyTargetInputToRAFMS) || readyTargetInputToRAFMS < 0 || readyTargetInputToRAFMS >= 100) {
        throw new Error(`The prepared target took ${readyTargetInputToRAFMS} ms to reach its complete ready RAF.`)
      }
    }],
    ...[['approach/source', sourcePhaseRAF], ['target-to-ready', targetPhaseRAF]].map(([phase, report]) => [phase, () => {
      if (!Number.isFinite(report?.maxGapMS) || report.maxGapMS < 0 || report.maxGapMS >= 100) {
        throw new Error(`A ${phase} renderer RAF gap exceeded 100 ms: ${report?.maxGapMS} ms.`)
      }
    }]),
  ])
  throwFailures(failures)
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
