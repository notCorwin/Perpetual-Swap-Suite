import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const exitCode = value => /^(?:0|[1-9][0-9]{0,2})$/.test(String(value)) && Number(value) <= 255 ? Number(value) : null
const unclassifiedCheck = (code, evidence, label) => {
  const normalized = exitCode(code)
  return { exitCode: normalized, passed: normalized === 0, classification: normalized === 0 ? 'passed' : 'integration-failed',
    evidence, ...(normalized === 0 ? {} : { unclassified: true, reason: `${label} failed without independent evidence identifying an external source failure.` }) }
}

/** Probe failures are context, never a reason to relabel a demonstrated defect. */
export function classifyLiveResults({ historyExitCode, statisticsExitCode, streamsExitCode, chartExitCode, chart, availability, revision } = {}) {
  const history = unclassifiedCheck(historyExitCode, 'okx-integration.log', 'History integration')
  const statistics = unclassifiedCheck(statisticsExitCode, 'okx-statistics.json', 'Statistics integration')
  const streams = unclassifiedCheck(streamsExitCode, 'okx-streams.log', 'All-contract WebSocket integration')
  const native = chart && typeof chart === 'object' && ['passed', 'app-failure', 'harness-failure', 'external-unavailable', 'integration-failed'].includes(chart.classification)
    ? chart : { classification: 'harness-failure', error: { message: 'The native chart result is absent or malformed.' } }
  const normalized = exitCode(chartExitCode), chartPassed = normalized === 0 && native.classification === 'passed'
  const chartClassification = native.classification === 'passed' && !chartPassed ? 'integration-failed' : native.classification
  const chartCheck = { exitCode: normalized, passed: chartPassed, classification: chartClassification,
    observations: native.observations?.length ?? 0, error: native.error, evidence: 'okx-live-chart/result.json' }
  const passed = history.passed && statistics.passed && streams.passed && chartPassed
  // A source-aware chart verdict has precedence over unrelated smoke/probe
  // failures. An unsuccessful stream smoke has no source-aware verdict, so a
  // failed REST probe cannot convert it into external-unavailable.
  const classification = passed ? 'passed' : native.classification === 'app-failure' ? 'app-failure'
    : chartClassification === 'harness-failure' ? 'harness-failure'
    : chartClassification === 'integration-failed' || !history.passed || !statistics.passed || !streams.passed ? 'integration-failed'
    : 'external-unavailable'
  return { revision, classification, checks: { history, statistics, streams, chart: chartCheck },
    externalFailures: (Array.isArray(availability?.probes) ? availability.probes : []).filter(probe => !probe.ok)
      .map(({ url, status, code, error }) => ({ url, status, code, error })) }
}

export async function classifyLiveArtifacts({ artifacts = 'artifacts', environment = process.env } = {}) {
  let availability, chart
  try { availability = JSON.parse(await readFile(join(artifacts, 'okx-endpoints.json'), 'utf8')) } catch {}
  try { chart = JSON.parse(await readFile(join(artifacts, 'okx-live-chart/result.json'), 'utf8')) } catch {}
  const result = classifyLiveResults({ availability, chart, revision: environment.GITHUB_SHA,
    historyExitCode: environment.HISTORY_EXIT_CODE, statisticsExitCode: environment.STATISTICS_EXIT_CODE,
    streamsExitCode: environment.STREAMS_EXIT_CODE, chartExitCode: environment.CHART_EXIT_CODE })
  await writeFile(join(artifacts, 'okx-result.json'), `${JSON.stringify(result, null, 2)}\n`)
  if (environment.GITHUB_STEP_SUMMARY) await appendFile(environment.GITHUB_STEP_SUMMARY,
    `Live OKX result: **${result.classification}**. Revision: \`${environment.GITHUB_SHA ?? 'unknown'}\`.\n\n` +
    Object.entries(result.checks).map(([name, check]) => `${name}: ${check.classification} (exit ${check.exitCode ?? 'missing'}).`).join(' ') + '\n\n' +
    'Inspect the independent logs, okx-live-chart/result.json, source witnesses, and operation recordings. Unclassified smoke failures are not asserted to be external outages.\n')
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--artifacts')) throw new Error('Usage: node scripts/okx-live-classify.mjs [--artifacts DIRECTORY]')
    const result = await classifyLiveArtifacts({ artifacts: args[1] ?? 'artifacts' })
    console.log(JSON.stringify(result, null, 2))
    if (result.classification !== 'passed') process.exitCode = 1
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1 }
}
