#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
    for(const [metric,ratio,extra] of [['wallMS',budget.wallRatio,budget.wallExtraMS],['cpuMS',budget.cpuRatio,budget.cpuExtraMS],['peakRSSBytes',budget.peakRSSRatio,budget.peakRSSExtraBytes]]){
      if(ratio===undefined)continue
      if (!Number.isFinite(phase.baseline[metric]) || !Number.isFinite(phase.enabled[metric])) {
        failures.push({ phase: name, metric, reason: 'missing-or-invalid-measurement' }); continue
      }
      const allowed=phase.baseline[metric]*(1+ratio)+(extra??0)
      if(phase.enabled[metric]>allowed)failures.push({phase:name,metric,actual:phase.enabled[metric],limit:allowed})
    }
    if (budget.extraCPUPerOperationMS !== undefined && (!Number.isFinite(phase.enabled.journalOperations) || phase.enabled.journalOperations <= 0)) {
      failures.push({ phase: name, metric: 'journalOperations', reason: 'missing-or-invalid-measurement' })
    }
    for(const metric of ['wallMS','eventLoopP99MS','extraCPUPerMessageMS','extraCPUPerOperationMS','logicalBytesPerMessage']){
      if (budget[metric] !== undefined && !Number.isFinite(phase.enabled[metric])) {
        failures.push({ phase: name, metric, reason: 'missing-or-invalid-measurement' }); continue
      }
      if(budget[metric]!==undefined&&!(['extraCPUPerMessageMS','extraCPUPerOperationMS'].includes(metric)&&phase.enabled.cpuMS-phase.baseline.cpuMS<=(budget.cpuExtraMS??0))&&phase.enabled[metric]>budget[metric])failures.push({phase:name,metric,actual:phase.enabled[metric],limit:budget[metric]})
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
  const result={records:0,operations:0,logicalBytes:0,journalBytes:0,byName:{},phases:Object.fromEntries(Object.keys(phases).map(name=>[name,{records:0,operations:0,logicalBytes:0,byName:{}}]))}
  let files=[];try{files=await readdir(directory)}catch(error){if(error.code!=='ENOENT')throw error}
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
async function child(script, parameters, enabled, desktop){
  const environment={...process.env,PERPETUAL_SWAP_OVERHEAD_ROOT:root,PERPETUAL_SWAP_OVERHEAD_ENABLED:enabled?'1':'0',
    PERPETUAL_SWAP_OPERATION_DIR:enabled?join(parameters.directory,'operations'):'',PERPETUAL_SWAP_OPERATION_SESSION:`overhead-${parameters.trial}`,
    PERPETUAL_SWAP_SANDBOX:'1',PERPETUAL_SWAP_ALLOW_NETWORK:'0',NODE_OPTIONS:''}
  delete environment.PERPETUAL_SWAP_OPERATION_PARTICIPANT;delete environment.PERPETUAL_SWAP_OPERATION_ROLE;delete environment.ELECTRON_RUN_AS_NODE
  const executable=desktop?join(root,'node_modules/electron/dist',readFileSync(join(root,'node_modules/electron/path.txt'),'utf8').trim()):process.execPath
  return new Promise((done,reject)=>{
    const process=spawn(executable,[script,JSON.stringify(parameters)],{cwd:root,env:environment,stdio:['ignore','pipe','pipe']})
    let stdout='',stderr='';const timer=setTimeout(()=>process.kill('SIGTERM'),120000)
    process.stdout.on('data',value=>stdout+=value);process.stderr.on('data',value=>stderr=(stderr+value).slice(-12000))
    process.once('error',reject);process.once('close',code=>{clearTimeout(timer);if(code!==0){reject(new Error(`Overhead child failed (${code}): ${stderr}\n${stdout.slice(-2000)}`));return}
      try{done(JSON.parse(stdout.trim().split('\n').at(-1)))}catch(error){reject(new Error(`${error.message}\n${stdout}\n${stderr}`))}})
  })
}
export function summarizePairs(runs){
  const phases={}
  for(const phase of new Set(runs.flatMap(run=>Object.keys(run.metrics)))){
    const groups={baseline:runs.filter(run=>!run.enabled&&run.metrics[phase]),enabled:runs.filter(run=>run.enabled&&run.metrics[phase])}
    assert.ok(groups.baseline.length>0&&groups.baseline.length===groups.enabled.length,`Unpaired workload: ${phase}`)
    for (const run of [...groups.baseline, ...groups.enabled]) {
      for (const metric of ['wallMS', 'cpuMS']) assert.ok(Number.isFinite(run.metrics[phase][metric]) && run.metrics[phase][metric] >= 0, `Invalid ${phase}.${metric}`)
      for (const [metric, value] of Object.entries(run.metrics[phase])) assert.ok(Number.isFinite(value), `Invalid ${phase}.${metric}`)
    }
    const metrics=new Set(Object.values(groups).flatMap(values=>values.flatMap(run=>Object.keys(run.metrics[phase]))))
    metrics.delete('startedAt');metrics.delete('endedAt')
    phases[phase]=Object.fromEntries(Object.entries(groups).map(([name,values])=>[name,Object.fromEntries([...metrics].map(metric=>[metric,median(values.map(run=>run.metrics[phase][metric]??0))]))]))
    const recorded=groups.enabled
    if(recorded.length){phases[phase].enabled.logicalBytesPerMessage=median(recorded.map(run=>run.business.marketMessages?run.journal.phases[phase]?.logicalBytes/run.business.marketMessages:0))
      phases[phase].enabled.extraCPUPerMessageMS=phase==='nativeMarket'?(phases[phase].enabled.cpuMS-phases[phase].baseline.cpuMS)/recorded[0].business.marketMessages:0
      phases[phase].enabled.journalOperations=median(recorded.map(run=>run.journal.phases[phase]?.operations??0))
      phases[phase].enabled.logicalBytes=median(recorded.map(run=>run.journal.phases[phase]?.logicalBytes??0))
      phases[phase].enabled.extraCPUPerOperationMS=(phases[phase].enabled.cpuMS-phases[phase].baseline.cpuMS)/Math.max(1,phases[phase].enabled.journalOperations)
      phases[phase].enabled.logicalBytesPerOperation=phases[phase].enabled.logicalBytes/Math.max(1,phases[phase].enabled.journalOperations)
      if(phase==='nativeMarket'){phases[phase].enabled.operationsPerMessage=phases[phase].enabled.journalOperations/recorded[0].business.marketMessages;phases[phase].enabled.projectedLogicalMiBPerHour=phases[phase].enabled.logicalBytes/phases[phase].enabled.wallMS*3600000/1048576}}
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
  const sourceFiles = ['electron/services/operations.js', 'electron/services/operation-runtime.js', 'electron/services/operation-journal.js', 'electron/services/renderer-operations.js', 'electron/services/market-service.js', 'electron/services/operation-hooks.js', 'electron/services/operation-network-hooks.js',
    'electron/services/worker-operations.js', 'electron/services/operation-worker.js', 'electron/services/recorded-database.js', 'electron/services/indicators.js', 'electron/services/market-store.js', 'electron/services/market-store-worker.js',
    'electron/services/prepared-chart-service.js', 'electron/services/prepared-chart-worker.js', 'src/operation-telemetry.ts', 'src/chart-geometry.ts', 'src/chart-axis.ts', 'src/chart-layout.ts']
  const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => {
    try { return [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')] }
    catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error }
  })))
  const hashes = await sourceHashes()
  const harnessFiles = ['operation-overhead.mjs', 'operation-overhead-workload.mjs', 'operation-overhead-desktop.mjs', 'operation-overhead-preload.mjs']
  const harnessHashes = async () => Object.fromEntries(await Promise.all(harnessFiles.map(async file => [file, createHash('sha256').update(await readFile(join(here, file))).digest('hex')])))
  const harness = await harnessHashes()
  const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'})
  for(let trial=0;trial<repeats;trial++)for(const desktop of renderer?[false,true]:[false]){
    for(const enabled of trial%2?[true,false]:[false,true]){
      const label=`${trial+1}-${desktop?'renderer':'backend'}-${enabled?'enabled':'baseline'}`,parameters={directory:join(directory,label),trial:label,cycles,contracts,warmup,epoch,profile}
      await mkdir(parameters.directory,{recursive:true})
      process.stderr.write(`Operation overhead: ${label}\n`)
      const result=await child(join(here,desktop?'operation-overhead-desktop.mjs':'operation-overhead-workload.mjs'),parameters,enabled,desktop)
      const recording=await journal(join(parameters.directory,'operations'),result.metrics)
      if(enabled){const {summarizeOperations,operationReportHasFailures}=await import(pathToFileURL(join(root,'scripts/operation-report.mjs')).href);const report=await summarizeOperations(join(parameters.directory,'operations'));assert.equal(operationReportHasFailures(report),false,`Overhead measurement lost journal coverage: ${JSON.stringify(report.diagnostics)}`)}
      const run={trial,desktop,enabled,...result,journal:recording};runs.push(run)
      await writeFile(join(parameters.directory,'result.json'),JSON.stringify(run,null,2)+'\n')
      const paired=runs.find(value=>value.trial===trial&&value.desktop===desktop&&value.enabled!==enabled)
      if(paired)assert.deepEqual(run.business,paired.business,'Recording must preserve the exact deterministic business result.')
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
  const summary={schemaVersion:2,revision:git.stdout.trim(),sourceHashes:hashes,harnessHashes:harness,storage,runtime:{node:process.version,platform:process.platform,arch:process.arch},host:{cpu:cpus()[0]?.model,cpuCount:cpus().length,before:hostBefore,after:{loadAverage:loadavg(),freeMemoryBytes:freemem()}},parameters:{repeats,cycles,contracts,warmup,renderer,profile,inputCadenceMS:100,businessClock:'fixed midperiod epoch plus monotonic elapsed time',journalAttribution:'Phase bytes are decoded logical JSONL; stored disk bytes are measured for each complete execution including warmup.'},...summarizePairs(runs),budgets,runs}
  summary.failures=assessBudgets(summary,budgets)
  await writeFile(join(directory,'report.json'),JSON.stringify(summary,null,2)+'\n')
  const rows=Object.entries(summary.phases).map(([phase,value])=>`| ${phase} | ${value.baseline.wallMS.toFixed(2)} | ${value.enabled.wallMS.toFixed(2)} | ${value.baseline.cpuMS.toFixed(2)} | ${value.enabled.cpuMS.toFixed(2)} | ${value.enabled.eventLoopP99MS?.toFixed(2)??'—'} | ${value.enabled.journalOperations} | ${(value.enabled.logicalBytes/1048576).toFixed(2)} |`)
  const stored = Object.entries(storage).map(([name, value]) => `${name}: ${(value.journalBytes / 1048576).toFixed(2)} MiB on disk / ${(value.logicalBytes / 1048576).toFixed(2)} MiB decoded; ${value.bytesPerOperation.toFixed(1)} stored bytes per operation.`).join('\n\n')
  await writeFile(join(directory,'report.md'),`# Operation recording overhead\n\nRevision: ${summary.revision}. ${repeats} alternating baseline/enabled pairs after ${warmup} warmup rounds. Exact business results match in every pair. Values are medians; complete raw trials, source hashes and configured budgets are in report.json.\n\n| Workload | Baseline wall ms | Recorded wall ms | Baseline CPU ms | Recorded CPU ms | Recorded event-loop p99 ms | Operations | Logical MiB |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n\n${stored}\n\nStored bytes include startup and warmup. Per-phase bytes describe decoded JSONL and are not attributed physical disk bytes. Business time starts in the same simulated native period for every child and advances monotonically; performance and operation clocks remain real.\n\n${summary.rendererAcknowledgment?`Renderer durable ACKs: median ${summary.rendererAcknowledgment.medianMS.toFixed(2)} ms; p95 ${summary.rendererAcknowledgment.p95MS.toFixed(2)} ms; maximum ${summary.rendererAcknowledgment.maxMS.toFixed(2)} ms.\n\n`:''}Budget failures: ${summary.failures.length}.\n`)
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
