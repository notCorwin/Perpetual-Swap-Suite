import { constants } from 'node:fs'
import { mkdir, mkdtemp, lstat, realpath, open, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const kind='perp-metal-diagnostic', integer=value=>Number.isSafeInteger(value)&&value>=0
const time=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0
const uid=()=>process.getuid?.()
const bounded=(value,min,max)=>integer(value)&&value>=min&&value<=max
const privateInfo=info=>info.uid===uid()&&(info.mode&0o077)===0
async function safeRead(path,maxBytes) {
  const before=await lstat(path)
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||!privateInfo(before)||before.size>maxBytes)throw new Error('unsafe-or-oversized-file')
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try {
    const info=await file.stat()
    if(info.ino!==before.ino||info.dev!==before.dev||info.size>maxBytes)throw new Error('file-identity-changed')
    const buffer=Buffer.alloc(maxBytes+1);let used=0
    while(used<buffer.length){const {bytesRead}=await file.read(buffer,used,buffer.length-used,used);if(!bytesRead)break;used+=bytesRead}
    if(used>maxBytes||(await file.stat()).size!==used)throw new Error('file-grew-or-cap-exceeded')
    return buffer.subarray(0,used).toString('utf8')
  } finally {await file.close()}
}
export async function createMetalDiagnostic({root,executableRoot,libraryPath=fileURLToPath(new URL('../../.build/gpu-provider/metal-provider.dylib',import.meta.url)),maxBytes=1024*1024,maxRecords=4096,maxProcesses=8}={}) {
  if(process.platform!=='darwin')throw new Error('metal-diagnostics-require-macos')
  if(!bounded(maxBytes,4096,16*1024*1024)||!bounded(maxRecords,8,65536)||!bounded(maxProcesses,1,32))throw new Error('invalid-budget')
  executableRoot=await realpath(executableRoot)
  if(!(await lstat(executableRoot)).isDirectory())throw new Error('invalid-executable-root')
  root=resolve(root);await mkdir(root,{recursive:true})
  const directory=await mkdtemp(join(root,'metal-diagnostic-')),token=randomBytes(16).toString('hex')
  const manifest={kind,schemaVersion:1,token,uid:uid(),executableRoot,maxBytes,maxRecords,maxProcesses}
  await writeFile(join(directory,'diagnostic.json'),JSON.stringify(manifest)+'\n',{flag:'wx',mode:0o600})
  await writeFile(join(directory,'stop.request'),'',{flag:'wx',mode:0o600})
  const library=await realpath(libraryPath)
  const info=await lstat(library)
  if(!info.isFile()||info.uid!==uid()||(info.mode&0o022))throw new Error('unsafe-provider-library')
  return {directory,token,env:{DYLD_INSERT_LIBRARIES:library,PERP_METAL_DIAGNOSTIC_DIR:directory,PERP_METAL_DIAGNOSTIC_TOKEN:token,PERP_METAL_DIAGNOSTIC_EXECUTABLE_ROOT:executableRoot,
    PERP_METAL_DIAGNOSTIC_MAX_BYTES:String(maxBytes),PERP_METAL_DIAGNOSTIC_MAX_RECORDS:String(maxRecords),PERP_METAL_DIAGNOSTIC_MAX_PROCESSES:String(maxProcesses)}}
}
function parseJournal(text,manifest,file) {
  const issues=[],commits=new Map(),completions=new Map(),rows=[]
  const bad=reason=>issues.push(reason)
  if(!text.endsWith('\n'))bad('partial-record')
  for(const line of (text.endsWith('\n')?text.slice(0,-1).split('\n'):text.split('\n'))) {try {rows.push(JSON.parse(line))}catch {bad('malformed-json')}}
  const loader=rows[0]
  if(loader?.kind!=='loader'||loader.schemaVersion!==1||loader.provider!=='metal-command-buffer'||loader.source!=='native'||loader.measurement!=='device-clock'
    ||loader.clock!=='metal-host-monotonic-seconds'||loader.token!==manifest.token||loader.uid!==manifest.uid||!bounded(loader.pid,1,Number.MAX_SAFE_INTEGER)||!time(loader.hostTime)
    ||loader.maxBytes!==manifest.maxBytes||loader.maxRecords!==manifest.maxRecords)bad('invalid-loader-handshake')
  if(rows.length>manifest.maxRecords)bad('record-cap-exceeded')
  let capability,close,limited=false,seenClose=false
  for(const row of rows.slice(1)) {
    if(!row||typeof row!=='object'||Array.isArray(row)){bad('invalid-record');continue}
    if(seenClose)bad('record-after-close')
    switch(row.kind) {
      case 'capability':
        if(capability||typeof row.enabled!=='boolean'||!time(row.hostTime)||row.enabled&&row.strategy!=='public-command-buffer-commit'||!row.enabled&&!['metal-device-unavailable','public-command-buffer-commit-unavailable','commit-hook-readback-failed','control-worker-unavailable','control-watch-unavailable'].includes(row.reason))bad('invalid-capability')
        capability=row;break
      case 'commit':
        if(!bounded(row.sequence,1,manifest.maxRecords)||commits.has(row.sequence)||!time(row.hostTime))bad('invalid-or-duplicate-commit')
        commits.set(row.sequence,row);break
      case 'complete':
        if(!bounded(row.sequence,1,manifest.maxRecords)||completions.has(row.sequence)||!time(row.commitHostTime)||!time(row.completedHostTime)||!time(row.gpuStartTime)||!time(row.gpuEndTime)
          ||row.completedHostTime<row.commitHostTime||row.gpuStartTime>0&&row.gpuEndTime>0&&(row.gpuStartTime<row.commitHostTime||row.gpuEndTime<row.gpuStartTime||row.gpuEndTime>row.completedHostTime)||!bounded(row.status,0,5)||!Number.isSafeInteger(row.errorCode)
          ||!['completion','observer-callback-install-failure'].includes(row.phase))bad('invalid-or-duplicate-completion')
        completions.set(row.sequence,row);break
      case 'limit':if(limited||!time(row.hostTime)||row.reason!=='record-or-byte-admission-cap')bad('invalid-limit');limited=true;break
      case 'close':if(close||!time(row.hostTime)||!time(row.admissionEndHostTime)||row.admissionEndHostTime>row.hostTime||!['process-exit','capture-window-stop','control-channel-failure'].includes(row.reason))bad('invalid-close');close=row;seenClose=true;break
      default:bad('unknown-record-kind')
    }
  }
  if(!capability)bad('missing-capability')
  for(const [sequence,end] of completions)if(!commits.has(sequence)||commits.get(sequence).hostTime!==end.commitHostTime)bad('unmatched-completion')
  if([...commits.keys()].some((sequence,index)=>sequence!==index+1))bad('non-contiguous-admission-sequence')
  for(const row of commits.values())if(row.hostTime<loader?.hostTime)bad('commit-before-loader')
  if(capability&&capability.hostTime<loader?.hostTime)bad('capability-before-loader')
  const pending=commits.size-completions.size
  if(pending<0)bad('negative-pending-count')
  const nativeErrors=[...completions.values()].filter(row=>row.status!==4||row.phase!=='completion').length
  if(close) {
    if(close.admissionEndHostTime<loader?.hostTime||capability?.hostTime>close.admissionEndHostTime||[...commits.values()].some(row=>row.hostTime>close.admissionEndHostTime)||[...completions.values()].some(row=>row.completedHostTime>close.hostTime))bad('records-outside-loader-close-window')
    for(const key of ['observedCommits','admittedCommits','completions','active','rejected','errors','observerErrors','writeFailures'])if(!integer(close[key]))bad('invalid-close-counter')
    if(close.admittedCommits!==commits.size||close.completions!==completions.size||close.active!==pending||close.observedCommits!==close.admittedCommits+close.rejected||close.errors!==nativeErrors)bad('close-counter-mismatch')
    if(close.rejected>0&&!limited)bad('unreported-admission-rejection')
    if(close.writeFailures||close.observerErrors)bad('observer-failure')
  } else bad('missing-close-acknowledgement')
  if(pending)bad('incomplete-command-buffers')
  const samples=[...completions.values()].map(row=>({category:'gpu',name:'metal.command-buffer',source:'native',measurement:'device-clock',clock:loader?.clock,pid:loader?.pid,sequence:row.sequence,
    status:row.status===4&&row.phase==='completion'?'ok':'error',nativeStatus:row.status,errorCode:row.errorCode,phase:row.phase,commitHostTime:row.commitHostTime,completedHostTime:row.completedHostTime,
    gpuStartTime:row.gpuStartTime,gpuEndTime:row.gpuEndTime,durationMS:row.gpuStartTime>0&&row.gpuEndTime>0?(row.gpuEndTime-row.gpuStartTime)*1000:null}))
  return {file,pid:loader?.pid,loaded:!issues.includes('invalid-loader-handshake'),enabled:capability?.enabled===true,reason:capability?.enabled===false?capability.reason:undefined,
    issues:[...new Set(issues)],closed:Boolean(close),closeReason:close?.reason,captureStartHostTime:loader?.hostTime,captureEndHostTime:close?.admissionEndHostTime,closedHostTime:close?.hostTime,limited,commitRecords:[...commits.values()],observedCommits:close?.observedCommits??null,admittedCommits:commits.size,completions:completions.size,pending,
    rejected:close?.rejected??null,nativeErrors,zeroTimingBuffers:samples.filter(row=>row.gpuStartTime===0||row.gpuEndTime===0).length,samples}
}
export async function collectMetalDiagnostic({directory,token,gpuPids,captureWindows=[],durable=true}={}) {
  const info=await lstat(directory)
  if(!info.isDirectory()||info.isSymbolicLink()||!privateInfo(info))throw new Error('private-directory-required')
  const manifest=JSON.parse(await safeRead(join(directory,'diagnostic.json'),16384))
  if(manifest.kind!==kind||manifest.schemaVersion!==1||manifest.token!==token||manifest.uid!==uid()||!/^[a-f0-9]{32}$/.test(token)
    ||!bounded(manifest.maxBytes,4096,16*1024*1024)||!bounded(manifest.maxRecords,8,65536)||!bounded(manifest.maxProcesses,1,32))throw new Error('invalid-diagnostic-manifest')
  if(!Array.isArray(gpuPids)||!gpuPids.length||gpuPids.some(pid=>!bounded(pid,1,Number.MAX_SAFE_INTEGER))||new Set(gpuPids).size!==gpuPids.length)throw new Error('actual-gpu-process-ids-required')
  if(!Array.isArray(captureWindows)||captureWindows.length>128||captureWindows.some(window=>typeof window.name!=='string'||window.name.length>96||!time(window.startHostTime)||!time(window.endHostTime)||window.endHostTime<=window.startHostTime))throw new Error('invalid-metal-clock-capture-window')
  const processes=[],issues=[],names=await readdir(directory)
  for(const name of names) {
    if(name==='diagnostic.json')continue
    if(name==='stop.request'){try {const value=await safeRead(join(directory,name),33);if(value!==''&&value!==token+'\n')issues.push('invalid-stop-request')}catch(error){issues.push(error.message)}continue}
    const slot=/^metal-slot-(\d+)\.jsonl$/.exec(name)
    if(!slot||Number(slot[1])>=manifest.maxProcesses){issues.push('unknown-diagnostic-artifact');continue}
    try {
      const path=join(directory,name),text=await safeRead(path,manifest.maxBytes)
      // The provider uses direct bounded writes. The caller durably flushes the captured prefix after its owned subprocess exits.
      if(durable) {const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try {await file.sync()}finally{await file.close()}}
      processes.push(parseJournal(text,manifest,name))
    } catch(error) {issues.push(error.message)}
  }
  if(processes.length>manifest.maxProcesses)issues.push('process-cap-exceeded')
  if(new Set(processes.map(process=>process.pid)).size!==processes.length)issues.push('duplicate-process-handshake')
  const targets=gpuPids.map(pid=>processes.find(process=>process.pid===pid))
  const loaded=targets.every(process=>process?.loaded),enabled=loaded&&targets.every(process=>process.enabled)
  const admissions=targets.flatMap(process=>process?.commitRecords.map(row=>({pid:process.pid,sequence:row.sequence,commitHostTime:row.hostTime}))??[])
  const samples=targets.flatMap(process=>process?.samples??[]),positive=samples.filter(sample=>sample.gpuStartTime>0&&sample.gpuEndTime>sample.gpuStartTime)
  const complete=enabled&&!issues.length&&targets.every(process=>!process.issues.length&&!process.limited)
  const integrityIssues=new Set(['missing-close-acknowledgement','incomplete-command-buffers'])
  const trusted=enabled&&!issues.length&&targets.every(process=>process.issues.every(issue=>integrityIssues.has(issue)))
  const successful=positive.filter(sample=>sample.status==='ok')
  const supported=trusted&&successful.length>0
  const windows=captureWindows.map(window=>{
    const overlaps=positive.filter(sample=>sample.gpuStartTime<window.endHostTime&&sample.gpuEndTime>window.startHostTime)
    const inWindow=value=>value.commitHostTime>=window.startHostTime&&value.commitHostTime<window.endHostTime
    const committed=admissions.filter(inWindow).length,finished=samples.filter(inWindow)
    return {...window,measurement:'device-clock-temporal-overlap',committed,completed:finished.length,pending:committed-finished.length,nativeErrors:finished.filter(sample=>sample.status==='error').length,zeroTimingBuffers:finished.filter(sample=>sample.gpuStartTime===0||sample.gpuEndTime===0).length,
      overlappingBuffers:overlaps.length,summedBufferOverlapMS:overlaps.reduce((sum,sample)=>sum+Math.max(0,Math.min(sample.gpuEndTime,window.endHostTime)-Math.max(sample.gpuStartTime,window.startHostTime))*1000,0)}
  })
  return {schemaVersion:1,provider:'metal-command-buffer',source:'native',measurement:'device-clock',clock:'metal-host-monotonic-seconds',scope:'observed-default-device-command-buffer-class',
    capability:{supported,loaded,enabled,complete,reason:!loaded?'actual-gpu-loader-handshake-missing':!enabled?'metal-hook-unavailable':!successful.length?'no-successful-device-timing':complete?'observed':'observer-incomplete-or-limited'},
    issues:[...new Set(issues)],actualGpuPids:gpuPids,processes:processes.map(({samples,commitRecords,...process})=>process),admissions,samples,windows,
    limits:{maxProcesses:manifest.maxProcesses,maxBytesPerProcess:manifest.maxBytes,maxRecordsPerProcess:manifest.maxRecords,maxTotalJournalBytes:manifest.maxBytes*manifest.maxProcesses},
    stats:{pending:targets.reduce((sum,process)=>sum+(process?.pending??0),0),nativeErrors:targets.reduce((sum,process)=>sum+(process?.nativeErrors??0),0),admittedCommits:targets.reduce((sum,process)=>sum+(process?.admittedCommits??0),0),completions:samples.length,positiveTimings:positive.length,
      successfulDeviceTimings:successful.length,failedDeviceTimings:positive.length-successful.length,unavailableTimingBuffers:samples.filter(sample=>sample.gpuStartTime===0||sample.gpuEndTime===0).length,zeroDurationBuffers:samples.filter(sample=>sample.gpuStartTime>0&&sample.gpuStartTime===sample.gpuEndTime).length,observedCommits:targets.every(process=>process&&process.observedCommits!==null)?targets.reduce((sum,process)=>sum+process.observedCommits,0):null,
      zeroTimingBuffers:samples.length-positive.length,summedBufferDurationMS:positive.reduce((sum,sample)=>sum+sample.durationMS,0)},
    caveats:['Summed overlapping buffer durations are not unique GPU busy time or utilization.','No per-kernel, per-SVG or JavaScript causal attribution.','Raw Metal monotonic host seconds are not epoch timestamps.','A single observed command-buffer class does not prove all Metal APIs/devices are covered.']}
}

