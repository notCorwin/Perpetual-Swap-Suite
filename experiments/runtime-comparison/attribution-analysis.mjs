import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { distribution, summarizeInputs, summarizeRealtime, summarizeResources } from './analyze.mjs'

const runtimes = ['electron', 'tauri']
const transports = ['http', 'native']
const telemetryModes = ['full', 'off']
const groups = ['runtime', 'backend', 'combined']
const resourceMetrics = ['cpuPercentOfOneCore', 'cpuSeconds', 'cpuEnergyJoules', 'cpuMeanWatts', 'meanFootprintMiB', 'peakFootprintMiB']
const contrastMetrics = ['cpuEnergyJoules', 'cpuPercentOfOneCore', 'cpuMeanWatts']
const rounds = [1, 2, 3]
const finite = value => typeof value === 'number' && Number.isFinite(value)
const nonnegative = value => finite(value) && value >= 0
const integer = value => Number.isSafeInteger(value) && value >= 0
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const unique = values => [...new Set(values)]
const label = run => `round ${run?.round ?? '?'} ${run?.runtime ?? '?'}/${run?.transport ?? '?'}/${run?.telemetry ?? '?'}`
const expectedId = index => `SCALE${String(index).padStart(3, '0')}-USDT-SWAP`
const expectedClose = sequence => 100 + 10 + 384 * .01 + sequence * .001
const ident = run => `${run.round}:${run.runtime}:${run.transport}:${run.telemetry}`

function inputTargets(run, phase) {
  if (!Array.isArray(phase?.inputs) || typeof run?.fixture?.instIds?.[0] !== 'string') return null
  return phase.inputs.map(input => ({ index: input?.index ?? null, kind: input?.kind ?? null,
    targetEnd: input?.targetEnd ?? null,
    term: input?.term ?? null, expectedCount: input?.expectedCount ?? null }))
}
function deliveryTargets(phase) {
  return Array.isArray(phase?.deliveries)
    ? phase.deliveries.map(item => [item?.sequence ?? null, item?.expected ?? null]) : null
}
function transportSummary(metrics) {
  if (!metrics || typeof metrics !== 'object') return null
  const maps = ['requests', 'requestBytes', 'responseBytes', 'events', 'eventBytes']
  const raw = Object.fromEntries(maps.map(key => [key, metrics[key] && typeof metrics[key] === 'object' && !Array.isArray(metrics[key]) ? { ...metrics[key] } : null]))
  const keys = (...names) => unique(names.flatMap(name => Object.keys(raw[name] ?? {}))).toSorted()
  // Missing map or key is null, not an invented count/byte value.
  const value = (name, key) => integer(raw[name]?.[key]) ? raw[name][key] : null
  return { raw,
    routes: Object.fromEntries(keys('requests', 'requestBytes', 'responseBytes').map(key => [key, {
      count: value('requests', key), requestBytes: value('requestBytes', key), responseBytes: value('responseBytes', key),
    }])),
    events: Object.fromEntries(keys('events', 'eventBytes').map(key => [key, { count: value('events', key), bytes: value('eventBytes', key) }])),
  }
}
function summarizeTrial(run, phase) {
  const inputs = Array.isArray(phase?.inputs) ? summarizeInputs(phase) : null
  const liveSummary = phase?.scenario === 'realtime' && Array.isArray(phase.deliveries) && Array.isArray(phase.live) ? summarizeRealtime(phase) : null
  const live = liveSummary ? { ...liveSummary, acknowledged: liveSummary.receiveToRAFMS.count } : null
  const durationMS = nonnegative(phase?.durationMS) && phase.durationMS > 0 ? phase.durationMS : null
  return {
    round: run.round, runtime: run.runtime, transport: run.transport, telemetry: run.telemetry, scenario: phase.scenario,
    durationMS, resources: summarizeResources(phase.resources),
    inputs, realtime: live,
    rawCounts: { inputCounts: phase.inputCounts ?? null, pendingInputs: phase.pendingInputs ?? null,
      inputRecords: Array.isArray(phase.inputs) ? phase.inputs.length : null,
      liveRecords: Array.isArray(phase.live) ? phase.live.length : null,
      deliveryRecords: Array.isArray(phase.deliveries) ? phase.deliveries.length : null,
      load: phase.load ? { state: phase.load.state ?? null, plannedTicks: phase.load.plannedTicks ?? null,
        cadenceMS: phase.load.cadenceMS ?? null, firstSequence: phase.load.firstSequence ?? null,
        emitted: phase.load.emitted ?? null, completed: phase.load.completed ?? null, pending: phase.load.pending ?? null,
        failed: phase.load.failed ?? null, maxPending: phase.load.maxPending ?? null,
        tickRecords: Array.isArray(phase.load.ticks) ? phase.load.ticks.length : null } : null,
      errors: Array.isArray(phase.errors) ? phase.errors.length : null, failures: Array.isArray(phase.failures) ? phase.failures.length : null,
      rafCount: integer(phase.rafCount) ? phase.rafCount : null,
      final: run.final ? { ticks: run.final.ticks ?? null, nativeUpdates: run.final.nativeUpdates ?? null,
        actualRows: run.final.actualRows ?? null, minimumRowsPerSeries: run.final.minimumRowsPerSeries ?? null,
        liveProjectionSeeds: run.final.liveProjectionSeeds ?? null,
        liveMismatches: Array.isArray(run.final.liveMismatches) ? run.final.liveMismatches.length : null } : null },
    inputTargets: inputTargets(run, phase), deliveryTargets: deliveryTargets(phase),
    raf: { count: integer(phase.rafCount) ? phase.rafCount : null,
      opportunitiesPerSecond: integer(phase.rafCount) && durationMS !== null ? phase.rafCount * 1000 / durationMS : null,
      gapsMS: phase.rafOpportunityGapsMS ?? null },
    transportMetrics: transportSummary(phase.transportMetrics),
    clockCalibration: run.prepared?.clockCalibration ?? null,
    visibility: phase.visibility ?? null, nativeVisibility: phase.nativeVisibility ?? null,
  }
}

