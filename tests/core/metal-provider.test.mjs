import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir,writeFile,rm,symlink,readFile,lstat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createMetalDiagnostic,collectMetalDiagnostic,stopMetalDiagnostic } from '../../scripts/gpu/metal-provider.mjs'
const root=fileURLToPath(new URL('../../.build/gpu-provider-tests/',import.meta.url)),executableRoot=fileURLToPath(new URL('../../.build/gpu-provider/',import.meta.url))
const native = process.env.PERPETUAL_SWAP_METAL_NATIVE_TESTS === '1'
await mkdir(executableRoot,{recursive:true,mode:0o700})
const pid=12001
async function fixture(t,options={}) {
  const scope=await createMetalDiagnostic({root,executableRoot,...(!native?{libraryPath:fileURLToPath(import.meta.url)}:{}),maxBytes:4096,maxRecords:64,maxProcesses:2,...options})
  t.after(()=>rm(scope.directory,{recursive:true,force:true}));return scope
}
function rows(scope) {
  return [{kind:'loader',schemaVersion:1,provider:'metal-command-buffer',source:'native',measurement:'device-clock',clock:'metal-host-monotonic-seconds',pid,uid:process.getuid(),token:scope.token,hostTime:1,maxBytes:4096,maxRecords:64},
    {kind:'capability',enabled:true,strategy:'public-command-buffer-commit',hostTime:1.1},
    {kind:'commit',sequence:1,hostTime:2},{kind:'commit',sequence:2,hostTime:2.2},
    {kind:'complete',sequence:1,commitHostTime:2,completedHostTime:4.1,gpuStartTime:2.5,gpuEndTime:3.5,status:4,errorCode:0,phase:'completion'},
    {kind:'complete',sequence:2,commitHostTime:2.2,completedHostTime:4.2,gpuStartTime:3,gpuEndTime:4,status:4,errorCode:0,phase:'completion'},
    {kind:'close',reason:'process-exit',admissionEndHostTime:4.5,hostTime:5,observedCommits:2,admittedCommits:2,completions:2,active:0,rejected:0,errors:0,observerErrors:0,writeFailures:0}]
}
async function writeRows(scope,records) {await writeFile(join(scope.directory,'metal-slot-0.jsonl'),records.map(x=>JSON.stringify(x)).join('\n')+'\n',{mode:0o600})}
const collect=(scope,options={})=>collectMetalDiagnostic({directory:scope.directory,token:scope.token,gpuPids:[pid],...options})
test('valid native timing, exact counts and raw-clock windows retain overlapping duration semantics',async t=>{
  const scope=await fixture(t);await writeRows(scope,rows(scope))
  const report=await collect(scope,{captureWindows:[{name:'svg-capture',startHostTime:2.75,endHostTime:3.25}]})
  assert.equal(report.capability.supported,true);assert.equal(report.capability.complete,true)
  assert.deepEqual(report.stats,{pending:0,nativeErrors:0,admittedCommits:2,completions:2,positiveTimings:2,successfulDeviceTimings:2,failedDeviceTimings:0,unavailableTimingBuffers:0,zeroDurationBuffers:0,observedCommits:2,zeroTimingBuffers:0,summedBufferDurationMS:2000})
  assert.equal(report.windows[0].overlappingBuffers,2);assert.equal(report.windows[0].summedBufferOverlapMS,750)
  assert.equal(report.samples[0].gpuStartTime,2.5);assert.equal(report.samples[0].source,'native');assert.equal(report.samples[0].measurement,'device-clock')
})
test('actual GPU handshake is required; a loaded browser process cannot substitute',async t=>{
  const scope=await fixture(t);await writeRows(scope,rows(scope))
  const report=await collect(scope,{gpuPids:[99999]});assert.equal(report.capability.supported,false);assert.equal(report.capability.reason,'actual-gpu-loader-handshake-missing');assert.deepEqual(report.samples,[])
})
test('unclean exit and missing completion remain explicit even when a valid timed prefix exists',async t=>{
  const scope=await fixture(t);const records=rows(scope);records.splice(5,2);await writeRows(scope,records)
  const report=await collect(scope);assert.equal(report.capability.supported,true);assert.equal(report.capability.complete,false);assert.equal(report.stats.observedCommits,null)
  assert.ok(report.processes[0].issues.includes('missing-close-acknowledgement'));assert.ok(report.processes[0].issues.includes('incomplete-command-buffers'))
})
test('admission caps report all observed and rejected calls while preserving accepted pairs',async t=>{
  const scope=await fixture(t);const records=rows(scope);records.splice(-1,0,{kind:'limit',reason:'record-or-byte-admission-cap',hostTime:4.5});Object.assign(records.at(-1),{observedCommits:5,rejected:3});await writeRows(scope,records)
  const report=await collect(scope);assert.equal(report.capability.supported,true);assert.equal(report.capability.complete,false);assert.equal(report.stats.observedCommits,5);assert.equal(report.processes[0].rejected,3);assert.equal(report.stats.completions,2)
})
test('corrupted counters, foreign tokens, duplicate completions and partial tails never produce a complete capability',async t=>{
  for(const mutate of [r=>r.at(-1).completions=99,r=>r[0].token='a'.repeat(32),r=>r.splice(-1,0,r[4])]) {
    const scope=await fixture(t);const records=rows(scope);mutate(records);await writeRows(scope,records);const report=await collect(scope);assert.equal(report.capability.complete,false);assert.equal(report.capability.supported,false)
  }
  const scope=await fixture(t);await writeRows(scope,rows(scope));await writeFile(join(scope.directory,'metal-slot-0.jsonl'),'bad',{flag:'a'});assert.equal((await collect(scope)).capability.complete,false)
})
test('native GPU errors remain recorded with raw status and count, without fabricated success',async t=>{
  const scope=await fixture(t);const records=rows(scope);records[4].status=5;records[4].errorCode=9;records.at(-1).errors=1;await writeRows(scope,records)
  const report=await collect(scope);assert.equal(report.capability.complete,true);assert.equal(report.samples[0].status,'error');assert.equal(report.processes[0].nativeErrors,1)
})
test('symlinks, unknown files and byte-budget violations are rejected without reading outside artifacts',async t=>{
  const scope=await fixture(t);const external=join(scope.directory,'..','outside-'+scope.token);await writeFile(external,'outside',{mode:0o600});t.after(()=>rm(external,{force:true}))
  await symlink(external,join(scope.directory,'metal-slot-0.jsonl'));const report=await collect(scope);assert.equal(report.capability.supported,false);assert.ok(report.issues.includes('unsafe-or-oversized-file'));assert.equal(await readFile(external,'utf8'),'outside')
  const oversized=await fixture(t);await writeFile(join(oversized.directory,'metal-slot-0.jsonl'),'x'.repeat(4097),{mode:0o600});assert.ok((await collect(oversized)).issues.includes('unsafe-or-oversized-file'))
  const unknown=await fixture(t);await mkdir(join(unknown.directory,'unknown'));assert.ok((await collect(unknown)).issues.includes('unknown-diagnostic-artifact'))
})
async function runNative(scope,count=1) {
  return await new Promise((resolve,reject)=>{
    const child=spawn(join(executableRoot,'metal-provider-proof'),[String(count)],{env:{...process.env,...scope.env},stdio:['ignore','pipe','pipe']});let stdout='',stderr=''
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject)
    child.once('exit',(code,signal)=>code===0?resolve({pid:child.pid,stdout,stderr}):reject(new Error(JSON.stringify({code,signal,stderr}))))
  })
}
test('compiled own native subprocess has a real loader/commit/completion/close lifecycle',{skip:!native},async t=>{
  const scope=await fixture(t);const child=await runNative(scope,4);const report=await collect(scope,{gpuPids:[child.pid]})
  assert.equal(report.capability.complete,true,JSON.stringify(report));assert.equal(report.capability.supported,true);assert.equal(report.stats.completions,4);assert.equal(report.stats.observedCommits,4)
  for(const process of report.processes)assert.equal(process.closed,true)
  const info=await lstat(join(scope.directory,'metal-slot-0.jsonl'));assert.equal(info.mode&0o077,0);assert.ok(info.size<=4096)
})
test('compiled own native cap preserves every admitted completion, with exact rejected count',{skip:!native},async t=>{
  const scope=await fixture(t,{maxRecords:8});const child=await runNative(scope,32);const report=await collect(scope,{gpuPids:[child.pid]})
  assert.equal(report.stats.observedCommits,32);assert.ok(report.stats.completions>0);assert.equal(report.processes[0].rejected,32-report.stats.completions);assert.equal(report.processes[0].pending,0);assert.equal(report.processes[0].closed,true)
  assert.equal(report.capability.complete,false);assert.equal(report.processes[0].limited,true);assert.deepEqual(report.processes[0].issues,[])
})