export async function stopMetalDiagnostic({directory,token,gpuPids,timeoutMS=5000,captureWindows=[]}={}) {
  if(!bounded(timeoutMS,1,30000))throw new Error('invalid-stop-timeout')
  // Validate ownership/token/targets before touching the shared vnode. The inode is kept stable for kqueue.
  await collectMetalDiagnostic({directory,token,gpuPids,durable:false})
  const path=join(directory,'stop.request'),before=await lstat(path)
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||!privateInfo(before))throw new Error('unsafe-stop-request')
  const file=await open(path,constants.O_WRONLY|constants.O_NOFOLLOW)
  try {
    const current=await file.stat()
    if(current.ino!==before.ino||current.dev!==before.dev)throw new Error('stop-request-identity-changed')
    await file.writeFile(token+'\n');await file.truncate(33);await file.sync()
  } finally {await file.close()}
  const deadline=Date.now()+timeoutMS
  let report
  do {
    report=await collectMetalDiagnostic({directory,token,gpuPids,captureWindows})
    if(!report.issues.length&&gpuPids.every(pid=>report.processes.some(process=>process.pid===pid&&process.closed)))return report
    if(Date.now()>=deadline)break
    await new Promise(resolve=>setTimeout(resolve,20))
  } while(true)
  return {...report,capability:{...report.capability,complete:false,reason:'capture-window-stop-unacknowledged'},issues:[...new Set([...report.issues,'capture-window-stop-timeout'])]}
}
