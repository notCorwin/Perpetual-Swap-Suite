import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const scenarios = ['idle', 'realtime', 'history', 'download']
const runtimes = ['electron', 'tauri']
const groups = ['combined', 'runtime', 'backend']
const resourceMetrics = ['cpuPercentOfOneCore', 'cpuSeconds', 'cpuEnergyJoules', 'cpuMeanWatts', 'meanFootprintMiB', 'peakFootprintMiB']
const finite = value => typeof value === 'number' && Number.isFinite(value)
const nonnegative = value => finite(value) && value >= 0
const nanoseconds = (object, key) => {
  const exact = object?.[`${key}Exact`]
  if (typeof exact === 'string' && /^\d+$/.test(exact)) {
    const value = Number(exact)
    return Number.isFinite(value) ? value : null
  }
  const value = object?.[key]
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

// Nearest-rank quantiles match the browser recorder. Aggregates use the
// conventional midpoint median for an even number of trial values.
export function percentile(values, fraction) {
  const sorted = values.filter(finite).toSorted((a, b) => a - b)
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null
}
export function distribution(values) {
  const sorted = values.filter(finite).toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return { n: sorted.length, median: sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null,
    min: sorted[0] ?? null, max: sorted.at(-1) ?? null }
}
const latency = values => ({ count: values.length, p50: percentile(values, .5), p95: percentile(values, .95) })
const sum = values => values.reduce((total, value) => total + value, 0)

/** Only complete intervals contribute. Full-window totals require every interval. */
export function summarizeResources(resources) {
  const samples = Array.isArray(resources?.samples) ? resources.samples : []
  const intervals = samples.slice(1).map(sample => sample.interval)
  return Object.fromEntries(groups.map(group => {
    const validDuration = interval => {
      const ns = nanoseconds(interval, 'elapsedNs')
      return ns !== null && ns > 0 ? ns : null
    }
    const allDurations = intervals.map(validDuration)
    const cpu = intervals.map((interval, index) => {
      const ns = nanoseconds(interval?.[group], 'cpuNs')
      return interval?.[group]?.complete === true && allDurations[index] !== null && ns !== null
        ? { ns, elapsed: allDurations[index] } : null
    }).filter(Boolean)
    const energy = intervals.map((interval, index) => {
      const ns = nanoseconds(interval?.[group], 'cpuEnergyNj')
      return interval?.[group]?.complete === true && allDurations[index] !== null && ns !== null
        ? { ns, elapsed: allDurations[index] } : null
    }).filter(Boolean)
    const footprints = samples.map(sample => {
      const total = sample.totals?.[group]
      return total?.complete === true && nonnegative(total.physicalFootprintBytes) ? total.physicalFootprintBytes / 1048576 : null
    }).filter(value => value !== null)
    const cpuComplete = intervals.length > 0 && cpu.length === intervals.length
    const energyComplete = intervals.length > 0 && energy.length === intervals.length
    const footprintComplete = samples.length > 0 && footprints.length === samples.length
    const elapsed = allDurations.every(value => value !== null) ? sum(allDurations) / 1e9 : null
    const cpuElapsed = sum(cpu.map(value => value.elapsed)) / 1e9
    const energyElapsed = sum(energy.map(value => value.elapsed)) / 1e9
    const coveredCpuSeconds = sum(cpu.map(value => value.ns)) / 1e9
    const coveredEnergyJoules = sum(energy.map(value => value.ns)) / 1e9
    return [group, {
      cpuPercentOfOneCore: cpuComplete ? coveredCpuSeconds / cpuElapsed * 100 : null,
      cpuSeconds: cpuComplete ? coveredCpuSeconds : null,
      cpuEnergyJoules: energyComplete ? coveredEnergyJoules : null,
      cpuMeanWatts: energyComplete ? coveredEnergyJoules / energyElapsed : null,
      meanFootprintMiB: footprintComplete ? sum(footprints) / footprints.length : null,
      peakFootprintMiB: footprintComplete ? Math.max(...footprints) : null,
      coverage: {
        intervalCount: intervals.length, sampledSeconds: elapsed,
        cpu: { complete: cpuComplete, intervals: cpu.length, seconds: cpuElapsed, coveredCpuSeconds: cpu.length ? coveredCpuSeconds : null },
        cpuEnergy: { complete: energyComplete, intervals: energy.length, seconds: energyElapsed, coveredCpuEnergyJoules: energy.length ? coveredEnergyJoules : null },
        footprint: { complete: footprintComplete, snapshots: footprints.length, totalSnapshots: samples.length },
        skippedSamples: resources?.skippedSamples ?? null,
      },
    }]
  }))
}

function countStatuses(records) {
  return records.reduce((counts, record) => {
    const status = typeof record?.status === 'string' ? record.status : 'unknown'
    counts[status] = (counts[status] ?? 0) + 1
    return counts
  }, {})
}
function uniqueRecords(records, key) {
  const counts = new Map()
  for (const record of records) counts.set(record[key], (counts.get(record[key]) ?? 0) + 1)
  return { counts, records: records.filter(record => record[key] !== null && record[key] !== undefined && counts.get(record[key]) === 1) }
}
export function summarizeInputs(phase) {
  const records = Array.isArray(phase.inputs) ? phase.inputs : []
  const unique = uniqueRecords(records, 'index')
  const committed = unique.records.filter(input => Number.isSafeInteger(input.index) && input.index >= 0 && input.status === 'committed'
    && input.correct === true && nonnegative(input.latencyMS))
  return {
    planned: phase.inputCounts?.planned ?? null, dispatched: records.length,
    committed: records.filter(input => input.status === 'committed').length,
    acknowledged: committed.length, superseded: records.filter(input => input.status === 'superseded').length,
    missed: records.filter(input => input.status === 'missed').length,
    errors: records.filter(input => Boolean(input.error) || input.status === 'committed' && input.correct !== true).length,
    pending: phase.pendingInputs ?? null,
    duplicateIndices: [...unique.counts].filter(([key, count]) => key != null && count > 1).length,
    statuses: countStatuses(records), latencyMS: latency(committed.map(input => input.latencyMS)),
    committedIndices: committed.map(input => input.index).toSorted((a, b) => a - b),
  }
}
export function summarizeRealtime(phase) {
  if (phase.scenario !== 'realtime') return null
  const deliveries = Array.isArray(phase.deliveries) ? phase.deliveries : []
  const live = Array.isArray(phase.live) ? phase.live : []
  const planned = Number.isSafeInteger(phase.load?.plannedTicks) && phase.load.plannedTicks >= 0 ? phase.load.plannedTicks : null
  const validDeliveries = deliveries.filter(item => Number.isSafeInteger(item.sequence) && item.sequence > 0
    && (planned === null || item.sequence <= planned))
  const unique = uniqueRecords(validDeliveries, 'sequence')
  const liveByClose = uniqueRecords(live, 'close')
  const matching = new Map(liveByClose.records.map(record => [record.close, record]))
  const committed = unique.records.filter(delivery => delivery.status === 'committed').map(delivery => matching.get(delivery.expected))
    .filter(record => record?.status === 'committed' && record.caughtUp === true)
  const absent = planned === null ? null : Math.max(0, planned - unique.records.length)
  const statuses = countStatuses(unique.records)
  const receive = committed.map(record => record.receiveToRAFMS).filter(nonnegative)
  // Clock calibration can produce a small negative source latency; preserve it
  // rather than silently biasing the distribution by truncating clock error.
  const source = committed.map(record => record.sourceToRAFMS).filter(finite)
  return {
    planned, emitted: phase.load?.emitted ?? null, completed: phase.load?.completed ?? null, loadFailed: phase.load?.failed ?? null,
    receivedEvents: live.length, recordedDeliveries: deliveries.length, uniqueDeliveries: unique.records.length,
    duplicateSequences: [...unique.counts].filter(([key, count]) => key != null && count > 1).length,
    invalidSequences: deliveries.length - validDeliveries.length,
    committed: statuses.committed ?? 0, coalesced: statuses.coalesced ?? 0, missed: statuses.missed ?? 0,
    missing: (statuses.missing ?? 0) + (absent ?? 0), absent, incorrect: statuses.incorrect ?? 0, statuses,
    receiveToRAFMS: latency(receive), sourceToRAFMS: latency(source),
  }
}

const statsFor = (items, names, get) => Object.fromEntries(names.map(name => [name, distribution(items.map(item => get(item, name)))]))
function summarizeTrial(run, phase) {
  return {
    round: run.round, runtime: run.runtime, scenario: phase.scenario, durationMS: phase.durationMS,
    clockCalibration: run.prepared?.clockCalibration ?? null,
    nativeVisibility: phase.nativeVisibility ?? [], simulatedVisibility: phase.visibility ?? [],
    activePageSimulated: phase.activePageSimulated ?? false,
    inputs: summarizeInputs(phase), realtime: summarizeRealtime(phase),
    pageErrors: phase.errors?.length ?? null, correctnessFailures: phase.failures?.length ?? null,
    rafOpportunityGapsMS: phase.rafOpportunityGapsMS ?? null, rafCount: phase.rafCount ?? null,
    resources: summarizeResources(phase.resources),
  }
}
function signature(run, phase) {
  const records = Array.isArray(phase.inputs) ? phase.inputs : []
  return JSON.stringify({ count: run.fixture?.count, periods: run.fixture?.periods, timeframes: run.fixture?.timeframes,
    instIds: run.fixture?.instIds, rowsSeeded: run.fixture?.rowsSeeded,
    planned: phase.inputCounts?.planned, targets: records.map(({ index, kind, targetEnd }) => [index, kind, targetEnd ?? null]),
    load: phase.load && [phase.load.plannedTicks, phase.load.cadenceMS, phase.load.emitted, phase.load.completed, phase.load.failed],
    deliveryTargets: phase.deliveries?.map(({ sequence, expected }) => [sequence, expected]),
    download: phase.scenario === 'download' ? [phase.downloadStart?.initialRows, phase.downloadEnd?.archiveRows, phase.downloadEnd?.audit?.phase] : null })
}
function phaseValid(run, phase) {
  const inputs = summarizeInputs(phase), live = summarizeRealtime(phase)
  const samples = phase.resources?.samples
  return run.outcome === 'passed' && phase.errors?.length === 0 && phase.failures?.length === 0
    && inputs.planned !== null && inputs.planned === inputs.dispatched && inputs.errors === 0 && inputs.pending === 0 && inputs.duplicateIndices === 0
    && Array.isArray(phase.inputs) && phase.inputs.every(input => ['committed', 'superseded'].includes(input.status))
    && inputs.acknowledged === inputs.planned && inputs.superseded === 0 && inputs.missed === 0
    && Array.isArray(phase.visibility) && phase.visibility.length > 0 && phase.visibility.every(value => value === 'visible')
    && Array.isArray(samples) && samples.length >= 2 && samples.every(sample => sample.frontmostIsRuntime === false)
    && (run.runtime !== 'tauri' || samples.every(sample => sample.responsibleLookupAvailable === true
      && sample.processes?.some(process => process.webKitRoot && process.name?.includes('WebContent'))))
    && (phase.scenario !== 'download' || phase.downloadStart?.initialRows === 0 && phase.downloadEnd?.archiveRows === 12240 && phase.downloadEnd?.audit?.phase === 'idle')
    && (!live || phase.load?.state === 'complete' && phase.load?.plannedTicks === 60 && phase.load?.cadenceMS === 500
      && live.emitted === 60 && live.completed === 60 && live.loadFailed === 0 && live.duplicateSequences === 0 && live.invalidSequences === 0
      && live.committed === 60 && live.coalesced === 0 && live.missed === 0 && live.missing === 0 && live.incorrect === 0
      && live.receiveToRAFMS.count === 60 && live.sourceToRAFMS.count === 60
      && live.planned === live.uniqueDeliveries)
}
function pairingEligibility(report) {
  const reasons = []
  if (report.outcome !== 'passed' || report.smoke !== false) reasons.push('The report is failed or a smoke run.')
  if (report.rounds !== 3 || report.runs.length !== 6 || report.runs.map(run => `${run.round}:${run.runtime}`).join(',') !==
    '1:electron,1:tauri,2:tauri,2:electron,3:electron,3:tauri') reasons.push('The formal three-pair AB/BA/AB order is incomplete.')
  if (report.measurement?.count !== 287 || report.measurement?.requestedCadenceMS !== 500 || report.measurement?.syntheticInteractionCadenceMS !== 200)
    reasons.push('The formal contract count or cadence differs.')
  for (const run of report.runs) {
    if (run.fixture?.count !== 287 || run.fixture?.instIds?.length !== 287 || run.fixture?.periods !== 384
      || JSON.stringify(run.fixture?.timeframes) !== JSON.stringify(['5m', '15m', '1H']) || run.outcome !== 'passed'
      || !report.canonicalDataHash || run.canonicalDataHash !== report.canonicalDataHash || run.pathComparison?.compatible !== true
      || run.final?.liveMismatches?.length !== 0 || run.final?.ticks !== 60 || run.final?.nativeUpdates !== 287 * 3 * 60
      || run.final?.actualRows !== run.fixture?.rowsSeeded)
      reasons.push(`Round ${run.round} ${run.runtime} lacks matching formal workload or correctness evidence.`)
  }
  return [...new Set(reasons)]
}
function paired(report, trials, reasons) {
  return Object.fromEntries(scenarios.map(scenario => {
    const values = Object.fromEntries(groups.map(group => [group, Object.fromEntries(resourceMetrics.map(metric => [metric, []]))]))
    const pairs = []
    for (let round = 1; round <= 3; round++) {
      const electronRun = report.runs.find(run => run.runtime === 'electron' && run.round === round)
      const tauriRun = report.runs.find(run => run.runtime === 'tauri' && run.round === round)
      const electronPhase = electronRun?.phases?.find(phase => phase.scenario === scenario)
      const tauriPhase = tauriRun?.phases?.find(phase => phase.scenario === scenario)
      const localReasons = [...reasons]
      if (!electronPhase || !tauriPhase || !phaseValid(electronRun, electronPhase) || !phaseValid(tauriRun, tauriPhase)) localReasons.push('A phase is missing or invalid.')
      else if (signature(electronRun, electronPhase) !== signature(tauriRun, tauriPhase)) localReasons.push('Workload or exact interaction targets differ.')
      const electron = trials.find(trial => trial.round === round && trial.runtime === 'electron' && trial.scenario === scenario)
      const tauri = trials.find(trial => trial.round === round && trial.runtime === 'tauri' && trial.scenario === scenario)
      const relativePercent = {}
      for (const group of groups) {
        relativePercent[group] = {}
        for (const metric of resourceMetrics) {
          const base = electron?.resources[group][metric], candidate = tauri?.resources[group][metric]
          const value = !localReasons.length && finite(base) && base > 0 && finite(candidate) ? (candidate - base) / base * 100 : null
          relativePercent[group][metric] = value
          if (value !== null) values[group][metric].push(value)
        }
      }
      pairs.push({ round, validWorkload: localReasons.length === 0, reasons: localReasons, relativePercent })
    }
    return [scenario, { pairs, relativePercent: Object.fromEntries(groups.map(group => [group,
      Object.fromEntries(resourceMetrics.map(metric => [metric, distribution(values[group][metric])]))])) }]
  }))
}

/** Deterministic report transformation; the optional override is for diagnostics. */
export function analyzeReport(report, { allowSmoke = false } = {}) {
  if (!report || report.schemaVersion !== 1 || !Array.isArray(report.runs)) throw new Error('Expected a runtime-comparison schemaVersion 1 report with a runs array.')
  if (!allowSmoke && (report.outcome !== 'passed' || report.smoke !== false)) throw new Error('Report did not pass or is a smoke run. Use --allow-smoke only for diagnostic analysis.')
  const trials = report.runs.flatMap(run => (Array.isArray(run.phases) ? run.phases : []).map(phase => summarizeTrial(run, phase)))
  const grouped = Object.fromEntries(scenarios.map(scenario => [scenario, Object.fromEntries(runtimes.map(runtime => {
    const items = trials.filter(item => item.scenario === scenario && item.runtime === runtime)
    return [runtime, {
      trialCount: items.length,
      resources: Object.fromEntries(groups.map(group => [group, statsFor(items, resourceMetrics, (item, metric) => item.resources[group][metric])])),
      inputs: statsFor(items, ['planned', 'dispatched', 'committed', 'acknowledged', 'superseded', 'missed', 'errors'], (item, key) => item.inputs[key]),
      interactionLatencyMS: statsFor(items, ['p50', 'p95'], (item, key) => item.inputs.latencyMS[key]),
      realtime: scenario === 'realtime' ? statsFor(items, ['planned', 'emitted', 'completed', 'receivedEvents', 'committed', 'coalesced', 'missed', 'missing', 'incorrect'], (item, key) => item.realtime?.[key]) : null,
      realtimeLatencyMS: scenario === 'realtime' ? Object.fromEntries(['receiveToRAFMS', 'sourceToRAFMS'].map(name => [name,
        statsFor(items, ['p50', 'p95'], (item, key) => item.realtime?.[name]?.[key])])) : null,
    }]
  }))]))
  const reasons = pairingEligibility(report)
  return {
    schemaVersion: 1,
    report: { outcome: report.outcome, smoke: report.smoke, rounds: report.rounds, revision: report.revision, dirty: report.dirty,
      sourceFingerprint: report.sourceFingerprint?.sha256 ?? null, canonicalDataHash: report.canonicalDataHash ?? null,
      startedAt: report.startedAt, finishedAt: report.finishedAt, machine: report.machine, scope: report.scope, measurement: report.measurement },
    interpretation: {
      cpu: 'Percent of one core, weighted by sampled interval duration. CPU seconds and joules cover the whole sampling window only when all intervals are complete.',
      energy: 'CPU-only per-process energy; not total application, device, GPU, display, or shared-system energy.',
      footprint: 'Arithmetic mean and peak of complete 1 Hz physical-footprint snapshots; the peak is sampled, not continuous.',
      coverage: 'Coverage is of recorded intervals and snapshots, not a guarantee that short-lived processes or all WebKit work were attributed.',
      interaction: 'Acknowledged latency uses only individually unique, correct committed input records; p50/p95 use nearest rank. Superseded inputs are separate.',
      realtime: 'Delivery counts refer to the focused contract/timeframe; source timing includes clock calibration uncertainty. RAF is an opportunity and DOM commit, not physical presentation.',
      paired: 'Per-pair relative percent is (Tauri - Electron) / Electron × 100, only for matching valid formal workloads and complete metric coverage; no inference of significance.',
    },
    pairingEligibility: { eligible: reasons.length === 0, reasons }, trials, grouped, paired: paired(report, trials, reasons),
  }
}

const fmt = value => finite(value) ? value.toFixed(2) : 'n/a'
const stat = value => value?.n ? `${fmt(value.median)} [${fmt(value.min)}, ${fmt(value.max)}; n=${value.n}]` : 'n/a'
export function formatSummary(summary) {
  const lines = [`Runtime comparison: ${summary.report.outcome}${summary.report.smoke ? ' (SMOKE: diagnostic only)' : ''}; ${summary.report.rounds} round(s)`,
    'Values are trial median [min, max]. CPU% is one-core; energy is CPU-only. RAF is not physical presentation.']
  for (const scenario of scenarios) for (const runtime of runtimes) {
    const group = summary.grouped[scenario][runtime]
    const items = summary.trials.filter(item => item.scenario === scenario && item.runtime === runtime)
    lines.push(`${scenario} / ${runtime} (${group.trialCount} trial${group.trialCount === 1 ? '' : 's'}):`)
    for (const name of groups) {
      const metrics = group.resources[name]
      const coverage = items.map(item => {
        const c = item.resources[name].coverage
        return `r${item.round} cpu ${c.cpu.intervals}/${c.intervalCount} ${c.cpu.complete ? 'complete' : 'incomplete'}, energy ${c.cpuEnergy.intervals}/${c.intervalCount} ${c.cpuEnergy.complete ? 'complete' : 'incomplete'}, footprint ${c.footprint.snapshots}/${c.footprint.totalSnapshots} ${c.footprint.complete ? 'complete' : 'incomplete'}, covered ${fmt(c.cpu.seconds)}/${fmt(c.sampledSeconds)} s, skipped ${c.skippedSamples ?? '?'}`
      }).join('; ') || 'no samples'
      lines.push(`  ${name}: CPU% ${stat(metrics.cpuPercentOfOneCore)}; CPU s ${stat(metrics.cpuSeconds)}; CPU J ${stat(metrics.cpuEnergyJoules)}; CPU W ${stat(metrics.cpuMeanWatts)}; footprint MiB mean ${stat(metrics.meanFootprintMiB)}, peak ${stat(metrics.peakFootprintMiB)}; coverage ${coverage}`)
    }
    for (const item of items) {
      const input = item.inputs
      lines.push(`  r${item.round} inputs: ack ${input.acknowledged}/${input.planned ?? '?'} planned, dispatched ${input.dispatched}, superseded ${input.superseded}, missed ${input.missed}, errors ${input.errors}, page errors/failures ${item.pageErrors ?? '?'}/${item.correctnessFailures ?? '?'}; commit p50/p95 ${fmt(input.latencyMS.p50)}/${fmt(input.latencyMS.p95)} ms (n=${input.latencyMS.count})`)
      if (item.realtime) {
        const live = item.realtime
        lines.push(`  r${item.round} realtime: committed ${live.committed}/${live.planned ?? '?'} planned, received ${live.receivedEvents}, coalesced ${live.coalesced}, missed ${live.missed}, missing ${live.missing}, incorrect ${live.incorrect}; receive→RAF p50/p95 ${fmt(live.receiveToRAFMS.p50)}/${fmt(live.receiveToRAFMS.p95)} ms (n=${live.receiveToRAFMS.count}); source→RAF ${fmt(live.sourceToRAFMS.p50)}/${fmt(live.sourceToRAFMS.p95)} ms (n=${live.sourceToRAFMS.count})`)
      }
    }
  }
  if (!summary.pairingEligibility.eligible) lines.push(`Paired deltas unavailable: ${summary.pairingEligibility.reasons.join(' ')}`)
  return lines.join('\n')
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node analyze.mjs <report.json> [--output <summary.json>] [--allow-smoke]')
    return
  }
  let input, output, allowSmoke = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--allow-smoke') allowSmoke = true
    else if (arg === '--output') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--output requires a path.')
      output = args[++index]
    } else if (arg.startsWith('-') || input) throw new Error(`Unexpected argument: ${arg}`)
    else input = arg
  }
  if (!input) throw new Error('Provide a report.json path. Use --help for usage.')
  const inputPath = resolve(input), outputPath = resolve(output ?? join(dirname(inputPath), 'summary.json'))
  if (outputPath === inputPath) throw new Error('Summary output must differ from the input report.')
  const report = JSON.parse(await readFile(inputPath, 'utf8'))
  const summary = analyzeReport(report, { allowSmoke })
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(formatSummary(summary))
  console.log(`Summary: ${outputPath}`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`Analysis failed: ${error.message}`); process.exitCode = 1 })
}
