const { contextBridge, ipcRenderer } = require('electron')

const operationRecording = process.argv.includes('--perpetual-swap-operation-recording')
const pendingNotifications = []
let notificationReceiver, presentationReceiver, flushOperations
let presentation = { epoch: 0, active: !process.argv.includes('--perpetual-swap-presentation-idle'), startedAt: 0 }
let presentationEvents = 0
const updatePresentation = value => {
  if (!value || !Number.isSafeInteger(value.epoch) || value.epoch < presentation.epoch || typeof value.active !== 'boolean') return
  presentation = value
  if (!value.active) pendingNotifications.length = 0
  if (presentationReceiver) {
    try { presentationReceiver(value) }
    finally { const { snapshot: _snapshot, ...state } = value; presentation = state }
  }
}
ipcRenderer.on('radar:presentation', (_event, value) => { presentationEvents++; updatePresentation(value) })
// An IPC transition can overtake this response. In that case the event is the
// newer authority, even when both describe different phases of the same epoch.
ipcRenderer.invoke('radar:presentation-state').then(value => {
  if (!presentationEvents) updatePresentation(value)
}).catch(() => {})
const receive = operationRecording
  ? (channel, detail, context, epoch) => {
    if (!presentation.active || typeof epoch === 'number' && epoch < presentation.epoch) return
    if (notificationReceiver) notificationReceiver(channel, detail, context, epoch)
    else pendingNotifications.push([channel, detail, context, epoch])
  }
  : (channel, detail, _context, epoch) => {
    if (!presentation.active || typeof epoch === 'number' && epoch < presentation.epoch) return
    if (notificationReceiver) notificationReceiver(channel, detail)
    else pendingNotifications.push([channel, detail, undefined, epoch])
  }
for (const channel of ['radar:gateway-stream', 'radar:chart-prepared', 'radar:market-changed', 'radar:audit-changed', 'radar:history-download-changed']) {
  ipcRenderer.on(channel, (_event, detail, context, epoch) => receive(channel, detail, context, epoch))
}
if (operationRecording) {
  ipcRenderer.on('radar:operations-drain', async (_event, { id }) => {
    try {
      if (!flushOperations) throw new Error('Renderer recording is not initialized.')
      await flushOperations()
      ipcRenderer.send('radar:operations-drained', { id, ok: true })
    } catch { ipcRenderer.send('radar:operations-drained', { id, ok: false }) }
  })
  window.addEventListener('pagehide', () => { if (flushOperations) void flushOperations().catch(() => {}) })
}
const requireRecording = () => {
  if (!operationRecording) throw new Error('Operation recording is disabled for this renderer.')
}
const transport = {
  nativeWindowControls: process.platform === 'darwin',
  operationRecording,
  request: operationRecording
    ? (value, context) => ipcRenderer.invoke('radar:request', value, context)
    : value => ipcRenderer.invoke('radar:request', value),
  subscribeNotifications: receiver => {
    if (notificationReceiver || typeof receiver !== 'function') throw new Error('The notification receiver is already subscribed or invalid.')
    notificationReceiver = receiver
    for (const notification of pendingNotifications.splice(0)) {
      if (presentation.active && (typeof notification[3] !== 'number' || notification[3] >= presentation.epoch)) receiver(...notification)
    }
  },
  subscribePresentation: receiver => {
    if (presentationReceiver || typeof receiver !== 'function') throw new Error('The presentation receiver is already subscribed or invalid.')
    presentationReceiver = receiver
    try { receiver(presentation) }
    finally { const { snapshot: _snapshot, ...state } = presentation; presentation = state }
  },
  initializeOperations: flush => {
    requireRecording()
    if (flushOperations || typeof flush !== 'function') throw new Error('Renderer recording is already initialized or its drain is invalid.')
    flushOperations = flush
    const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')
    return ipcRenderer.invoke('radar:operations-initialize', { nonce })
  },
  recordOperations: batch => { requireRecording(); return ipcRenderer.invoke('radar:operations', batch) },
  operationSourceFailure: value => { requireRecording(); return ipcRenderer.invoke('radar:operations-failure', value) },
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
