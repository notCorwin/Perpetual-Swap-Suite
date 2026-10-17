const { contextBridge, ipcRenderer } = require('electron')

const request = value => ipcRenderer.invoke('radar:request', value)
ipcRenderer.on('radar:gateway-stream', (_event, detail) => {
  window.dispatchEvent(new CustomEvent('radar-gateway-stream', { detail }))
})
ipcRenderer.on('radar:chart-prepared', (_event, detail) => {
  window.dispatchEvent(new CustomEvent('radar-chart-prepared', { detail }))
})
contextBridge.exposeInMainWorld('radarDesktop', { request })
