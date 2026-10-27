import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { promisify, parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMetalDiagnostic, collectMetalDiagnostic } from './gpu/metal-provider.mjs'
import { defaultBudgets, median } from './operation-overhead.mjs'

const execute = promisify(execFile)

export function assessMetalObserverPairs(pairs, budget = defaultBudgets.renderer) {
  assert.ok(Array.isArray(pairs) && pairs.length >= 3, 'Metal observer overhead requires at least three alternating pairs.')
  for (const pair of pairs) {
    assert.equal(pair.enabled.completed, pair.baseline.completed)
    assert.equal(pair.enabled.lastByte, pair.baseline.lastByte, 'Metal observation must preserve the actual buffer result.')
    for (const mode of ['baseline', 'enabled']) for (const metric of ['wallMS', 'cpuMS']) {
      assert.ok(Number.isFinite(pair[mode][metric]) && pair[mode][metric] >= 0, `Missing Metal ${mode}.${metric}.`)
    }
  }
  const metrics = Object.fromEntries(['wallMS', 'cpuMS'].map(metric => {
    const ratio = metric === 'wallMS' ? budget.wallRatio : budget.cpuRatio
    const allowance = metric === 'wallMS' ? budget.wallExtraMS : budget.cpuExtraMS
    const margins = pairs.map(pair => pair.enabled[metric] - pair.baseline[metric] * (1 + ratio) - allowance)
    return [metric, { baselineMedian: median(pairs.map(pair => pair.baseline[metric])),
      enabledMedian: median(pairs.map(pair => pair.enabled[metric])), pairedMargins: margins,
      medianMargin: median(margins), ratio, allowanceMS: allowance, passed: median(margins) <= 0 }]
  }))
  return { metrics, passed: Object.values(metrics).every(metric => metric.passed) }
}

export async function measureMetalObserver({ output = '.build/metal-observer-overhead', repeats = 5 } = {}) {
  assert.equal(process.platform, 'darwin', 'Native Metal observer measurement requires macOS.')
  const directory = resolve(output), executableRoot = resolve('.build/gpu-provider'), pairs = []
  assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 15)
  await mkdir(directory, { recursive: true })
  const report = { schemaVersion: 1, observedAt: new Date().toISOString(), outcome: 'running', repeats, commandBuffers: 128,
    measurement: 'Own native Metal subprocess; loop wall time and process CPU exclude device initialization and process startup. Includes synchronous observer writes and completion callbacks.',
    hardwareUtilizationMeasured: false, productionChartLatencyMeasured: false, pairs }
  try {
    report.revision = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim()
    report.host = { platform: process.platform, arch: process.arch, node: process.version, cpu: cpus()[0]?.model }
    report.sourceHashes = Object.fromEntries(await Promise.all(['metal-provider.m', 'metal-provider-proof.m'].map(async name =>
      [name, createHash('sha256').update(await readFile(new URL(`./gpu/${name}`, import.meta.url))).digest('hex')])))
    report.binaryHashes = Object.fromEntries(await Promise.all(['metal-provider-proof', 'metal-provider.dylib'].map(async name =>
      [name, createHash('sha256').update(await readFile(join(executableRoot, name))).digest('hex')])))
    for (let trial = 0; trial < repeats; trial++) {
      const pair = { trial, order: trial % 2 ? ['enabled', 'baseline'] : ['baseline', 'enabled'] }
      for (const mode of pair.order) {
        const scope = mode === 'enabled' ? await createMetalDiagnostic({ root: directory, executableRoot, maxProcesses: 1 }) : null
        const env = { ...process.env, DYLD_INSERT_LIBRARIES: undefined, PERP_METAL_DIAGNOSTIC_DIR: undefined,
          PERP_METAL_DIAGNOSTIC_TOKEN: undefined, PERP_METAL_DIAGNOSTIC_EXECUTABLE_ROOT: undefined, ...scope?.env }
        let result
        try { result = await execute(join(executableRoot, 'metal-provider-proof'), ['128'], { env, timeout: 15_000 }) }
        catch (error) {
          if (error.code === 3 && pairs.length === 0) { report.outcome = 'unsupported'; report.reason = 'Metal device unavailable'; return report }
          throw error
        }
        pair[mode] = JSON.parse(result.stdout.trim())
        assert.equal(pair[mode].completed, 128)
        assert.equal(pair[mode].lastByte, 127)
        if (scope) {
          const recording = await collectMetalDiagnostic({ directory: scope.directory, token: scope.token, gpuPids: [pair[mode].pid] })
          assert.equal(recording.capability.complete, true, 'Metal observer must finish its complete durable lifecycle.')
          assert.equal(recording.stats.completions, 128)
          assert.equal(recording.stats.nativeErrors, 0)
          pair.recording = { directory: scope.directory, capability: recording.capability, stats: recording.stats }
        }
      }
      pairs.push(pair)
    }
    report.assessment = assessMetalObserverPairs(pairs)
    report.outcome = report.assessment.passed ? 'passed' : 'failed'
    assert.equal(report.assessment.passed, true, 'Metal observer exceeded matched renderer recording overhead budgets.')
    return report
  } catch (error) { report.outcome = 'failed'; report.error = error.message; throw error }
  finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' } } })
  console.log(JSON.stringify(await measureMetalObserver({ output: values.output }), null, 2))
}
