import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { median, assessBudgets, summarizePairs, overheadLaunch, assertMeasuredRuntime, runOverhead, defaultBudgets } from '../../scripts/operation-overhead.mjs'

test('runtime resolution uses the official Electron package export without assuming path.txt already exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'electron-package-export-'))
  try {
    const dependency = join(directory, 'node_modules', 'electron')
    await mkdir(dependency, { recursive: true })
    await writeFile(join(dependency, 'index.js'), 'module.exports = "/prepared-by-electron/embedded-runtime"')
    assert.equal(overheadLaunch({ directory }).executable, '/prepared-by-electron/embedded-runtime')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('backend measurements and their worker use the real Electron embedded Node/V8 without creating an app window', { timeout: 10_000 }, async () => {
  const launch = overheadLaunch({ environment: { ...process.env, NODE_OPTIONS: '' } })
  assert.equal(launch.environment.ELECTRON_RUN_AS_NODE, '1')
  const source = `const { Worker } = require('node:worker_threads');
    const runtime = {node:process.version,v8:process.versions.v8,electron:process.versions.electron,executable:process.execPath};
    const worker = new Worker("const {parentPort}=require('node:worker_threads');parentPort.postMessage({node:process.version,v8:process.versions.v8,electron:process.versions.electron,executable:process.execPath})",{eval:true});
    worker.once('message',child=>console.log(JSON.stringify({runtime,child})));`
  const result = await new Promise((resolve, reject) => {
    const child = spawn(launch.executable, ['-e', source], { env: launch.environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', diagnostics = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { diagnostics += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(JSON.parse(output.trim())) : reject(new Error(diagnostics)))
  })
  assert.ok(result.runtime.electron, 'The workload cannot silently fall back to the driver Node executable.')
  assert.deepEqual(result.child, result.runtime)
  assert.equal(overheadLaunch({ desktop: true, environment: { ELECTRON_RUN_AS_NODE: '1' } }).environment.ELECTRON_RUN_AS_NODE, undefined)
})

test('paired comparison uses robust medians and retains operation and message cost', () => {
  const runs=[10,1000,12].flatMap((baseline,index)=>[false,true].map(enabled=>({trial:index,enabled,metrics:{nativeMarket:{wallMS:enabled?[14,15,16][index]:baseline,cpuMS:enabled?[14,15,16][index]:baseline}},
    business:{marketMessages:100},journal:{phases:{nativeMarket:{operations:200,logicalBytes:20000}}}})))
  const result=summarizePairs(runs).phases.nativeMarket
  assert.equal(result.baseline.wallMS,12);assert.equal(result.enabled.wallMS,15)
  assert.equal(result.enabled.extraCPUMS,4)
  assert.equal(result.enabled.extraWallMS,4)
  assert.equal(result.enabled.extraCPUPerOperationMS,.02)
  assert.equal(result.enabled.operationsPerMessage,2)
  assert.equal(median([3,1,2,4]),2.5)
})

test('paired overhead measurements reject different engines and execution modes instead of comparing unlike runtimes', () => {
  const runtime = { node: 'v24.22.0', v8: '15.2-electron', electron: '44.9.0', executable: '/app/Electron', mode: 'electron-as-node' }
  assert.doesNotThrow(() => assertMeasuredRuntime({ ...runtime, pid: 11 }, { ...runtime, pid: 12 }))
  for (const field of ['node', 'v8', 'electron', 'executable', 'mode']) {
    assert.throws(() => assertMeasuredRuntime({ ...runtime, [field]: 'different-runtime' }, runtime), new RegExp(field))
    assert.throws(() => assertMeasuredRuntime({ ...runtime, [field]: undefined }, runtime), /Missing measured runtime identity/)
  }
})

test('CPU, disk and durable ACK regressions fail independent configurable budgets', () => {
  const summary={phases:{nativeMarket:{baseline:{wallMS:100,cpuMS:100},enabled:{wallMS:140,cpuMS:170,extraCPUMS:70,eventLoopP99MS:40,extraCPUPerMessageMS:.1,logicalBytesPerMessage:5000}}},rendererAcknowledgment:{p95MS:60,maxMS:220}}
  const budgets={nativeMarket:{wallRatio:.2,wallExtraMS:10,cpuRatio:.2,cpuExtraMS:10,eventLoopP99MS:25,extraCPUPerMessageMS:.05,logicalBytesPerMessage:4000},rendererAcknowledgment:{p95MS:40,maxMS:200}}
  const failures=assessBudgets(summary,budgets)
  assert.deepEqual(failures.map(value=>value.metric),['wallMS','cpuMS','eventLoopP99MS','extraCPUPerMessageMS','logicalBytesPerMessage','p95MS','maxMS'])
  assert.equal(assessBudgets(summary,{nativeMarket:{wallRatio:1,cpuRatio:1}}).length,0)
})

test('absolute CPU allowance prevents timer noise in tiny message probes from failing per-message budgets', () => {
  const summary={phases:{nativeMarket:{baseline:{wallMS:1,cpuMS:2},enabled:{wallMS:1,cpuMS:3,extraCPUMS:1,extraCPUPerMessageMS:.1}}}}
  assert.deepEqual(assessBudgets(summary,{nativeMarket:{cpuExtraMS:10,extraCPUPerMessageMS:.01}}),[])
})

test('missing required workloads and nonfinite measurements cannot pass CI budgets', () => {
  const missing = assessBudgets({ parameters: { renderer: true }, phases: {} }, {})
  assert.ok(missing.some(value => value.phase === 'backendEndToEnd'))
  assert.ok(missing.some(value => value.phase === 'rendererEndToEnd'))
  assert.ok(missing.some(value => value.phase === 'rendererAcknowledgment'))
  const invalid = assessBudgets({ phases: { cpu: { baseline: { wallMS: NaN, cpuMS: 1 }, enabled: { wallMS: 1, cpuMS: 1 } } } }, { cpu: { wallRatio: 1 } })
  assert.equal(invalid[0].reason, 'missing-or-invalid-measurement')
  assert.throws(() => summarizePairs([{ enabled: false, metrics: { cpu: { wallMS: 1, cpuMS: NaN } } }, { enabled: true, metrics: { cpu: { wallMS: 1, cpuMS: 1 } } }]), /Invalid cpu.cpuMS/)
})

test('configuration typos and invalid storage or ACK budgets cannot silently disable enforcement', () => {
  const summary = { phases: {} }
  assert.throws(() => assessBudgets(summary, { databaseWorkers: { cpuRatio: 1 } }), /Unknown performance workload/)
  assert.throws(() => assessBudgets(summary, { cpu: { cpuRato: 1 } }), /Unknown performance budget/)
  assert.throws(() => assessBudgets(summary, { rendererAcknowledgment: { p95MS: NaN } }), /Invalid performance budget/)
  assert.throws(() => assessBudgets(summary, { storage: { bytesPerOperation: Infinity } }), /Invalid performance budget/)
  assert.throws(() => assessBudgets(summary, { storage: null }), /Invalid performance budget/)
})

test('cached DB work is bounded by added per-operation CPU while the end-to-end CPU guard remains independent', () => {
  const summary = { phases: {
    databaseWorker: { baseline: { wallMS: 10, cpuMS: 10 }, enabled: { wallMS: 12, cpuMS: 40, extraCPUMS:30, journalOperations: 1000, extraCPUPerOperationMS: .03 } },
    backendEndToEnd: { baseline: { wallMS: 100, cpuMS: 100 }, enabled: { wallMS: 105, cpuMS: 130 } },
  } }
  const budget = { databaseWorker: { extraCPUPerOperationMS: .025, cpuExtraMS: 5 }, backendEndToEnd: { cpuRatio: .25 } }
  assert.deepEqual(assessBudgets(summary, budget).map(value => value.metric), ['extraCPUPerOperationMS', 'cpuMS'])
  summary.phases.databaseWorker.enabled.extraCPUPerOperationMS = .02
  summary.phases.databaseWorker.enabled.cpuMS = 30
  summary.phases.backendEndToEnd.enabled.cpuMS = 125
  assert.deepEqual(assessBudgets(summary, budget), [])
  delete summary.phases.databaseWorker.enabled.journalOperations
  assert.equal(assessBudgets(summary, budget)[0].metric, 'journalOperations')
})

test('paired cost divides each CPU delta by its own measured denominator before taking the median', () => {
  const operations = [1000, 1, 10], messages = [1000, 10, 100]
  const runs = operations.flatMap((count, trial) => [false, true].map(enabled => ({
    trial, enabled, metrics: { nativeMarket: { wallMS: 100, cpuMS: enabled ? 110 + trial * 10 : 100 } },
    business: { marketMessages: messages[trial] }, journal: { phases: { nativeMarket: { operations: count, logicalBytes: count * 100 } } },
  })))
  const result = summarizePairs(runs).phases.nativeMarket.enabled
  assert.equal(result.extraCPUMS, 20)
  assert.equal(result.extraCPUPerOperationMS, 3)
  assert.equal(result.extraCPUPerMessageMS, .3)
  assert.equal(result.operationsPerMessage, .1)
  runs[0].business.marketMessages++
  assert.throws(() => summarizePairs(runs), /Unmatched nativeMarket message denominator/)
})

test('equal mode counts cannot hide mismatched or duplicate trial identities', () => {
  const run = (trial, enabled) => ({ trial, enabled, metrics: { cpu: { wallMS: 1, cpuMS: 1 } }, journal: { phases: {} } })
  assert.throws(() => summarizePairs([run(0, false), run(1, true)]), /Unpaired workload/)
  assert.throws(() => summarizePairs([run(0, false), run(0, false), run(0, true), run(1, true)]), /Duplicate paired workload/)
  const result = summarizePairs([run(0, false), run(0, true)]).phases.cpu.enabled
  assert.equal(result.extraCPUPerOperationMS, undefined, 'No recorded operations means per-operation cost is undefined.')
})

test('small-sample CPU allowance uses paired added CPU rather than independent mode medians', () => {
  const summary = { phases: { nativeMarket: { baseline: { wallMS: 1, cpuMS: 100 }, enabled: { wallMS: 1, cpuMS: 105, extraCPUMS: 50, extraCPUPerMessageMS: .1 } } } }
  const budget = { nativeMarket: { cpuExtraMS: 10, extraCPUPerMessageMS: .025 } }
  assert.equal(assessBudgets(summary, budget)[0].metric, 'extraCPUPerMessageMS')
  delete summary.phases.nativeMarket.enabled.extraCPUMS
  assert.equal(assessBudgets(summary, budget)[0].reason, 'missing-or-invalid-paired-measurement')
})

test('a failed native budget retains its original trials and collects separate actual-runtime CPU profiles', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'failed-native-overhead-'))
  try {
    const budgets = { ...defaultBudgets, nativeMarket: { ...defaultBudgets.nativeMarket, wallMS: 0 } }
    const report = await runOverhead({ output: directory, repeats: 2, cycles: 1, contracts: 1, warmup: 1, renderer: false, budgets })
    assert.ok(report.failures.some(failure => failure.phase === 'nativeMarket' && failure.metric === 'wallMS'))
    assert.deepEqual(report.failures, assessBudgets(report, budgets))
    assert.equal(report.runs.length, 4, 'Diagnostic runs cannot enter gated medians.')
    assert.equal(report.parameters.profile, false, 'Original trials must keep their unprofiled configuration.')
    assert.equal(report.failureProfiles.status, 'complete', report.failureProfiles.error)
    assert.deepEqual(report.failureProfiles.runs.map(run => run.enabled), [false, true])
    for (const run of report.failureProfiles.runs) {
      assertMeasuredRuntime(run.runtime, report.runtime.backend)
      assert.deepEqual(run.business, report.runs[0].business)
      const profile = JSON.parse(await readFile(run.profile, 'utf8'))
      assert.ok(profile.nodes.length > 0 && profile.samples.length > 0, 'The actual backend must produce CPU samples.')
    }
    const saved = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))
    assert.deepEqual(saved.failures, report.failures)
    assert.equal(saved.runs.length, 4)
    assert.equal(saved.failureProfiles.runs.length, 2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
