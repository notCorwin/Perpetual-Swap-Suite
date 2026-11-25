const { contextBridge, ipcRenderer } = require('electron')

const pendingNotifications = []
let notificationReceiver, presentationReceiver
let pendingPreferences
const isSettingsWindow = process.argv.includes('--perpetual-swap-settings-window')
let settingsCloseGuard = { dirty: false, busy: false }
ipcRenderer.on('radar:settings-query-close', (_event, value) => {
  if (isSettingsWindow && typeof value?.id === 'string') ipcRenderer.send('radar:settings-close-state', { id: value.id, ...settingsCloseGuard })
})
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
const receive = (channel, detail, epoch) => {
  if (!presentation.active || typeof epoch === 'number' && epoch < presentation.epoch) return
  if (notificationReceiver) notificationReceiver(channel, detail)
  else pendingNotifications.push([channel, detail, epoch])
}
for (const channel of ['radar:chart-prepared', 'radar:market-changed', 'radar:audit-changed', 'radar:history-download-changed']) {
  ipcRenderer.on(channel, (_event, detail, epoch) => receive(channel, detail, epoch))
}
ipcRenderer.on('radar:preferences-changed', (_event, detail) => {
  if (notificationReceiver) notificationReceiver('radar:preferences-changed', detail)
  else pendingPreferences = detail
})
const transport = {
  nativeWindowControls: process.platform === 'darwin',
  isSettingsWindow,
  setSettingsCloseGuard: value => { if (!isSettingsWindow) throw new Error('Not a settings window.'); settingsCloseGuard = { dirty: value.dirty, busy: value.busy }; ipcRenderer.send('radar:settings-close-guard', settingsCloseGuard) },
  closeSettingsWindow: () => { if (!isSettingsWindow) throw new Error('Not a settings window.'); return ipcRenderer.invoke('radar:settings-close') },
  request: value => ipcRenderer.invoke('radar:request', value),
  subscribeNotifications: receiver => {
    if (notificationReceiver || typeof receiver !== 'function') throw new Error('The notification receiver is already subscribed or invalid.')
    notificationReceiver = receiver
    if (pendingPreferences !== undefined) { receiver('radar:preferences-changed', pendingPreferences); pendingPreferences = undefined }
    for (const [channel, detail, epoch] of pendingNotifications.splice(0)) {
      if (presentation.active && (typeof epoch !== 'number' || epoch >= presentation.epoch)) receiver(channel, detail)
    }
  },
  subscribePresentation: receiver => {
    if (presentationReceiver || typeof receiver !== 'function') throw new Error('The presentation receiver is already subscribed or invalid.')
    presentationReceiver = receiver
    try { receiver(presentation) }
    finally { const { snapshot: _snapshot, ...state } = presentation; presentation = state }
  },
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
