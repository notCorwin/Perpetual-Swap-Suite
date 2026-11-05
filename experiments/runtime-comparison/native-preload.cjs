const { contextBridge, ipcRenderer } = require('electron')

let callback
ipcRenderer.on('comparison-native:event', (_event, payload) => { if (callback) callback(payload) })
contextBridge.exposeInMainWorld('__comparisonNative', {
  request: (path, payloadJSON) => ipcRenderer.invoke('comparison-native:request', path, payloadJSON),
  subscribe: async listener => {
    if (typeof listener !== 'function') throw new Error('Native comparison subscriber must be a function.')
    if (callback) throw new Error('Native comparison events are already subscribed.')
    callback = listener
    try { await ipcRenderer.invoke('comparison-native:subscribe') } catch (error) { callback = undefined; throw error }
  },
  close: async () => { await ipcRenderer.invoke('comparison-native:close'); callback = undefined },
})
