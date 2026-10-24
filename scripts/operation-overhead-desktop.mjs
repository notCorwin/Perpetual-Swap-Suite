import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(process.env.PERPETUAL_SWAP_OVERHEAD_ROOT ?? new URL('../', import.meta.url).pathname)
const { createRendererOperationReceiver } = await import(pathToFileURL(join(root, 'electron/services/renderer-operations.js')).href)
const { closeOperationRecording, flushOperationRecording } = await import(pathToFileURL(join(root, 'electron/services/operation-runtime.js')).href)
const config = JSON.parse(process.argv.at(-1))
await mkdir(join(config.directory, 'profile'), { recursive: true }); app.setPath('userData', join(config.directory, 'profile'))
if (process.platform === 'darwin') app.setActivationPolicy('accessory')
const receiver = createRendererOperationReceiver(), latency = []
let measuredCPU, measuredStart
ipcMain.handle('overhead:start', () => { measuredCPU = process.cpuUsage(); measuredStart = performance.now() })
ipcMain.handle('overhead:initialize', () => receiver.initialize(1, 'benchmark-source'))
ipcMain.handle('overhead:batch', async (_event, batch) => {
  const started = performance.now(), result = await receiver.receive(1, batch)
  latency.push({ durationMS: performance.now() - started, size: batch.events.length }); return result
})
ipcMain.handle('overhead:failure', (_event, value) => receiver.fail(1, value))
const paths = ['src/operation-telemetry.ts', 'src/chart-geometry.ts', 'src/chart-axis.ts', 'src/chart-layout.ts', 'src/market-percent.ts', 'electron/services/operations.js']
const modules = new Map(await Promise.all(paths.map(async path => {
  const source = await readFile(join(root, path), 'utf8')
  return [`/${path}`, path.endsWith('.ts') ? stripTypeScriptTypes(source, { mode: 'strip' }) : source]
})))
const source = `
import { initializeOperationTelemetry } from '/src/operation-telemetry.ts';
import { createChartGeometryCache } from '/src/chart-geometry.ts';
const config = ${JSON.stringify(config)};
let flushWarmup = async () => {}; const acknowledgmentLatencies = [];
const close = window.overhead.enabled ? await initializeOperationTelemetry({ initialize: () => window.overhead.initialize(),
 recordOperations: async batch => { const started=performance.now();const result=await window.overhead.recordOperations(batch);acknowledgmentLatencies.push({durationMS:performance.now()-started,size:batch.events.length});return result; }, reportFailure: value => window.overhead.reportFailure(value),
 timeOrigin: performance.timeOrigin, schedule: (fn, ms) => setTimeout(fn, ms), cancel: handle => clearTimeout(handle),
 onFlush: callback => {flushWarmup=callback;return () => {};} }) : async () => {};
const bars = Array.from({length:96}, (_, index) => ({hour:1700000100000+index*300000,open:100,high:102,low:98,close:100+index/100,ema:100,vwap:100,
 bollUpper:102,bollMiddle:100,bollLower:98,roc:1,maroc:1,rsi6:50,rsi12:50,rsi24:50,atrPercent:2,bbw:4,oi:1000,buy:70,sell:30,confirmed:true}));
const geometry = createChartGeometryCache(text => text.length*7), path = document.querySelector('path');
const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve,0));
const render = index => { const value=geometry(bars,{width:960+(index%3),height:720,endHour:bars.at(-1).hour,intervalMS:300000,liveClose:100+index/10000});
 path.setAttribute('d',value.upBodies+value.downBodies); return value.upBodies.length+value.downBodies.length; };
for(let index=0;index<config.warmup*32;index++)render(index);
await flushWarmup();acknowledgmentLatencies.length=0;await yieldToBrowser();
await window.overhead.start();
const before=window.overhead.resources(), started=performance.now(); let checksum=0;
const heartbeat=[]; let previous=started;
const timer=setInterval(()=>{const now=performance.now();heartbeat.push(Math.max(0,now-previous-4));previous=now;},4);
for(let index=0;index<config.cycles*32;index++){checksum+=render(index+10000);if(index%8===7)await yieldToBrowser();}
const produced=performance.now(), after=window.overhead.resources();clearInterval(timer);
await close();const drained=performance.now();
const end=window.overhead.resources();
window.overheadResult={business:{checksum,frames:config.cycles*32},metrics:{renderer:{startedAt:performance.timeOrigin+started,endedAt:performance.timeOrigin+produced,wallMS:produced-started,
 cpuMS:(after.cpu.user-before.cpu.user+after.cpu.system-before.cpu.system)/1000,
 rssDeltaBytes:after.memory.rss-before.memory.rss,peakRSSBytes:Math.max(before.memory.rss,after.memory.rss),peakHeapBytes:Math.max(before.memory.heapUsed,after.memory.heapUsed),
 eventLoopP99MS:heartbeat.sort((a,b)=>a-b)[Math.min(heartbeat.length-1,Math.floor(heartbeat.length*.99))]??0,eventLoopMaxMS:Math.max(0,...heartbeat)},
 rendererDrain:{wallMS:drained-produced,cpuMS:(end.cpu.user-after.cpu.user+end.cpu.system-after.cpu.system)/1000}},
 acknowledgmentLatencies,parameters:{realRenderer:true,transport:'Electron contextBridge + ipcRenderer.invoke',frames:config.cycles*32,warmupFrames:config.warmup*32}};
`
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<svg width="960" height="720"><path/></svg><script type="module" src="/benchmark.js"></script>'); return }
  const value = url.pathname === '/benchmark.js' ? source : modules.get(url.pathname)
  if (value === undefined) { response.writeHead(404).end(); return }
  response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(value)
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
let window
async function run() {
try {
  await app.whenReady()
  window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { preload: new URL('./operation-overhead-preload.mjs', import.meta.url).pathname,
    sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.on('preload-error', (_event, path, error) => console.error('preload', path, error));
  window.webContents.on('console-message', event => { if (event.message?.includes('Error')) console.error(event.message) })
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`)
  const until = performance.now()+30000
  let result
  do {
    result = await window.webContents.executeJavaScript('window.overheadResult')
    if (result) break
    if(performance.now()>until)throw new Error('Renderer overhead benchmark did not complete.')
    await new Promise(resolve=>setTimeout(resolve,10))
  }while(true)
  await flushOperationRecording(); await closeOperationRecording()
  const mainCPU = process.cpuUsage(measuredCPU), mainCpuMS = (mainCPU.user + mainCPU.system) / 1000
  result.metrics.rendererEndToEnd = { startedAt: performance.timeOrigin + measuredStart, endedAt: performance.timeOrigin + performance.now(), wallMS: performance.now() - measuredStart, cpuMS: result.metrics.renderer.cpuMS + result.metrics.rendererDrain.cpuMS + mainCpuMS, mainCpuMS,
    peakRSSBytes: result.metrics.renderer.peakRSSBytes, peakHeapBytes: result.metrics.renderer.peakHeapBytes }
  console.log(JSON.stringify({...result, runtime:{mode:'electron-main-and-renderer',node:process.version,v8:process.versions.v8,electron:process.versions.electron,executable:process.execPath},
    receiver:{batches:result.acknowledgmentLatencies.length,latencies:result.acknowledgmentLatencies,durableLatencies:latency}}))
} finally {
  window?.destroy(); await new Promise(resolve => server.close(resolve)); app.quit()
}

}
void run().catch(error => { console.error(error.stack ?? error); app.exit(1) })
