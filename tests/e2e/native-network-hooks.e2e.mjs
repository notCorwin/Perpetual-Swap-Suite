import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { registerOperationParticipant } from '../../electron/services/operation-runtime.js'

test('real Electron after-ready hooks cover Chromium fetch/session/request/resolver and native WebSocket without windows', { timeout:20000 }, async () => {
  const executable=fileURLToPath(new URL('../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',import.meta.url))
  const fixture=fileURLToPath(new URL('../helpers/electron-network-hooks.mjs',import.meta.url))
  const participant=registerOperationParticipant('electron-network-fixture')
  const env={...process.env,...participant.env,PERPETUAL_SWAP_SANDBOX:'1',PERPETUAL_SWAP_ALLOW_NETWORK:'0'}
  delete env.ELECTRON_RUN_AS_NODE
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(executable,[fixture],{env,stdio:['ignore','pipe','pipe']})
    let stdout='',stderr=''
    const deadline=setTimeout(()=>{child.kill();reject(new Error(`Electron native fixture timed out: ${stderr}\nstdout: ${stdout}`))},15000)
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-24000))
    child.once('error',error=>{clearTimeout(deadline);reject(error)})
    child.once('close',code=>{clearTimeout(deadline);if(code!==0){reject(new Error(`Electron native fixture failed (${code}): ${stderr}`));return}try{resolve(JSON.parse(stdout))}catch(error){reject(new Error(`${error.message}: ${stdout} ${stderr}`))}})
  })
  assert.equal(result.passed,true);assert.equal(result.visibleWindows,0)
  assert.equal(result.cleanupComplete,true)
  assert.ok(result.connectionsBeforeClose>=1,'Shutdown must close the accepted socket without an HTTP request.')
  assert.equal(result.phases.at(-1),'complete')
  for(const api of ['electron.net.fetch','electron.net.request','electron.net.resolveHost','electron.session.fetch','electron.session.resolveHost','electron.net.WebSocket'])assert.equal(result.capabilities.find(entry=>entry.api===api)?.enabled,true,api)
  assert.ok(result.names.includes('websocket.receive'))
})