// Every element of this check is evidence produced by the runner. It cannot
// independently recompute the full indicator oracle from the compact chart.
function runWorkloadReasons(report, run) {
  const reasons = [], id = label(run), f = run.fixture, end = run.final
  if (run.outcome !== 'passed') reasons.push(`${id}: run did not pass.`)
  const chart = run.prepared?.chart
  const chartHash = chart && typeof chart === 'object'
    ? createHash('sha256').update(JSON.stringify({ ...chart, svgPaths: undefined })).digest('hex') : null
  if (typeof report.canonicalDataHash !== 'string' || !report.canonicalDataHash || run.canonicalDataHash !== report.canonicalDataHash
    || chartHash !== run.canonicalDataHash)
    reasons.push(`${id}: canonical data hash is missing or mismatched.`)
  if (run.pathComparison?.compatible !== true || run.prepared?.visibility !== 'visible'
    || !Array.isArray(run.prepared?.errors) || run.prepared.errors.length !== 0
    || run.prepared?.bars !== 96 || run.prepared?.chart?.instId !== f?.instIds?.[0]
    || !Array.isArray(run.prepared?.chart?.bars) || run.prepared.chart.bars.length !== 96)
    reasons.push(`${id}: prepared chart or path/oracle evidence is missing or invalid.`)
  if (f?.count !== 287 || f.periods !== 384 || f.rowsSeeded !== 330624
    || !same(f.timeframes, ['5m', '15m', '1H']) || !Array.isArray(f.instIds) || f.instIds.length !== 287
    || !f.instIds.every((value, index) => value === expectedId(index)))
    reasons.push(`${id}: fixture does not contain the canonical 287 contracts, 3 timeframes and 330624 rows.`)
  if (end?.ticks !== 60 || end?.nativeUpdates !== 51660 || end?.actualRows !== 330624
    || end?.minimumRowsPerSeries !== 384 || end?.liveProjectionSeeds !== 861
    || !Array.isArray(end?.liveMismatches) || end.liveMismatches.length !== 0)
    reasons.push(`${id}: final evidence does not validate all 861 series, 51660 native updates and 330624 rows.`)
  const phases = Array.isArray(run.phases) ? run.phases.filter(p => p?.scenario === 'realtime') : []
  if (phases.length !== 1 || run.phases.length !== 1) { reasons.push(`${id}: exactly one realtime phase is required.`); return reasons }
  const phase = phases[0]
  if (!finite(phase.durationMS) || phase.durationMS <= 0 || !integer(phase.rafCount)
    || phase.rafCount * 1000 / phase.durationMS < 50)
    reasons.push(`${id}: active-page scheduling must provide at least 50 RAF opportunities per second.`)
  if (!Array.isArray(phase.errors) || phase.errors.length || !Array.isArray(phase.failures) || phase.failures.length
    || !Array.isArray(phase.visibility) || !phase.visibility.length || phase.visibility.some(value => value !== 'visible')
    || phase.finalChart?.instId !== f?.instIds?.[0] || !Array.isArray(phase.finalChart?.bars) || phase.finalChart.bars.length !== 96
    || !same({ ...phase.finalChart, svgPaths: undefined }, { ...chart, svgPaths: undefined }))
    reasons.push(`${id}: page, visibility or chart oracle checks are missing or failed.`)
  const samples = phase.resources?.samples
  if (!Array.isArray(samples) || samples.length < 2 || samples.some(sample => sample.frontmostIsRuntime !== false)
    || run.runtime === 'tauri' && samples.some(sample => sample.responsibleLookupAvailable !== true
      || !sample.processes?.some(process => process.webKitRoot && process.name?.includes('WebContent'))))
    reasons.push(`${id}: background sampling or WebKit renderer attribution evidence is incomplete.`)
  const inputs = Array.isArray(phase.inputs) ? summarizeInputs(phase) : null
  if (!inputs || phase.inputCounts?.planned !== 152 || phase.inputCounts?.dispatched !== 152 || phase.inputCounts?.committed !== 152
    || phase.inputCounts?.superseded !== 0 || inputs.planned !== 152 || inputs.dispatched !== 152 || inputs.committed !== 152
    || inputs.acknowledged !== 152 || inputs.duplicateIndices !== 0 || inputs.errors !== 0 || inputs.pending !== 0
    || inputs.superseded !== 0 || inputs.missed !== 0
    || !phase.inputs.every((input, index) => input.index === index && input.kind === 'search' && input.targetEnd == null
      && input.term === (index % 2 ? '' : f.instIds[0].toLowerCase()) && input.expectedCount === (index % 2 ? f.count : 1)
      && input.status === 'committed' && input.correct === true && !input.error && nonnegative(input.latencyMS)))
    reasons.push(`${id}: all 152 planned inputs must be uniquely and correctly acknowledged without errors or supersession.`)
  const live = Array.isArray(phase.deliveries) && Array.isArray(phase.live) ? summarizeRealtime(phase) : null
  const load = phase.load, ticks = load?.ticks
  if (!live || load?.state !== 'complete' || load.plannedTicks !== 60 || load.cadenceMS !== 500 || load.firstSequence !== 1
    || load.emitted !== 60 || load.completed !== 60 || load.pending !== 0 || load.failed !== 0
    || live.receivedEvents !== 60 || live.recordedDeliveries !== 60 || live.uniqueDeliveries !== 60 || live.committed !== 60
    || live.duplicateSequences !== 0 || live.invalidSequences !== 0 || live.coalesced !== 0 || live.missed !== 0
    || live.missing !== 0 || live.incorrect !== 0 || live.receiveToRAFMS.count !== 60 || live.sourceToRAFMS.count !== 60
    || !Array.isArray(ticks) || ticks.length !== 60 || phase.deliveries.length !== 60 || phase.live.length !== 60
    || !ticks.every((tick, index) => tick.sequence === index + 1 && tick.expected === expectedClose(index + 1)
      && tick.instId === f?.instIds?.[0] && tick.timeframe === '15m' && tick.nativeUpdates === 861
      && phase.deliveries[index]?.sequence === tick.sequence && phase.deliveries[index]?.expected === tick.expected
      && phase.deliveries[index]?.status === 'committed')
    || !phase.live.every(item => item.status === 'committed' && item.caughtUp === true && item.close === item.displayedClose
      && phase.deliveries.filter(delivery => delivery.expected === item.close).length === 1)
    || phase.expectedClose !== expectedClose(60))
    reasons.push(`${id}: live replay or individual expected deliveries are missing, coalesced, incorrect or incomplete.`)
  const finalLoad = end?.load
  if (finalLoad?.state !== 'complete' || finalLoad.plannedTicks !== 60 || finalLoad.cadenceMS !== 500
    || finalLoad.firstSequence !== 1 || finalLoad.emitted !== 60 || finalLoad.completed !== 60 || finalLoad.pending !== 0 || finalLoad.failed !== 0
    || !Array.isArray(finalLoad.ticks) || finalLoad.ticks.length !== 60
    || !finalLoad.ticks.every((tick, index) => tick.sequence === index + 1 && tick.expected === expectedClose(index + 1)
      && tick.instId === f?.instIds?.[0] && tick.timeframe === '15m' && tick.nativeUpdates === 861))
    reasons.push(`${id}: final replay tick evidence is missing or inconsistent.`)
  return reasons
}

