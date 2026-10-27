import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('overhead', {
  enabled: process.env.PERPETUAL_SWAP_OVERHEAD_ENABLED === '1',
  start: () => ipcRenderer.invoke('overhead:start'),
  initialize: () => ipcRenderer.invoke('overhead:initialize'),
  recordOperations: batch => ipcRenderer.invoke('overhead:batch', batch),
  reportFailure: value => ipcRenderer.invoke('overhead:failure', value),
  resources: () => ({ cpu: process.cpuUsage(), memory: process.memoryUsage() }),
})
