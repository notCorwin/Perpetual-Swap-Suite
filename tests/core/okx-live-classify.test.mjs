import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifyLiveArtifacts, classifyLiveResults } from '../../scripts/okx-live-classify.mjs'

const successful = () => ({ historyExitCode: '0', statisticsExitCode: '0', streamsExitCode: '0', chartExitCode: '0', chart: { classification: 'passed', observations: [1, 2, 3, 4] } })
const outage = { probes: [{ url: 'https://www.okx.com/api/v5/rubik/stat/taker-volume-contract', ok: false, status: 503 }] }

test('scheduled checks preserve exact chart defects and do not invent WebSocket outage causes', async t => {
  const cases = [
    ['all integrations passed despite an earlier failed probe', { ...successful(), availability: outage }, 'passed'],
    ['proven chart defect dominates stream failure and unrelated outage', { ...successful(), chartExitCode: '1', streamsExitCode: '1', chart: { classification: 'app-failure' }, availability: outage }, 'app-failure'],
    ['an incorrect zero chart exit cannot erase its demonstrated defect', { ...successful(), chart: { classification: 'app-failure' } }, 'app-failure'],
    ['chart harness failure dominates availability', { ...successful(), chartExitCode: '1', chart: { classification: 'harness-failure' }, availability: outage }, 'harness-failure'],
    ['successful chart assertions with failed recording remain integration failure', { ...successful(), chartExitCode: '1', availability: outage }, 'integration-failed'],
    ['stream failure with REST outage has no independently proved WS cause', { ...successful(), streamsExitCode: '1', availability: outage }, 'integration-failed'],
    ['source-aware chart unavailability alone remains external', { ...successful(), chartExitCode: '2', chart: { classification: 'external-unavailable' } }, 'external-unavailable'],
    ['unclassified stream failure cannot borrow chart source unavailability', { ...successful(), streamsExitCode: '1', chartExitCode: '2', chart: { classification: 'external-unavailable' }, availability: outage }, 'integration-failed'],
    ['missing chart evidence remains a harness failure', { ...successful(), chart: undefined, availability: outage }, 'harness-failure'],
    ['history failure is independent of statistics probe', { ...successful(), historyExitCode: '1', availability: outage }, 'integration-failed'],
    ['statistics failure stays independently visible', { ...successful(), statisticsExitCode: '1', availability: outage }, 'integration-failed'],
    ['missing WebSocket exit cannot pass', { ...successful(), streamsExitCode: undefined }, 'integration-failed'],
  ]
  for (const [name, input, expected] of cases) await t.test(name, () => {
    const result = classifyLiveResults(input)
    assert.equal(result.classification, expected)
    if (input.streamsExitCode !== '0') {
      assert.equal(result.checks.streams.classification, 'integration-failed')
      assert.equal(result.checks.streams.unclassified, true)
      assert.equal(result.checks.streams.evidence, 'okx-streams.log')
    }
  })
})

test('artifact classification persists independent exits, probe context and chart identity evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'okx-classify-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'okx-live-chart'))
  await writeFile(join(directory, 'okx-endpoints.json'), JSON.stringify(outage))
  await writeFile(join(directory, 'okx-live-chart/result.json'), JSON.stringify({ classification: 'app-failure', observations: [1, 2], error: { message: 'Selected SVG price differs from the independently witnessed candle.' } }))
  const summary = join(directory, 'summary.md')
  await classifyLiveArtifacts({ artifacts: directory, environment: { GITHUB_SHA: 'fixture-revision', GITHUB_STEP_SUMMARY: summary,
    HISTORY_EXIT_CODE: '0', STATISTICS_EXIT_CODE: '1', STREAMS_EXIT_CODE: '1', CHART_EXIT_CODE: '1' } })
  const result = JSON.parse(await readFile(join(directory, 'okx-result.json'), 'utf8'))
  assert.equal(result.classification, 'app-failure'); assert.equal(result.revision, 'fixture-revision')
  assert.equal(result.checks.history.exitCode, 0); assert.equal(result.checks.statistics.exitCode, 1); assert.equal(result.checks.streams.exitCode, 1)
  assert.equal(result.checks.chart.observations, 2); assert.equal(result.externalFailures[0].status, 503)
  assert.match(await readFile(summary, 'utf8'), /Unclassified smoke failures are not asserted to be external outages/)
})


test('a forwarded subscription without its native acknowledgment remains an unresolved integration failure', () => {
  const result = classifyLiveResults({ historyExitCode: '0', statisticsExitCode: '0', streamsExitCode: '0', chartExitCode: '1',
    chart: { classification: 'integration-failed', error: { message: 'The exact native subscription acknowledgment was not observed.' } },
    availability: { probes: [{ ok: false, url: 'unrelated-history-endpoint' }] } })
  assert.equal(result.classification, 'integration-failed')
  assert.equal(result.checks.chart.classification, 'integration-failed')
})