test('live capture stop acknowledges before process exit and leaves later native GPU work outside the closed window',{skip:!native},async t=>{
  const scope=await fixture(t)
  const child=spawn(join(executableRoot,'metal-provider-proof'),['4','300','after-stop'],{env:{...process.env,...scope.env},stdio:['ignore','pipe','pipe']})
  t.after(()=>{if(child.exitCode===null)child.kill()})
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('native-child-failed')))})
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject)})
  const report=await stopMetalDiagnostic({directory:scope.directory,token:scope.token,gpuPids:[child.pid],timeoutMS:2000})
  assert.equal(report.capability.complete,true,JSON.stringify(report));assert.equal(report.stats.observedCommits,4)
  assert.equal(report.processes[0].closeReason,'capture-window-stop');assert.equal(child.exitCode,null)
  const before=await readFile(join(scope.directory,'metal-slot-0.jsonl'),'utf8')
  await exited
  assert.equal(await readFile(join(scope.directory,'metal-slot-0.jsonl'),'utf8'),before,'Later GPU work still succeeds but adds no outside-window records.')
})

test('wrong clock/order, non-contiguous admissions and records outside loader/close never claim trusted timing',async t=>{
  const mutations=[r=>r[4].gpuStartTime=1.9,r=>r[4].gpuEndTime=4.11,r=>r[4].gpuEndTime=2.4,r=>r[2].hostTime=0.5,r=>r[6].hostTime=4.1,r=>r[6].admissionEndHostTime=2.1,r=>{r[3].sequence=3;r[5].sequence=3},r=>r[0].clock='epoch-seconds']
  for(const mutate of mutations) {const scope=await fixture(t);const records=rows(scope);mutate(records);await writeRows(scope,records);const report=await collect(scope);assert.equal(report.capability.supported,false);assert.equal(report.capability.complete,false)}
})
test('failed-only or unavailable GPU intervals cannot satisfy successful hardware timing coverage',async t=>{
  const scope=await fixture(t);const records=rows(scope);records[4].status=5;records[5].status=5;records[6].errors=2;await writeRows(scope,records)
  let report=await collect(scope);assert.equal(report.capability.supported,false);assert.equal(report.stats.successfulDeviceTimings,0);assert.equal(report.stats.failedDeviceTimings,2);assert.equal(report.samples.length,2)
  const absent=await fixture(t);const missing=rows(absent);missing[4].gpuStartTime=0;missing[4].gpuEndTime=0;missing[5].gpuEndTime=0;await writeRows(absent,missing)
  report=await collect(absent);assert.equal(report.capability.supported,false);assert.equal(report.stats.unavailableTimingBuffers,2);assert.equal(report.samples[1].durationMS,null);assert.equal(report.capability.complete,true)
})
test('observer failures prevent trusted successful capability even with positive samples',async t=>{
  const scope=await fixture(t);const records=rows(scope);records[6].observerErrors=1;await writeRows(scope,records)
  const report=await collect(scope);assert.equal(report.capability.supported,false);assert.equal(report.capability.complete,false);assert.ok(report.processes[0].issues.includes('observer-failure'))
})
