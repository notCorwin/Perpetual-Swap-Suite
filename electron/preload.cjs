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
// Hand the private transport to the application world once. The application
// installs the sole public desktop API there, so bulk strings are parsed there.
contextBridge.executeInMainWorld({
  func: bridge => {
    const connect = event => {
      if (typeof event.detail !== 'function') return
      window.removeEventListener('radar-desktop-connect', connect)
      event.detail(bridge)
    }
    window.addEventListener('radar-desktop-connect', connect)
  },
  args: [transport],
})
