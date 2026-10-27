const { contextBridge, ipcRenderer } = require('electron')

let operationHooks
const pendingNotifications = []
const operationNonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')
for (const channel of ['radar:gateway-stream', 'radar:chart-prepared', 'radar:market-changed', 'radar:audit-changed', 'radar:history-download-changed']) {
  ipcRenderer.on(channel, (_event, detail, context) => {
    if (operationHooks) operationHooks.receive(channel, detail, context)
    else pendingNotifications.push([channel, detail, context])
  })
}
ipcRenderer.on('radar:operations-drain', async (_event, { id }) => {
  try {
    if (!operationHooks) throw new Error('Renderer recording is not initialized.')
    await operationHooks.flush()
    ipcRenderer.send('radar:operations-drained', { id, ok: true })
  } catch { ipcRenderer.send('radar:operations-drained', { id, ok: false }) }
})
window.addEventListener('pagehide', () => { if (operationHooks) void operationHooks.flush().catch(() => {}) })
const transport = {
  nativeWindowControls: process.platform === 'darwin',
  request: (value, context) => ipcRenderer.invoke('radar:request', value, context),
  initializeOperations: hooks => {
    operationHooks = hooks
    for (const [channel, detail, context] of pendingNotifications.splice(0)) hooks.receive(channel, detail, context)
    return ipcRenderer.invoke('radar:operations-initialize', { nonce: operationNonce })
  },
  recordOperations: batch => ipcRenderer.invoke('radar:operations', batch),
  operationSourceFailure: value => ipcRenderer.invoke('radar:operations-failure', value),
}
// Hand the transport to the application once through the stable bridge API.
// Bulk values remain strings when the resulting function proxies are called.
let connected = false
contextBridge.exposeInMainWorld('radarDesktopBootstrap', {
  connect: accept => {
    if (connected || typeof accept !== 'function') throw new Error('The desktop transport is already connected or the receiver is invalid.')
    connected = true
    accept(transport)
  },
})
