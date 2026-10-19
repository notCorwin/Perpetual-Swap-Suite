const { contextBridge, ipcRenderer } = require('electron')

let operationHooks
const operationNonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')
const request = value => {
  const operation = operationHooks?.beginRequest(Object.keys(value ?? {})[0] ?? 'invalid')
  return ipcRenderer.invoke('radar:request', value, operation?.context).then(result => {
    if (operation) operationHooks.endRequest(operation.id, 'ok')
    return result
  }, error => {
    if (operation) operationHooks.endRequest(operation.id, 'error')
    throw error
  })
}
for (const channel of ['radar:gateway-stream', 'radar:chart-prepared', 'radar:market-changed', 'radar:audit-changed', 'radar:history-download-changed']) {
  ipcRenderer.on(channel, (_event, detail, context) => {
    if (operationHooks) operationHooks.receive(channel, detail, context)
    else window.dispatchEvent(new CustomEvent(channel.replace(':', '-'), { detail }))
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
contextBridge.exposeInMainWorld('radarDesktop', {
  request,
  initializeOperations: hooks => { operationHooks = hooks; return ipcRenderer.invoke('radar:operations-initialize', { nonce: operationNonce }) },
  recordOperations: batch => ipcRenderer.invoke('radar:operations', batch),
  operationSourceFailure: value => ipcRenderer.invoke('radar:operations-failure', value),
})