function reportReasons(report) {
  const reasons = []
  if (report.outcome !== 'passed' || report.smoke !== false) reasons.push('A passed, non-smoke report is required for baseline estimates.')
  if (report.diagnostics !== false || report.sampleStacks !== false || report.v8Profile !== false || report.engineProfile !== false
    || report.runs.some(run => run.stackProfiles != null || run.phases?.some(phase => phase.diagnostics != null)))
    reasons.push('Diagnostics, stack sampling, V8 profiling and engine profiling must all be explicitly disabled for baseline estimates.')
  if (report.rounds !== 3 || report.runs.length !== 24 || !same(report.scenarios, ['realtime']))
    reasons.push('The formal matrix requires three rounds, 24 runs and only the realtime scenario.')
  if (report.measurement?.count !== 287 || report.measurement?.periods !== 384 || report.measurement?.requestedCadenceMS !== 500
    || report.measurement?.syntheticInteractionCadenceMS !== 200)
    reasons.push('The formal workload requires 287 contracts, 384 periods, 500 ms live cadence and 200 ms input cadence.')
  const expectedVariants = transports.flatMap(transport => telemetryModes.map(telemetry => `${transport}:${telemetry}`)).toSorted()
  if (!Array.isArray(report.variants) || !same(report.variants.map(item => `${item.transport}:${item.telemetry}`).toSorted(), expectedVariants))
    reasons.push('The report must declare exactly the HTTP/native × full/off variants.')
  const expected = rounds.flatMap(round => runtimes.flatMap(runtime => transports.flatMap(transport => telemetryModes.map(telemetry => `${round}:${runtime}:${transport}:${telemetry}`)))).toSorted()
  if (!same(report.runs.map(ident).toSorted(), expected)) reasons.push('The factorial matrix has missing, duplicate or unexpected round/runtime/variant trials.')
  for (const run of report.runs) reasons.push(...runWorkloadReasons(report, run))
  return unique(reasons)
}
function workloadSignature(run, phase) {
  return { fixture: { count: run.fixture?.count, periods: run.fixture?.periods, timeframes: run.fixture?.timeframes,
    instIds: run.fixture?.instIds, rowsSeeded: run.fixture?.rowsSeeded },
  inputs: inputTargets(run, phase), deliveries: deliveryTargets(phase) }
}
function metricCoverage(metric, resource) {
  const c = resource?.coverage
  const complete = metric === 'cpuPercentOfOneCore' || metric === 'cpuSeconds' ? c?.cpu?.complete
    : metric === 'cpuEnergyJoules' || metric === 'cpuMeanWatts' ? c?.cpuEnergy?.complete : c?.footprint?.complete
  return complete === true && nonnegative(resource?.[metric])
}
function trialByKey(report, round, config) {
  const matches = report.runs.filter(run => run.round === round && run.runtime === config.runtime
    && run.transport === config.transport && run.telemetry === config.telemetry)
  if (matches.length !== 1) return null
  const run = matches[0], phases = Array.isArray(run.phases) ? run.phases.filter(phase => phase.scenario === 'realtime') : []
  if (phases.length !== 1) return null
  const phase = phases[0]
  return { run, phase, resource: summarizeResources(phase.resources), signature: workloadSignature(run, phase) }
}
function comparePair(report, baseConfig, candidateConfig, baselineReasons) {
  const pairs = rounds.map(round => {
    const base = trialByKey(report, round, baseConfig), candidate = trialByKey(report, round, candidateConfig)
    const reasons = [...baselineReasons]
    if (!base || !candidate) reasons.push(`Round ${round}: a unique realtime trial is missing.`)
    else if (!same(base.signature, candidate.signature)) reasons.push(`Round ${round}: fixture, exact input targets or delivery expected values differ.`)
    const values = Object.fromEntries(groups.map(group => [group, Object.fromEntries(contrastMetrics.map(metric => {
      const metricReasons = [...reasons]
      const a = base?.resource[group], b = candidate?.resource[group]
      if (!metricCoverage(metric, a) || !metricCoverage(metric, b)) metricReasons.push(`Round ${round}: ${group} ${metric} has incomplete or missing coverage.`)
      const baseline = a?.[metric] ?? null, current = b?.[metric] ?? null
      return [metric, { valid: metricReasons.length === 0, reasons: unique(metricReasons), baseline, candidate: current,
        absoluteChange: metricReasons.length ? null : current - baseline,
        relativePercent: metricReasons.length || baseline <= 0 ? null : (current - baseline) / baseline * 100,
        relativeUnavailableReason: !metricReasons.length && baseline <= 0 ? 'Baseline is not positive.' : null }]
    }))]))
    return { round, validWorkload: reasons.length === 0, reasons: unique(reasons), values }
  })
  return { baseline: baseConfig, candidate: candidateConfig, pairs,
    metrics: Object.fromEntries(groups.map(group => [group, Object.fromEntries(contrastMetrics.map(metric => {
      const items = pairs.map(pair => pair.values[group][metric]), reasons = unique(items.flatMap(item => item.reasons))
      const valid = items.every(item => item.valid)
      const relativeValid = valid && items.every(item => item.relativePercent !== null)
      return [metric, { valid, reasons, availablePairs: items.filter(item => item.valid).length, requiredPairs: 3,
        absoluteChange: distribution(valid ? items.map(item => item.absoluteChange) : []),
        relativePercent: distribution(relativeValid ? items.map(item => item.relativePercent) : []),
        relativeReasons: valid && !relativeValid ? ['At least one baseline is not positive.'] : reasons }]
    }))])) }
}
function interaction(report, runtime, baselineReasons) {
  const names = ['httpFull', 'httpOff', 'nativeFull', 'nativeOff']
  const configs = [{ runtime, transport: 'http', telemetry: 'full' }, { runtime, transport: 'http', telemetry: 'off' },
    { runtime, transport: 'native', telemetry: 'full' }, { runtime, transport: 'native', telemetry: 'off' }]
  const pairs = rounds.map(round => {
    const trials = configs.map(config => trialByKey(report, round, config)), reasons = [...baselineReasons]
    if (trials.some(value => !value)) reasons.push(`Round ${round}: a unique trial in the 2×2 cell is missing.`)
    else if (trials.some(value => !same(value.signature, trials[0].signature))) reasons.push(`Round ${round}: fixture, exact input targets or delivery expected values differ.`)
    return { round, validWorkload: reasons.length === 0, reasons: unique(reasons),
      values: Object.fromEntries(groups.map(group => [group, Object.fromEntries(contrastMetrics.map(metric => {
        const metricReasons = [...reasons]
        if (trials.some(item => !metricCoverage(metric, item?.resource[group]))) metricReasons.push(`Round ${round}: ${group} ${metric} has incomplete or missing coverage.`)
        const cells = Object.fromEntries(names.map((name, index) => [name, trials[index]?.resource[group][metric] ?? null]))
        return [metric, { valid: metricReasons.length === 0, reasons: unique(metricReasons), cells,
          absoluteInteraction: metricReasons.length ? null : (cells.nativeOff - cells.nativeFull) - (cells.httpOff - cells.httpFull) }]
      }))])) }
  })
  return { runtime, definition: '(native/off − native/full) − (http/off − http/full)', pairs,
    metrics: Object.fromEntries(groups.map(group => [group, Object.fromEntries(contrastMetrics.map(metric => {
      const items = pairs.map(pair => pair.values[group][metric]), valid = items.every(item => item.valid)
      return [metric, { valid, reasons: unique(items.flatMap(item => item.reasons)), availablePairs: items.filter(item => item.valid).length,
        requiredPairs: 3, absoluteInteraction: distribution(valid ? items.map(item => item.absoluteInteraction) : []) }]
    }))])) }
}

