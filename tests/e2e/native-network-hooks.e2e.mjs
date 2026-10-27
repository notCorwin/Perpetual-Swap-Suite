import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { registerOperationParticipant } from '../../electron/services/operation-runtime.js'

test('real Electron after-ready hooks cover Chromium fetch/session/request/resolver and native WebSocket without windows', { timeout:20000 }, async () => {
  const executable=createRequire(import.meta.url)('electron')
  const fixture=fileURLToPath(new URL('../helpers/electron-network-hooks.mjs',import.meta.url))
  // Chromium owns its profile until the actual child and its stdio close.
  // Deleting it inside the running fixture races network-service writes.
  const userData=await mkdtemp(join(tmpdir(),'perp-electron-net-proof-'))
  let child,closed=Promise.resolve(),closeObserved=false
  try {
    const participant=registerOperationParticipant('electron-network-fixture')
    const env={...process.env,...participant.env,PERPETUAL_SWAP_SANDBOX:'1',PERPETUAL_SWAP_ALLOW_NETWORK:'0',PERPETUAL_SWAP_NATIVE_NETWORK_USER_DATA:userData}
    delete env.ELECTRON_RUN_AS_NODE
    const result=await new Promise((resolve,reject)=>{
      child=spawn(executable,[fixture],{env,stdio:['ignore','pipe','pipe']})
      let stdout='',stderr='',failure
      const deadline=setTimeout(()=>{failure??=new Error(`Electron native fixture timed out: ${stderr}\nstdout: ${stdout}`);child.kill('SIGKILL')},15000)
      child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-24000))
      child.once('error',error=>{failure??=error})
      closed=new Promise(resolveClosed=>child.once('close',(code,signal)=>{
        closeObserved=true;clearTimeout(deadline);resolveClosed()
        if(failure){reject(failure);return}
        if(code!==0||signal){reject(new Error(`Electron native fixture failed (${code}, ${signal??'no signal'}): ${stderr}`));return}
        try{resolve(JSON.parse(stdout))}catch(error){reject(new Error(`${error.message}: ${stdout} ${stderr}`))}
      }))
    })
    assert.equal(closeObserved,true,'A completed result must wait for the actual child close event.')
    assert.equal(result.passed,true);assert.equal(result.visibleWindows,0)
    assert.equal(result.cleanupComplete,true)
    assert.equal(result.profilePresentBeforeQuit,true,'The profile must remain present while Electron is alive.')
    assert.ok(result.connectionsBeforeClose>=1,'Shutdown must close the accepted socket without an HTTP request.')
    assert.deepEqual(result.phases.slice(-5),['cleanup-exchange','cleanup-http','cleanup-recorder','profile-retained-before-quit','complete'])
    for(const api of ['electron.net.fetch','electron.net.request','electron.net.resolveHost','electron.session.fetch','electron.session.resolveHost','electron.net.WebSocket'])assert.equal(result.capabilities.find(entry=>entry.api===api)?.enabled,true,api)
    assert.ok(result.names.includes('websocket.receive'))
  } finally {
    if(child&&!closeObserved)child.kill('SIGKILL')
    await closed
    await rm(userData,{recursive:true,force:true})
  }
  await assert.rejects(stat(userData),error=>error.code==='ENOENT','The parent removes the profile only after Electron has closed.')
})
