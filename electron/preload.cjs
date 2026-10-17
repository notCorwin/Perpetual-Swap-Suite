const { contextBridge, ipcRenderer } = require('electron')

const request = value => ipcRenderer.invoke('radar:request', value)
ipcRenderer.on('radar:gateway-stream', (_event, detail) => {
  window.dispatchEvent(new CustomEvent('radar-gateway-stream', { detail }))
})
ipcRenderer.on('radar:chart-prepared', (_event, detail) => {
  window.dispatchEvent(new CustomEvent('radar-chart-prepared', { detail }))
})
// Preserve the existing renderer contract while keeping ipcRenderer out of
// the untrusted page context. New renderer code should use window.radarDesktop.
contextBridge.exposeInMainWorld('radarDesktop', { request })
contextBridge.exposeInMainWorld('webkit', { messageHandlers: { radar: { postMessage: request } } })