function groupedTrials(trials) {
  const stats = (items, get) => distribution(items.map(get))
  return Object.fromEntries(runtimes.map(runtime => [runtime, Object.fromEntries(transports.map(transport => [transport,
    Object.fromEntries(telemetryModes.map(telemetry => {
      const items = trials.filter(t => t.runtime === runtime && t.transport === transport && t.telemetry === telemetry && t.scenario === 'realtime')
      return [telemetry, { trialCount: items.length,
        resources: Object.fromEntries(groups.map(group => [group, Object.fromEntries(resourceMetrics.map(metric => [metric,
          stats(items, item => item.resources[group][metric])]))])),
        inputs: Object.fromEntries(['planned', 'dispatched', 'committed', 'acknowledged', 'superseded', 'missed', 'errors', 'pending'].map(key => [key, stats(items, item => item.inputs?.[key])])),
        realtime: Object.fromEntries(['planned', 'emitted', 'completed', 'receivedEvents', 'recordedDeliveries', 'committed', 'acknowledged', 'coalesced', 'missed', 'missing', 'incorrect'].map(key => [key, stats(items, item => item.realtime?.[key])])),
        latencyMS: Object.fromEntries(['p50', 'p95'].map(q => [q, {
          input: stats(items, item => item.inputs?.latencyMS?.[q]),
          receiveToRAF: stats(items, item => item.realtime?.receiveToRAFMS?.[q]),
          sourceToRAF: stats(items, item => item.realtime?.sourceToRAFMS?.[q]),
        }])),
        rafOpportunitiesPerSecond: stats(items, item => item.raf.opportunitiesPerSecond),
      }]
    }))]))]))
}

