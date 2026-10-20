#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cpus, loadavg, freemem } from 'node:os'
import { isOperationJournal, readOperationJournal } from '../electron/services/operation-journal.js'
const root = resolve(process.env.PERPETUAL_SWAP_OVERHEAD_ROOT ?? fileURLToPath(new URL('../', import.meta.url)))
const here = fileURLToPath(new URL('./', import.meta.url))
export const median = values => { const sorted = values.toSorted((a,b)=>a-b), middle=Math.floor(sorted.length/2); return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2 }
// Relative limits have an explicit absolute allowance: a short SQLite query
// cannot fail just because timer resolution or one checkpoint dominates it.
export const defaultBudgets = {
  backendEndToEnd: { wallRatio: .25, wallExtraMS: 50, cpuRatio: .25, cpuExtraMS: 30 },
  rendererEndToEnd: { wallRatio: .25, wallExtraMS: 20, cpuRatio: .35, cpuExtraMS: 20 },
  cpu: { wallRatio: .30, wallExtraMS: 15, cpuRatio: .35, cpuExtraMS: 15 },
  preparedWorker: { wallRatio: .40, wallExtraMS: 20, cpuRatio: .40, cpuExtraMS: 20 },
  // Cached SQLite reads can cost less CPU than their complete worker trace.
  // Bound added trace cost per recorded operation and total backend CPU instead.
  databaseWorker: { wallRatio: .40, wallExtraMS: 20, cpuExtraMS: 20, extraCPUPerOperationMS: .025 },
  nativeMarket: { peakRSSRatio:.25,peakRSSExtraBytes:33554432,wallRatio: .25, wallExtraMS: 20, cpuRatio: .35, cpuExtraMS: 25, eventLoopP99MS: 25, extraCPUPerMessageMS: .025, logicalBytesPerMessage: 4000 },
  renderer: { peakRSSRatio:.25,peakRSSExtraBytes:16777216,wallRatio: .25, wallExtraMS: 20, cpuRatio: .35, cpuExtraMS: 20, eventLoopP99MS: 25 },
  rendererDrain: { wallMS: 250 },
  durableFlush: { wallMS: 100 },
  rendererAcknowledgment: { p95MS: 40, maxMS: 200 },
  storage: { bytesPerOperation: 128 },
}
const phaseBudgetMetrics = new Set(['wallRatio', 'wallExtraMS', 'cpuRatio', 'cpuExtraMS', 'peakRSSRatio', 'peakRSSExtraBytes', 'wallMS', 'eventLoopP99MS', 'extraCPUPerMessageMS', 'extraCPUPerOperationMS', 'logicalBytesPerMessage'])
const rendererPhases = new Set(['renderer', 'rendererDrain', 'rendererEndToEnd'])
const relativeBudgetMethod = 'median-matched-budget-margin'
function pairedWorkload(runs, phase, repeats) {
  assert.ok(Array.isArray(runs) && runs.length > 0, `Missing paired workload trials: ${phase}`)
  for (const run of runs) {
    assert.ok(typeof run.desktop === 'boolean' && typeof run.enabled === 'boolean', `Invalid paired execution mode: ${phase}`)
    if (run.metrics?.[phase]) assert.equal(run.desktop, rendererPhases.has(phase), `Unmatched paired execution mode: ${phase}`)
  }
  const selected = runs.filter(run => run.desktop === rendererPhases.has(phase)), byPair = new Map()
  assert.ok(selected.length > 0, `Missing paired workload trials: ${phase}`)
  for (const run of selected) {
    assert.ok(run.metrics?.[phase], `Missing paired workload measurement: ${phase}`)
    for (const metric of ['wallMS', 'cpuMS']) assert.ok(Number.isFinite(run.metrics[phase][metric]) && run.metrics[phase][metric] >= 0, `Invalid ${phase}.${metric}`)
    for (const [metric, value] of Object.entries(run.metrics[phase])) assert.ok(Number.isFinite(value), `Invalid ${phase}.${metric}`)
    assert.ok(Number.isInteger(run.trial) && run.trial >= 0, `Invalid paired trial: ${phase}`)
    const pair = byPair.get(run.trial) ?? {}, mode = run.enabled ? 'enabled' : 'baseline'
    assert.equal(pair[mode], undefined, `Duplicate paired workload: ${phase}/${run.trial}/${mode}`)
    pair[mode] = run; byPair.set(run.trial, pair)
  }
  const pairs = [...byPair.values()]
  for (const pair of pairs) assert.ok(pair.baseline && pair.enabled, `Unpaired workload: ${phase}`)
  if (repeats !== undefined) {
    assert.ok(Number.isInteger(repeats) && repeats > 0 && pairs.length === repeats, `Missing paired workload trials: ${phase}`)
    for (let trial = 0; trial < repeats; trial++) assert.ok(byPair.has(trial), `Missing paired trial: ${phase}/${trial}`)
  }
  return pairs
}
function validateBudgets(budgets) {
  if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)) throw new TypeError('Performance budgets must be an object.')
  for (const [name, budget] of Object.entries(budgets)) {
    if (!Object.hasOwn(defaultBudgets, name)) throw new TypeError(`Unknown performance workload: ${name}`)
    if (!budget || typeof budget !== 'object' || Array.isArray(budget)) throw new TypeError(`Invalid performance budget: ${name}`)
    const allowed = name === 'rendererAcknowledgment' ? new Set(['p95MS', 'maxMS']) : name === 'storage' ? new Set(['bytesPerOperation']) : phaseBudgetMetrics
    for (const [metric, value] of Object.entries(budget)) {
      if (!allowed.has(metric)) throw new TypeError(`Unknown performance budget: ${name}.${metric}`)
      if (!Number.isFinite(value) || value < 0) throw new TypeError(`Invalid performance budget: ${name}.${metric}`)
    }
  }
}
export function assessBudgets(summary, budgets=defaultBudgets) {
  validateBudgets(budgets)
  const failures=[]
  const backend = ['cpu', 'preparedWorker', 'databaseWorker', 'nativeMarket', 'durableFlush', 'backendEndToEnd']
  const renderer = ['renderer', 'rendererDrain', 'rendererEndToEnd']
  const expected = summary.parameters ? [...backend, ...(summary.parameters.renderer ? renderer : [])]
    : Object.keys(budgets).filter(name => !['rendererAcknowledgment', 'storage'].includes(name))
  for (const name of new Set([...expected, ...Object.keys(budgets).filter(name => !['rendererAcknowledgment', 'storage'].includes(name) && summary.phases[name])])) {
    const phase=summary.phases[name], budget=budgets[name] ?? {}
    if (!phase) { failures.push({ phase: name, reason: 'missing-required-workload' }); continue }
    let invalid = false
    for (const mode of ['baseline', 'enabled']) for (const metric of ['wallMS', 'cpuMS']) {
      if (!Number.isFinite(phase[mode]?.[metric]) || phase[mode][metric] < 0) {
        failures.push({ phase: name, mode, metric, reason: 'missing-or-invalid-measurement' }); invalid = true
      }
    }
    if (invalid) continue
    let pairs, pairError
    if (['wallRatio', 'cpuRatio', 'peakRSSRatio'].some(metric => budget[metric] !== undefined)) {
      try { pairs = pairedWorkload(summary.runs, name, summary.parameters?.repeats) }
      catch (error) { pairError = error.message }
    }
    for(const [metric,ratio,extra=0] of [['wallMS',budget.wallRatio,budget.wallExtraMS],['cpuMS',budget.cpuRatio,budget.cpuExtraMS],['peakRSSBytes',budget.peakRSSRatio,budget.peakRSSExtraBytes]]){
      if(ratio===undefined)continue
      if (pairError) {
        failures.push({ phase: name, metric, method: relativeBudgetMethod, reason: 'missing-or-invalid-paired-measurement', detail: pairError }); continue
      }
      const margins = pairs.map(({ baseline, enabled }) => {
        const before = baseline.metrics[name][metric], after = enabled.metrics[name][metric]
        return Number.isFinite(before) && before >= 0 && Number.isFinite(after) && after >= 0 ? after - (before * (1 + ratio) + extra) : NaN
      })
      if (!Number.isFinite(phase.baseline[metric]) || phase.baseline[metric] < 0 || !Number.isFinite(phase.enabled[metric]) || phase.enabled[metric] < 0 || !margins.every(Number.isFinite)) {
        failures.push({ phase: name, metric, method: relativeBudgetMethod, reason: 'missing-or-invalid-paired-measurement' }); continue
      }
      const medianBudgetMargin = median(margins)
      if (medianBudgetMargin > 0) failures.push({ phase: name, metric, method: relativeBudgetMethod, medianBudgetMargin, allowedMargin: 0, ratio, extraAllowance: extra,
        descriptiveMedians: { baseline: phase.baseline[metric], enabled: phase.enabled[metric] } })
    }
    if (budget.extraCPUPerOperationMS !== undefined && (!Number.isFinite(phase.enabled.journalOperations) || phase.enabled.journalOperations <= 0)) {
      failures.push({ phase: name, metric: 'journalOperations', reason: 'missing-or-invalid-measurement' })
    }
    const pairedCPURequired = budget.extraCPUPerMessageMS !== undefined || budget.extraCPUPerOperationMS !== undefined
    if (pairedCPURequired && !Number.isFinite(phase.enabled.extraCPUMS)) {
      failures.push({ phase: name, metric: 'extraCPUMS', reason: 'missing-or-invalid-paired-measurement' })
    }
    for(const metric of ['wallMS','eventLoopP99MS','extraCPUPerMessageMS','extraCPUPerOperationMS','logicalBytesPerMessage']){
      if (budget[metric] !== undefined && !Number.isFinite(phase.enabled[metric])) {
        failures.push({ phase: name, metric, reason: 'missing-or-invalid-measurement' }); continue
      }
      if(budget[metric]!==undefined&&!(['extraCPUPerMessageMS','extraCPUPerOperationMS'].includes(metric)&&phase.enabled.extraCPUMS<=(budget.cpuExtraMS??0))&&phase.enabled[metric]>budget[metric])failures.push({phase:name,metric,actual:phase.enabled[metric],limit:budget[metric]})
    }
  }
  const ack=summary.rendererAcknowledgment,budget=budgets.rendererAcknowledgment
  if (summary.parameters?.renderer && (!ack || !Number.isInteger(ack.batches) || ack.batches < 1)) failures.push({ phase: 'rendererAcknowledgment', reason: 'missing-required-acknowledgments' })
  if(ack&&budget)for(const metric of ['p95MS','maxMS']) {
    if (budget[metric] === undefined) continue
    if (!Number.isFinite(ack[metric]) || ack[metric] < 0) failures.push({ phase: 'rendererAcknowledgment', metric, reason: 'missing-or-invalid-measurement' })
    else if(ack[metric]>budget[metric])failures.push({phase:'rendererAcknowledgment',metric,actual:ack[metric],limit:budget[metric]})
  }
  if (budgets.storage?.bytesPerOperation !== undefined) {
    for (const workload of summary.parameters?.renderer ? ['backend', 'renderer'] : ['backend']) {
      const stored = summary.storage?.[workload]?.bytesPerOperation
      if (!Number.isFinite(stored) || stored < 0) failures.push({ phase: 'storage', workload, reason: 'missing-or-invalid-measurement' })
      else if (stored > budgets.storage.bytesPerOperation) failures.push({ phase: 'storage', workload, metric: 'bytesPerOperation', actual: stored, limit: budgets.storage.bytesPerOperation })
    }
  }
  return failures
}
async function journal(directory, phases){
  const result={records:0,operations:0,logicalBytes:0,journalBytes:0,byName:{},executions:[],phases:Object.fromEntries(Object.keys(phases).map(name=>[name,{records:0,operations:0,logicalBytes:0,byName:{}}]))}
  let files=[];try{files=await readdir(directory)}catch(error){if(error.code!=='ENOENT')throw error}
  for (const file of files.filter(file => file.endsWith('.health.json'))) {
    const health = JSON.parse(await readFile(join(directory, file), 'utf8'))
    result.executions.push({ executionId: health.executionId, role: health.role, runtime: health.runtime })
  }
  for(const file of files.filter(isOperationJournal)){
    result.journalBytes += (await stat(join(directory, file))).size
    const lines=createInterface({input:readOperationJournal(join(directory,file)),crlfDelay:Infinity})
    for await(const line of lines){
      const entry=JSON.parse(line),bytes=Buffer.byteLength(line)+1
      result.records++;result.logicalBytes+=bytes
      if(entry.phase==='end'){result.operations++;result.byName[entry.name]=(result.byName[entry.name]??0)+1}
      for(const [name,phase] of Object.entries(phases))if(entry.startedAt>=phase.startedAt&&entry.startedAt<=phase.endedAt){const group=result.phases[name];group.records++;group.logicalBytes+=bytes;group.operations+=Number(entry.phase==='end');if(entry.phase==='end')group.byName[entry.name]=(group.byName[entry.name]??0)+1}
    }
  }
  return result
}
export function overheadLaunch({ directory = root, desktop = false, environment = process.env } = {}) {
  const executable = createRequire(join(directory, 'package.json'))('electron')
  const env = { ...environment }
  if (desktop) delete env.ELECTRON_RUN_AS_NODE
  else env.ELECTRON_RUN_AS_NODE = '1'
  return { executable, environment: env }
}
export function assertMeasuredRuntime(actual, expected) {
  for (const field of ['node', 'v8', 'electron', 'executable', 'mode']) {
    assert.ok(typeof actual?.[field] === 'string' && actual[field], `Missing measured runtime identity: ${field}`)
    assert.equal(actual[field], expected?.[field], `Paired workloads must use the same actual ${field} runtime.`)
  }
}
async function child(script, parameters, enabled, desktop){
  const environment={...process.env,PERPETUAL_SWAP_OVERHEAD_ROOT:root,PERPETUAL_SWAP_OVERHEAD_ENABLED:enabled?'1':'0',
    PERPETUAL_SWAP_OPERATION_DIR:enabled?join(parameters.directory,'operations'):'',PERPETUAL_SWAP_OPERATION_SESSION:`overhead-${parameters.trial}`,
    PERPETUAL_SWAP_SANDBOX:'1',PERPETUAL_SWAP_ALLOW_NETWORK:'0',NODE_OPTIONS:''}
  delete environment.PERPETUAL_SWAP_OPERATION_PARTICIPANT;delete environment.PERPETUAL_SWAP_OPERATION_ROLE
  // Backend workers run inside Electron's embedded Node/V8 in the real app.
  // Matching only process.version can otherwise measure a different V8 build.
  const launch = overheadLaunch({ desktop, environment })
  return new Promise((done,reject)=>{
    const process=spawn(launch.executable,[script,JSON.stringify(parameters)],{cwd:root,env:launch.environment,stdio:['ignore','pipe','pipe']})
    let stdout='',stderr='';const timer=setTimeout(()=>process.kill('SIGTERM'),120000)
    process.stdout.on('data',value=>stdout+=value);process.stderr.on('data',value=>stderr=(stderr+value).slice(-12000))
    process.once('error',reject);process.once('close',code=>{clearTimeout(timer);if(code!==0){reject(new Error(`Overhead child failed (${code}): ${stderr}\n${stdout.slice(-2000)}`));return}
      try{done(JSON.parse(stdout.trim().split('\n').at(-1)))}catch(error){reject(new Error(`${error.message}\n${stdout}\n${stderr}`))}})
  })
}
export function summarizePairs(runs){
  const phases={}
  for(const phase of new Set(runs.flatMap(run=>Object.keys(run.metrics)))){
    const pairs = pairedWorkload(runs, phase)
    const groups={baseline:pairs.map(pair=>pair.baseline),enabled:pairs.map(pair=>pair.enabled)}
    const metrics=new Set(Object.values(groups).flatMap(values=>values.flatMap(run=>Object.keys(run.metrics[phase]))))
    metrics.delete('startedAt');metrics.delete('endedAt')
    phases[phase]=Object.fromEntries(Object.entries(groups).map(([name,values])=>[name,Object.fromEntries([...metrics].map(metric=>[metric,median(values.map(run=>run.metrics[phase][metric]??0))]))]))
    const samples = pairs.map(({ baseline, enabled }) => ({
      cpuDeltaMS: enabled.metrics[phase].cpuMS - baseline.metrics[phase].cpuMS,
      wallDeltaMS: enabled.metrics[phase].wallMS - baseline.metrics[phase].wallMS,
      operations: enabled.journal.phases[phase]?.operations ?? 0,
      logicalBytes: enabled.journal.phases[phase]?.logicalBytes ?? 0,
      wallMS: enabled.metrics[phase].wallMS,
      ...(phase === 'nativeMarket' ? { messages: enabled.business.marketMessages } : {}),
    }))
    const measured = phases[phase].enabled
    measured.extraCPUMS = median(samples.map(value => value.cpuDeltaMS))
    measured.extraWallMS = median(samples.map(value => value.wallDeltaMS))
    measured.journalOperations = median(samples.map(value => value.operations))
    measured.logicalBytes = median(samples.map(value => value.logicalBytes))
    if (samples.every(value => value.operations > 0)) {
      measured.extraCPUPerOperationMS = median(samples.map(value => value.cpuDeltaMS / value.operations))
      measured.logicalBytesPerOperation = median(samples.map(value => value.logicalBytes / value.operations))
    }
    if (phase === 'nativeMarket') {
      for (const { baseline, enabled } of pairs) {
        assert.ok(Number.isInteger(enabled.business.marketMessages) && enabled.business.marketMessages > 0, 'Invalid nativeMarket message denominator')
        assert.equal(enabled.business.marketMessages, baseline.business.marketMessages, 'Unmatched nativeMarket message denominator')
      }
      measured.logicalBytesPerMessage = median(samples.map(value => value.logicalBytes / value.messages))
      measured.extraCPUPerMessageMS = median(samples.map(value => value.cpuDeltaMS / value.messages))
      measured.operationsPerMessage = median(samples.map(value => value.operations / value.messages))
      measured.projectedLogicalMiBPerHour = median(samples.map(value => value.logicalBytes / value.wallMS * 3600000 / 1048576))
    }
  }
  const latencies=runs.filter(run=>run.enabled).flatMap(run=>run.receiver?.latencies.map(value=>value.durationMS)??[]).toSorted((a,b)=>a-b)
  return {phases,...(latencies.length?{rendererAcknowledgment:{batches:latencies.length,medianMS:median(latencies),p95MS:latencies[Math.min(latencies.length-1,Math.ceil(latencies.length*.95)-1)],maxMS:latencies.at(-1)}}:{})}
}
export async function runOverhead({output, repeats=5, cycles=20, contracts=130, warmup=2, renderer=true,profile=false,budgets=defaultBudgets}={}){
  validateBudgets(budgets)
  assert.ok(Number.isInteger(repeats)&&repeats>=2,'At least two alternating pairs are required.')
  for(const [name,value] of Object.entries({cycles,contracts,warmup}))assert.ok(Number.isInteger(value)&&value>0,`${name} must be a positive integer.`)
  const directory=resolve(output??join(root,'.build/operation-overhead',new Date().toISOString().replaceAll(':','').replaceAll('.','')))
  await mkdir(directory,{recursive:true})
  const hostBefore={loadAverage:loadavg(),freeMemoryBytes:freemem()},runs=[],epoch=Math.floor(Date.now()/300000)*300000
  const sourceFiles = ['electron/services/operations.js', 'electron/services/operation-runtime.js', 'electron/services/operation-journal.js', 'electron/services/renderer-operations.js', 'electron/services/market-service.js', 'electron/services/operation-hooks.js', 'electron/services/operation-network-hooks.js', 'electron/services/network-operations.js', 'electron/services/realtime-public-market.js',
    'electron/services/worker-operations.js', 'electron/services/operation-worker.js', 'electron/services/recorded-database.js', 'electron/services/indicators.js', 'electron/services/market-store.js', 'electron/services/market-store-worker.js',
    'electron/services/prepared-chart-service.js', 'electron/services/prepared-chart-worker.js', 'src/operation-telemetry.ts', 'src/chart-geometry.ts', 'src/chart-axis.ts', 'src/chart-layout.ts']
  const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => {
    try { return [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')] }
    catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error }
  })))
  const hashes = await sourceHashes()
  const harnessFiles = ['operation-overhead.mjs', 'operation-overhead-workload.mjs', 'operation-overhead-memory.mjs', 'operation-overhead-desktop.mjs', 'operation-overhead-preload.mjs']
  const harnessHashes = async () => Object.fromEntries(await Promise.all(harnessFiles.map(async file => [file, createHash('sha256').update(await readFile(join(here, file))).digest('hex')])))
  const harness = await harnessHashes()
  const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'})
  for(let trial=0;trial<repeats;trial++)for(const desktop of renderer?[false,true]:[false]){
    for(const enabled of trial%2?[true,false]:[false,true]){
      const label=`${trial+1}-${desktop?'renderer':'backend'}-${enabled?'enabled':'baseline'}`,parameters={directory:join(directory,label),trial:label,cycles,contracts,warmup,epoch,profile}
      await mkdir(parameters.directory,{recursive:true})
      process.stderr.write(`Operation overhead: ${label}\n`)
      const result=await child(join(here,desktop?'operation-overhead-desktop.mjs':'operation-overhead-workload.mjs'),parameters,enabled,desktop)
      assert.ok(result.runtime?.electron && result.runtime.v8 && result.runtime.executable, 'The measured child must identify its real Electron/Node/V8 runtime.')
      assert.equal(result.runtime.mode, desktop ? 'electron-main-and-renderer' : 'electron-as-node', 'The measured workload must use its production execution mode.')
      const recording=await journal(join(parameters.directory,'operations'),result.metrics)
      if (enabled) {
        for (const execution of recording.executions) for (const field of ['node', 'v8', 'electron']) assert.equal(execution.runtime?.[field], result.runtime[field], `The ${execution.role} execution must use the measured production ${field} runtime.`)
        if (!desktop) for (const role of ['market-reader', 'market-writer', 'prepared-chart']) assert.ok(recording.executions.some(execution => execution.role === role), `Missing actual backend worker runtime evidence: ${role}`)
      }
      if(enabled){const {summarizeOperations,operationReportHasFailures}=await import(pathToFileURL(join(root,'scripts/operation-report.mjs')).href);const report=await summarizeOperations(join(parameters.directory,'operations'));assert.equal(operationReportHasFailures(report),false,`Overhead measurement lost journal coverage: ${JSON.stringify(report.diagnostics)}`)}
      const run={trial,desktop,enabled,...result,journal:recording};runs.push(run)
      await writeFile(join(parameters.directory,'result.json'),JSON.stringify(run,null,2)+'\n')
      const paired=runs.find(value=>value.trial===trial&&value.desktop===desktop&&value.enabled!==enabled)
      if(paired){assertMeasuredRuntime(run.runtime,paired.runtime);assert.deepEqual(run.business,paired.business,'Recording must preserve the exact deterministic business result.')}
    }
  }
  assert.deepEqual(await sourceHashes(), hashes, 'Benchmark source files changed while the paired measurements were running.')
  assert.deepEqual(await harnessHashes(), harness, 'Benchmark harness changed while paired measurements were running.')
  const storage = Object.fromEntries((renderer ? [false, true] : [false]).map(desktop => {
    const values = runs.filter(run => run.enabled && run.desktop === desktop)
    return [desktop ? 'renderer' : 'backend', {
      operations: median(values.map(run => run.journal.operations)),
      logicalBytes: median(values.map(run => run.journal.logicalBytes)),
      journalBytes: median(values.map(run => run.journal.journalBytes)),
      bytesPerOperation: median(values.map(run => run.journal.journalBytes / run.journal.operations)),
      storedToLogicalRatio: median(values.map(run => run.journal.journalBytes / run.journal.logicalBytes)),
    }]
  }))
  const runtime = { driver: { node: process.version, v8: process.versions.v8, executable: process.execPath, platform: process.platform, arch: process.arch },
    backend: runs.find(run => !run.desktop).runtime, ...(renderer ? { renderer: runs.find(run => run.desktop).runtime } : {}) }
  for (const run of runs) assertMeasuredRuntime(run.runtime, run.desktop ? runtime.renderer : runtime.backend)
  const summary={schemaVersion:3,estimators:{relativeBudgets:relativeBudgetMethod},revision:git.stdout.trim(),sourceHashes:hashes,harnessHashes:harness,storage,runtime,host:{cpu:cpus()[0]?.model,cpuCount:cpus().length,before:hostBefore,after:{loadAverage:loadavg(),freeMemoryBytes:freemem()}},parameters:{repeats,cycles,contracts,warmup,renderer,profile,inputCadenceMS:100,businessClock:'fixed midperiod epoch plus monotonic elapsed time',journalAttribution:'Phase bytes are decoded logical JSONL; stored disk bytes are measured for each complete execution including warmup.'},...summarizePairs(runs),budgets,runs}
  summary.failures=assessBudgets(summary,budgets)
  await writeFile(join(directory,'report.json'),JSON.stringify(summary,null,2)+'\n')
  // Preserve the gated trials first. Profiles are a separate diagnostic pair:
  // their extra inspector cost cannot replace a failed sample or change its gate.
  if (!profile && summary.failures.some(failure => failure.phase === 'nativeMarket')) {
    summary.failureProfiles = { purpose: 'diagnostic-only; original trials and failures remain authoritative', status: 'collecting', runs: [] }
    try {
      for (const enabled of [false, true]) {
        const label = `diagnostic-native-${enabled ? 'enabled' : 'baseline'}`
        const parameters = { directory: join(directory, label), trial: label, cycles, contracts, warmup, epoch, profile: true }
        await mkdir(parameters.directory, { recursive: true })
        process.stderr.write(`Operation overhead diagnostic: ${label}\n`)
        const result = await child(join(here, 'operation-overhead-workload.mjs'), parameters, enabled, false)
        assertMeasuredRuntime(result.runtime, runtime.backend)
        assert.deepEqual(result.business, runs.find(run => !run.desktop).business, 'Diagnostic workloads must preserve the gated business result.')
        const recording = await journal(join(parameters.directory, 'operations'), result.metrics)
        if (enabled) {
          const { summarizeOperations, operationReportHasFailures } = await import(pathToFileURL(join(root, 'scripts/operation-report.mjs')).href)
          const report = await summarizeOperations(join(parameters.directory, 'operations'))
          assert.equal(operationReportHasFailures(report), false, 'Failure profiling must not lose journal coverage.')
        }
        const diagnostic = { enabled, ...result, journal: recording, profile: join(parameters.directory, 'native-market.cpuprofile') }
        await writeFile(join(parameters.directory, 'result.json'), JSON.stringify(diagnostic, null, 2) + '\n')
        summary.failureProfiles.runs.push(diagnostic)
      }
      assert.deepEqual(await sourceHashes(), hashes, 'Sources changed during failure profiling.')
      assert.deepEqual(await harnessHashes(), harness, 'Harness changed during failure profiling.')
      summary.failureProfiles.status = 'complete'
    } catch (error) {
      summary.failureProfiles.status = 'failed'
      summary.failureProfiles.error = error.stack ?? String(error)
      process.stderr.write(`Operation overhead diagnostic failed: ${error.message}\n`)
    }
    await writeFile(join(directory, 'report.json'), JSON.stringify(summary, null, 2) + '\n')
  }
  const rows=Object.entries(summary.phases).map(([phase,value])=>`| ${phase} | ${value.baseline.wallMS.toFixed(2)} | ${value.enabled.wallMS.toFixed(2)} | ${value.baseline.cpuMS.toFixed(2)} | ${value.enabled.cpuMS.toFixed(2)} | ${value.enabled.eventLoopP99MS?.toFixed(2)??'—'} | ${value.enabled.journalOperations} | ${(value.enabled.logicalBytes/1048576).toFixed(2)} |`)
  const stored = Object.entries(storage).map(([name, value]) => `${name}: ${(value.journalBytes / 1048576).toFixed(2)} MiB on disk / ${(value.logicalBytes / 1048576).toFixed(2)} MiB decoded; ${value.bytesPerOperation.toFixed(1)} stored bytes per operation.`).join('\n\n')
  const runtimeDescription = `Driver: Node ${runtime.driver.node}, V8 ${runtime.driver.v8}. The driver runtime is not the measured backend. Backend: Electron ${runtime.backend.electron}, Node ${runtime.backend.node}, V8 ${runtime.backend.v8}, ${runtime.backend.mode}; executable: ${runtime.backend.executable}. Each recorded backend worker's own health verifies the same Node/V8/Electron build.\n\n` + (runtime.renderer ? `Renderer: Electron ${runtime.renderer.electron}, Node ${runtime.renderer.node}, V8 ${runtime.renderer.v8}; executable: ${runtime.renderer.executable}.\n\n` : '') + (summary.failureProfiles ? `Native-market failure profiles: ${summary.failureProfiles.status}. The separate diagnostic-only baseline/recorded pair cannot replace the original trials or change their failures. See report.json and diagnostic-native-*/native-market.cpuprofile.\n\n` : '')
  await writeFile(join(directory,'report.md'),`# Operation recording overhead\n\n${runtimeDescription}Revision: ${summary.revision}. ${repeats} alternating baseline/enabled pairs after ${warmup} warmup rounds. Exact business results match in every pair. Baseline and recorded columns show each group's descriptive median. Relative CPU, wall and memory gates instead evaluate the full matched margin for every trial: recorded - baseline * (1 + ratio) - absolute allowance. A positive median margin fails; zero passes. The retained raw trials are required to recompute margins for caller-supplied budgets. This estimator corrects the paired comparison and does not establish a performance improvement. Added CPU and wall costs are medians of matched-pair differences. Per-message and per-operation added CPU divide each pair's difference by its own measured count before taking the median. Phase CPU is whole-process usage inside its window, including worker threads, V8/libuv and possibly earlier journal drain; normalization does not claim exclusive operation CPU. Complete raw trials, source hashes and configured budgets are in report.json.\n\n| Workload | Baseline wall ms | Recorded wall ms | Baseline CPU ms | Recorded CPU ms | Recorded event-loop p99 ms | Operations | Logical MiB |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n\n${stored}\n\nStored bytes include startup and warmup. Per-phase bytes describe decoded JSONL and are not attributed physical disk bytes. Business time starts in the same simulated native period for every child and advances monotonically; performance and operation clocks remain real.\n\n${summary.rendererAcknowledgment?`Renderer durable ACKs: median ${summary.rendererAcknowledgment.medianMS.toFixed(2)} ms; p95 ${summary.rendererAcknowledgment.p95MS.toFixed(2)} ms; maximum ${summary.rendererAcknowledgment.maxMS.toFixed(2)} ms.\n\n`:''}Budget failures: ${summary.failures.length}.\n`)
  return {directory,...summary}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.includes('--help')){console.log('Usage: node scripts/operation-overhead.mjs [--quick] [--no-renderer] [--profile] [--repeats N] [--cycles N] [--contracts N] [--warmup N] [--output DIRECTORY] [--budgets JSON_FILE]\nDefaults: five alternating fresh-process baseline/recorded pairs;130 native contracts;20 cycles;two warmup rounds;real hidden Electron renderer. Reports retain raw trials, exact business equality and journal completeness. A violated configured budget exits1. --profile writes native-market.cpuprofile for each backend trial.');process.exit(0)}
    const args=process.argv.slice(2),options={};for(let index=0;index<args.length;index++){
      const key=args[index]
      if(key==='--no-renderer')options.renderer=false
      else if(key==='--profile')options.profile=true
      else if(key==='--quick'){options.repeats=3;options.cycles=8}
      else if(['--output','--repeats','--cycles','--contracts','--warmup','--budgets'].includes(key)){
        const value=args[++index];assert.ok(value,`${key} requires a value`);const name=key.slice(2);options[name]=['output','budgets'].includes(name)?value:Number(value)
      }else throw new Error(`Unknown overhead argument: ${key}`)
    }
    if(options.budgets) {
      const overrides=JSON.parse(await readFile(resolve(options.budgets),'utf8'));validateBudgets(overrides)
      options.budgets=Object.fromEntries(Object.entries(defaultBudgets).map(([name, value])=>[name,{...value,...overrides[name]}]))
    }
    const report=await runOverhead(options);console.log(JSON.stringify({directory:report.directory,phases:report.phases,rendererAcknowledgment:report.rendererAcknowledgment,failures:report.failures},null,2));if(report.failures.length)process.exitCode=1
  }catch(error){console.error(error.stack??error);process.exitCode=1}
}