/** Pure transformation. Diagnostic/smoke opt-ins permit inspection, never baseline estimates. */
export function analyzeAttribution(report, { allowSmoke = false, allowDiagnostics = false } = {}) {
  if (!report || report.schemaVersion !== 1 || !Array.isArray(report.runs)) throw new Error('Expected a runtime-comparison schemaVersion 1 report with a runs array.')
  if (report.smoke === true && !allowSmoke) throw new Error('Smoke report: pass --allow-smoke for diagnostic analysis.')
  const diagnostic = report.diagnostics === true || report.sampleStacks === true || report.v8Profile === true || report.engineProfile === true
    || report.runs.some(run => run.stackProfiles != null || run.phases?.some(phase => phase.diagnostics != null))
  if (diagnostic && !allowDiagnostics) throw new Error('Profiling or diagnostics are enabled: pass --allow-diagnostics for diagnostic analysis.')
  if (report.outcome !== 'passed' && !allowDiagnostics && !allowSmoke) throw new Error('Report did not pass: pass --allow-diagnostics to inspect it.')
  const trials = report.runs.flatMap(run => (Array.isArray(run.phases) ? run.phases : []).map(phase => summarizeTrial(run, phase)))
  const reasons = reportReasons(report)
  const telemetryRemoval = Object.fromEntries(runtimes.map(runtime => [runtime, Object.fromEntries(transports.map(transport => [transport,
    comparePair(report, { runtime, transport, telemetry: 'full' }, { runtime, transport, telemetry: 'off' }, reasons)]))]))
  const transportSwitch = Object.fromEntries(runtimes.map(runtime => [runtime, Object.fromEntries(telemetryModes.map(telemetry => [telemetry,
    comparePair(report, { runtime, transport: 'http', telemetry }, { runtime, transport: 'native', telemetry }, reasons)]))]))
  return {
    schemaVersion: 1,
    report: { outcome: report.outcome ?? null, smoke: report.smoke ?? null, rounds: report.rounds ?? null,
      scenarios: report.scenarios ?? null, variants: report.variants ?? null, diagnostics: report.diagnostics ?? null,
      sampleStacks: report.sampleStacks ?? null, v8Profile: report.v8Profile ?? null, engineProfile: report.engineProfile ?? null, revision: report.revision ?? null,
      dirty: report.dirty ?? null, sourceFingerprint: report.sourceFingerprint?.sha256 ?? null, canonicalDataHash: report.canonicalDataHash ?? null,
      oracleSHA256: report.oracleSHA256 ?? null,
      startedAt: report.startedAt ?? null, finishedAt: report.finishedAt ?? null, machine: report.machine ?? null, measurement: report.measurement ?? null,
      runOrder: report.runs.map(run => ({ round: run.round, runtime: run.runtime, transport: run.transport, telemetry: run.telemetry })) },
    interpretation: {
      scope: 'Synthetic native intake and a controlled active page; external market network, physical presentation, and total device/GPU energy are not measured.',
      resources: 'CPU% is percent of one core over complete sampled intervals. CPU seconds and CPU-only joules require every interval; W is CPU joules divided by covered elapsed seconds. Footprint mean/peak use complete snapshots; peak is sampled. Coverage cannot detect every short-lived process or all WebKit work.',
      trialCounts: 'Raw counters, recorded search terms/expected result counts, and delivery targets are retained per trial and validated against the fixture. The browser checks chart fields against its full oracle, persisted by the runner as oracle.json with the report oracleSHA256; this analyzer does not independently recompute indicators.',
      latency: 'Per-trial p50/p95 use the helper nearest-rank definition. Grouped latency distributions are medians/min/max of trial percentiles, never pooled observations. Source-to-RAF includes clock calibration uncertainty; RAF is a DOM opportunity, not physical presentation.',
      liveAcknowledged: 'A unique delivery is acknowledged when its unique matching live record is committed, caught up and has a valid receive-to-RAF latency; delivery status counts are reported separately.',
      raf: 'RAF opportunities per second are the count divided by the recorded phase duration, which includes phase settling.',
      transport: 'Counters are the server phase snapshot for RPC routes and outbound event channels; bytes count serialized payloads, excluding framing. Events include controller commands as well as notifications. Missing keys remain null, and counts do not include every OS transport operation.',
      contrasts: 'Baseline eligibility checks the overall workload; each contrast separately checks paired targets and per-metric coverage. Within-round absolute change = candidate − baseline; relative percent = (candidate − baseline) / baseline × 100 only for a positive baseline. CPU% absolute changes are percentage points of one core. Aggregate median/min/max require all three pairs and complete coverage for that metric.',
      interaction: '(native/off − native/full) − (http/off − http/full), separately by runtime and resource group. Positive means the signed effect of telemetry removal is greater with native transport. This is a difference of absolute effects, not a relative percentage.',
      limits: 'Three pairs describe observed variation, not statistical significance. Diagnostic, profiling, smoke, failed, incomplete or unequal workloads never enter baseline causal estimates.',
    },
    baselineEligibility: { eligible: reasons.length === 0, reasons }, trials, grouped: groupedTrials(trials),
    contrasts: { telemetryRemoval, transportSwitch,
      interaction: Object.fromEntries(runtimes.map(runtime => [runtime, interaction(report, runtime, reasons)])),
      crossRuntimeNativeOff: comparePair(report, { runtime: 'electron', transport: 'native', telemetry: 'off' },
        { runtime: 'tauri', transport: 'native', telemetry: 'off' }, reasons) },
  }
}

const fmt = value => finite(value) ? value.toFixed(2) : 'n/a'
const formatted = stat => stat?.n ? `${fmt(stat.median)} [${fmt(stat.min)}, ${fmt(stat.max)}]` : 'n/a'
export function formatSummary(summary) {
  const lines = [`Attribution: ${summary.report.outcome ?? 'unknown'}; ${summary.trials.length} trial phases; baseline ${summary.baselineEligibility.eligible ? 'eligible' : 'ineligible'}.`,
    'CPU is % of one core; energy is CPU-only. Paired medians [min, max] require three rounds and do not establish significance.']
  for (const runtime of runtimes) for (const transport of transports) for (const telemetry of telemetryModes) {
    const value = summary.grouped[runtime][transport][telemetry], cpu = value.resources.combined.cpuPercentOfOneCore, energy = value.resources.combined.cpuEnergyJoules
    lines.push(`${runtime} ${transport}/${telemetry} (n=${value.trialCount}): combined CPU ${formatted(cpu)}%; CPU J ${formatted(energy)}; input p95 ${formatted(value.latencyMS.p95.input)} ms; live receive→RAF p95 ${formatted(value.latencyMS.p95.receiveToRAF)} ms.`)
  }
  for (const runtime of runtimes) for (const transport of transports) {
    const result = summary.contrasts.telemetryRemoval[runtime][transport].metrics.combined
    lines.push(`${runtime} ${transport} telemetry off − full: CPU J ${formatted(result.cpuEnergyJoules.absoluteChange)}; CPU percentage points ${formatted(result.cpuPercentOfOneCore.absoluteChange)}.`)
  }
  for (const runtime of runtimes) for (const telemetry of telemetryModes) {
    const result = summary.contrasts.transportSwitch[runtime][telemetry].metrics.combined
    lines.push(`${runtime} ${telemetry} native − HTTP: CPU J ${formatted(result.cpuEnergyJoules.absoluteChange)}; CPU percentage points ${formatted(result.cpuPercentOfOneCore.absoluteChange)}.`)
  }
  const cross = summary.contrasts.crossRuntimeNativeOff.metrics.combined
  lines.push(`Native/off Tauri − Electron: CPU J ${formatted(cross.cpuEnergyJoules.absoluteChange)}; CPU percentage points ${formatted(cross.cpuPercentOfOneCore.absoluteChange)}.`)
  if (!summary.baselineEligibility.eligible) {
    const reasons = summary.baselineEligibility.reasons
    lines.push(`Baseline unavailable (${reasons.length} reason${reasons.length === 1 ? '' : 's'}): ${reasons.slice(0, 3).join(' ')}${reasons.length > 3 ? ' See JSON for all reasons.' : ''}`)
  }
  return lines.join('\n')
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node attribution-analysis.mjs <report.json> [--output <path>] [--allow-diagnostics] [--allow-smoke]')
    return
  }
  let input, output, allowDiagnostics = false, allowSmoke = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--allow-smoke') allowSmoke = true
    else if (arg === '--allow-diagnostics') allowDiagnostics = true
    else if (arg === '--output') {
      if (!args[index + 1] || args[index + 1].startsWith('-')) throw new Error('--output requires a path.')
      output = args[++index]
    } else if (arg.startsWith('-') || input) throw new Error(`Unexpected argument: ${arg}`)
    else input = arg
  }
  if (!input) throw new Error('Provide a report.json path. Use --help for usage.')
  const inputPath = resolve(input), outputPath = resolve(output ?? join(dirname(inputPath), 'attribution-summary.json'))
  if (inputPath === outputPath) throw new Error('Summary output must differ from the input report.')
  const report = JSON.parse(await readFile(inputPath, 'utf8'))
  const summary = analyzeAttribution(report, { allowSmoke, allowDiagnostics })
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(formatSummary(summary))
  console.log(`Summary: ${outputPath}`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`Analysis failed: ${error.message}`); process.exitCode = 1 })
}
